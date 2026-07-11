#!/usr/bin/env node
/** Aggregate-only Codex transcript audit for GPT model families. Never emits prompts. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const value = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const roots = argv.filter((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1]?.startsWith('--')));
const scanRoots = roots.length > 0
  ? roots
  : [path.join(os.homedir(), '.codex', 'sessions'), path.join(os.homedir(), '.codex', 'archived_sessions')];
const before = value('--before');
const excludeContaining = value('--exclude-containing');
const jsonOut = argv.includes('--json');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.isFile() && p.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function family(model) {
  const m = model ?? '';
  if (m === 'gpt-5.5' || m.startsWith('gpt-5.5-')) return 'gpt-5.5';
  if (m === 'gpt-5.6' || m.startsWith('gpt-5.6-')) return 'gpt-5.6';
  return undefined;
}

const filesByName = new Map();
for (const p of scanRoots.flatMap(walk)) {
  const name = path.basename(p);
  const prior = filesByName.get(name);
  if (!prior || p.includes('/sessions/')) filesByName.set(name, p);
}

const calls = [];
const sessions = new Map();
for (const file of filesByName.values()) {
  const raw = fs.readFileSync(file, 'utf8');
  if (excludeContaining && raw.includes(excludeContaining)) continue;
  let model;
  let effort;
  let turnId;
  let lastVector;
  const sessionCalls = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (before && row.timestamp >= before) continue;
    const payload = row.payload ?? {};
    if (row.type === 'turn_context') {
      model = payload.model ?? payload.collaboration_mode?.settings?.model ?? model;
      effort = payload.effort ?? payload.collaboration_mode?.settings?.reasoning_effort ?? effort;
      turnId = payload.turn_id ?? turnId;
      continue;
    }
    if (row.type !== 'event_msg' || payload.type !== 'token_count') continue;
    const f = family(model);
    const total = payload.info?.total_token_usage;
    const last = payload.info?.last_token_usage;
    if (!f || !total || !last) continue;
    const vector = JSON.stringify(total);
    if (vector === lastVector) continue;
    lastVector = vector;
    const input = Number(last.input_tokens ?? 0);
    const cached = Math.min(input, Number(last.cached_input_tokens ?? 0));
    const output = Number(last.output_tokens ?? 0);
    const call = {
      family: f,
      model,
      effort: effort ?? 'unknown',
      turnId: turnId ?? '<unknown>',
      session: path.basename(file, '.jsonl'),
      timestamp: row.timestamp,
      input,
      cached,
      uncached: input - cached,
      output,
      reasoning: Number(last.reasoning_output_tokens ?? 0),
      total: Number(last.total_tokens ?? input + output),
      limitId: payload.rate_limits?.limit_id,
      primaryPercent: payload.rate_limits?.primary?.used_percent,
      primaryReset: payload.rate_limits?.primary?.resets_at,
    };
    calls.push(call);
    sessionCalls.push(call);
  }
  if (sessionCalls.length) sessions.set(file, sessionCalls);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.round((sorted.length - 1) * p)] ?? 0;
}

function aggregate(rows) {
  const input = rows.reduce((n, r) => n + r.input, 0);
  const cached = rows.reduce((n, r) => n + r.cached, 0);
  const turns = new Set(rows.map((r) => `${r.session}:${r.turnId}`));
  return {
    sessions: new Set(rows.map((r) => r.session)).size,
    turns: turns.size,
    calls: rows.length,
    input,
    cached,
    cachedPct: input ? cached / input * 100 : 0,
    uncached: input - cached,
    output: rows.reduce((n, r) => n + r.output, 0),
    reasoning: rows.reduce((n, r) => n + r.reasoning, 0),
    inputPerCallMedian: percentile(rows.map((r) => r.input), 0.5),
    inputPerCallP90: percentile(rows.map((r) => r.input), 0.9),
    callsPerTurnMean: turns.size ? rows.length / turns.size : 0,
  };
}

const report = { scannedFiles: filesByName.size, includedCalls: calls.length, families: {}, variants: {}, planCohort: {}, byEffort: {}, quotaWindows: {}, topSessions: [] };
for (const f of ['gpt-5.5', 'gpt-5.6']) {
  report.families[f] = aggregate(calls.filter((r) => r.family === f));
  report.planCohort[f] = aggregate(calls.filter((r) => r.family === f && r.limitId === 'codex'));
  report.byEffort[f] = Object.fromEntries(
    [...new Set(calls.filter((r) => r.family === f).map((r) => r.effort))]
      .sort().map((e) => [e, aggregate(calls.filter((r) => r.family === f && r.effort === e))]),
  );
  const windows = new Map();
  for (const call of calls.filter((r) => r.family === f && r.limitId === 'codex' && r.primaryReset && Number.isFinite(r.primaryPercent))) {
    const w = windows.get(call.primaryReset) ?? { percents: [], input: 0, calls: 0 };
    w.percents.push(call.primaryPercent);
    w.input += call.input;
    w.calls++;
    windows.set(call.primaryReset, w);
  }
  report.quotaWindows[f] = [...windows.entries()].map(([reset, w]) => {
    const delta = Math.max(...w.percents) - Math.min(...w.percents);
    return { reset, calls: w.calls, percentDelta: delta, grossInputPerPoint: delta > 0 ? w.input / delta : null };
  }).filter((w) => w.calls >= 10 && w.percentDelta > 0);
}
report.variants = Object.fromEntries(
  [...new Set(calls.map((r) => r.model))].sort()
    .map((model) => [model, aggregate(calls.filter((r) => r.model === model))]),
);
report.topSessions = [...sessions.entries()].map(([file, rows]) => ({
  session: path.basename(file, '.jsonl'),
  family: rows[0].family,
  calls: rows.length,
  input: rows.reduce((n, r) => n + r.input, 0),
  output: rows.reduce((n, r) => n + r.output, 0),
})).sort((a, b) => b.input - a.input).slice(0, 10);

if (jsonOut) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Scanned ${report.scannedFiles} transcript files; ${report.includedCalls} GPT calls included.`);
  for (const f of ['gpt-5.5', 'gpt-5.6']) {
    const a = report.families[f];
    const p = report.planCohort[f];
    console.log(`\n${f}: ${a.sessions} sessions, ${a.turns} turns, ${a.calls} calls`);
    console.log(`  input=${a.input.toLocaleString()} cached=${a.cachedPct.toFixed(1)}% output=${a.output.toLocaleString()}`);
    console.log(`  median input/call=${a.inputPerCallMedian.toLocaleString()} p90=${a.inputPerCallP90.toLocaleString()} calls/turn=${a.callsPerTurnMean.toFixed(2)}`);
    console.log(`  plan cohort: ${p.calls} calls, ${p.input.toLocaleString()} input tokens`);
  }
  console.log('\nGPT-5.6 variants:');
  for (const [model, a] of Object.entries(report.variants)) {
    if (model.startsWith('gpt-5.6')) console.log(`  ${model}: ${a.calls} calls, ${a.input.toLocaleString()} input`);
  }
  console.log('\nTop sessions by replayed input:');
  for (const s of report.topSessions) console.log(`  ${s.family} ${s.calls} calls ${s.input.toLocaleString()} input ${s.session}`);
}
