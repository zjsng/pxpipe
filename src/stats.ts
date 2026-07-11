/**
 * Aggregate metrics over a stream of TrackEvents. Pure data-layer module —
 * the dashboard's `/api/stats.json` endpoint imports `aggregateEventsFile`
 * + `summaryToJson` from here. There is no longer a CLI entrypoint; the
 * live dashboard at http://127.0.0.1:47821/ surfaces everything this used
 * to print.
 *
 * Node-only (uses node:fs). Streams the file line-by-line so a 100 MB log
 * doesn't blow the heap. The aggregator itself (`newSummary` / `fold`) is
 * pure — fed a sequence of TrackEvents and produces a Summary — so a
 * Workers-side dashboard could reuse it later by extracting it into core/.
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { TrackEvent } from './core/tracker.js';
import { accountUsage } from './core/accounting.js';
import { providerForPath, serviceTierFor, type ProviderId } from './core/provider.js';

// ---- pure aggregator ------------------------------------------------------

export interface Summary {
  total: number;
  ok2xx: number;
  err4xx: number;
  err5xx: number;
  compressed: number;
  passthrough: number;
  /** Sum of orig_chars across compressed requests — the bytes we removed
   *  from the text path by rendering to PNG. */
  origCharsTotal: number;
  imageBytesTotal: number;
  /** Legacy raw-token counters. `cacheCreate/ReadTokensTotal` are
   * Anthropic-only for compatibility; OpenAI cache fields have explicit names
   * below and provider buckets are authoritative for mixed traffic. */
  inputTokensTotal: number;
  ordinaryInputTokensTotal: number;
  outputTokensTotal: number;
  cacheCreateTokensTotal: number;
  cacheReadTokensTotal: number;
  openAICachedTokensTotal: number;
  openAICacheWriteTokensTotal: number;
  /** Number of events whose cache_read_tokens > 0 — i.e. the prompt cache
   *  actually hit. */
  cacheHitEvents: number;
  /** Number of events that carried any usage data at all. Denominator for
   *  cacheHitEvents. */
  eventsWithUsage: number;
  durationMs: number[];
  firstByteMs: number[];
  skipReasons: Map<string, number>;
  byCwd: Map<string, { count: number; origChars: number; imageBytes: number }>;
  /** system_sha8 → number of times seen. High repeat count = cache should
   *  be doing its job. */
  systemShaHist: Map<string, number>;
  unknownTags: Map<string, number>;
  /** Provider-specific telemetry. The legacy top-level counters remain for
   * compatibility, but dollar/accounting consumers must use this map. */
  byProvider: Map<ProviderId, ProviderSummary>;
  /** Provider-aware savings accumulators. These are provider-credit
   * equivalents, never a cross-provider USD total. */
  baselineMeasuredCount: number;
  baselineInputWeighted: number;
  actualInputWeighted: number;
  savedInputWeighted: number;
  allBaselineEquivalentWeighted: number;
  allActualInputWeighted: number;
  allOutputWeighted: number;
  accountingWarmth: Map<string, { ts: number; cacheable: number; prefixSha?: string }>;
  modelHist: Map<string, number>;
  serviceTierHist: Map<string, number>;
  stopReasonHist: Map<string, number>;
  safetyFlagged: number;
}

/** Full-history provider bucket. Values are raw telemetry unless the field is
 * explicitly named `...Weighted`; no OpenAI value is silently converted to an
 * Anthropic-priced dollar amount. */
export interface ProviderSummary {
  provider: ProviderId;
  total: number;
  ok2xx: number;
  err4xx: number;
  err5xx: number;
  compressed: number;
  passthrough: number;
  eventsWithUsage: number;
  inputTokensTotal: number;
  ordinaryInputTokensTotal: number;
  outputTokensTotal: number;
  reasoningTokensTotal: number;
  cacheCreateTokensTotal: number;
  cacheReadTokensTotal: number;
  cachedTokensTotal: number;
  cacheWriteTokensTotal: number;
  imageTokensTotal: number;
  baselineImagedTokensTotal: number;
  cacheHitEvents: number;
  safetyFlagged: number;
  models: Map<string, number>;
  serviceTiers: Map<string, number>;
  stopReasons: Map<string, number>;
  reasoningItemsTotal: number;
  encryptedReasoningItemsTotal: number;
  renderCacheHits: number;
  renderCacheMisses: number;
  renderCacheSavedMs: number;
  promptCacheKeyEvents: number;
  baselineMeasuredCount: number;
  baselineInputWeighted: number;
  actualInputWeighted: number;
  savedInputWeighted: number;
  allBaselineEquivalentWeighted: number;
  allActualInputWeighted: number;
  allOutputWeighted: number;
}

function newProviderSummary(provider: ProviderId): ProviderSummary {
  return {
    provider,
    total: 0,
    ok2xx: 0,
    err4xx: 0,
    err5xx: 0,
    compressed: 0,
    passthrough: 0,
    eventsWithUsage: 0,
    inputTokensTotal: 0,
    ordinaryInputTokensTotal: 0,
    outputTokensTotal: 0,
    reasoningTokensTotal: 0,
    cacheCreateTokensTotal: 0,
    cacheReadTokensTotal: 0,
    cachedTokensTotal: 0,
    cacheWriteTokensTotal: 0,
    imageTokensTotal: 0,
    baselineImagedTokensTotal: 0,
    cacheHitEvents: 0,
    safetyFlagged: 0,
    models: new Map(),
    serviceTiers: new Map(),
    stopReasons: new Map(),
    reasoningItemsTotal: 0,
    encryptedReasoningItemsTotal: 0,
    renderCacheHits: 0,
    renderCacheMisses: 0,
    renderCacheSavedMs: 0,
    promptCacheKeyEvents: 0,
    baselineMeasuredCount: 0,
    baselineInputWeighted: 0,
    actualInputWeighted: 0,
    savedInputWeighted: 0,
    allBaselineEquivalentWeighted: 0,
    allActualInputWeighted: 0,
    allOutputWeighted: 0,
  };
}

export function newSummary(): Summary {
  return {
    total: 0,
    ok2xx: 0,
    err4xx: 0,
    err5xx: 0,
    compressed: 0,
    passthrough: 0,
    origCharsTotal: 0,
    imageBytesTotal: 0,
    inputTokensTotal: 0,
    ordinaryInputTokensTotal: 0,
    outputTokensTotal: 0,
    cacheCreateTokensTotal: 0,
    cacheReadTokensTotal: 0,
    openAICachedTokensTotal: 0,
    openAICacheWriteTokensTotal: 0,
    cacheHitEvents: 0,
    eventsWithUsage: 0,
    durationMs: [],
    firstByteMs: [],
    skipReasons: new Map(),
    byCwd: new Map(),
    systemShaHist: new Map(),
    unknownTags: new Map(),
    byProvider: new Map(),
    modelHist: new Map(),
    serviceTierHist: new Map(),
    stopReasonHist: new Map(),
    safetyFlagged: 0,
    baselineMeasuredCount: 0,
    baselineInputWeighted: 0,
    actualInputWeighted: 0,
    savedInputWeighted: 0,
    allBaselineEquivalentWeighted: 0,
    allActualInputWeighted: 0,
    allOutputWeighted: 0,
    accountingWarmth: new Map(),
  };
}

export function fold(s: Summary, ev: TrackEvent): Summary {
  const provider = providerForPath(ev.path, ev.model);
  let ps = s.byProvider.get(provider);
  if (!ps) {
    ps = newProviderSummary(provider);
    s.byProvider.set(provider, ps);
  }
  ps.total++;
  if (ev.status >= 200 && ev.status < 300) ps.ok2xx++;
  else if (ev.status >= 400 && ev.status < 500) ps.err4xx++;
  else if (ev.status >= 500) ps.err5xx++;
  if (ev.compressed === true) ps.compressed++;
  else if (ev.compressed === false) ps.passthrough++;
  if (ev.model) {
    ps.models.set(ev.model, (ps.models.get(ev.model) ?? 0) + 1);
    s.modelHist.set(ev.model, (s.modelHist.get(ev.model) ?? 0) + 1);
  }
  const tier = serviceTierFor(ev.model, ev.service_tier);
  if (tier) {
    ps.serviceTiers.set(tier, (ps.serviceTiers.get(tier) ?? 0) + 1);
    s.serviceTierHist.set(tier, (s.serviceTierHist.get(tier) ?? 0) + 1);
  }
  if (ev.stop_reason) {
    ps.stopReasons.set(ev.stop_reason, (ps.stopReasons.get(ev.stop_reason) ?? 0) + 1);
    s.stopReasonHist.set(ev.stop_reason, (s.stopReasonHist.get(ev.stop_reason) ?? 0) + 1);
  }
  const completionSec = Date.parse(ev.ts) / 1000;
  const acc = accountUsage(
    {
      provider,
      model: ev.model,
      status: ev.status,
      compressed: ev.compressed === true,
      safetyFlagged: ev.safety_flagged === true
        || ev.stop_reason === 'refusal'
        || ev.stop_reason === 'content_filter'
        || ev.stop_reason === 'safety'
        || ev.stop_reason === 'safety_refusal'
        || ev.stop_reason === 'blocked',
      inputTokens: ev.input_tokens,
      outputTokens: ev.output_tokens,
      reasoningTokens: ev.reasoning_tokens,
      cacheCreateTokens: ev.cache_create_tokens,
      cacheReadTokens: ev.cache_read_tokens,
      cachedTokens: ev.cached_tokens,
      cacheWriteTokens: ev.cache_write_tokens,
      imageTokens: ev.image_tokens,
      baselineImagedTokens: ev.baseline_imaged_tokens,
      baselineTokens: ev.baseline_tokens,
      baselineCacheableTokens: ev.baseline_cacheable_tokens,
      baselineProbeStatus: ev.baseline_probe_status,
      sessionId: ev.first_user_sha8 ?? '<unknown>',
      completionSec,
      requestStartSec: completionSec - Math.max(0, ev.duration_ms || 0) / 1000,
      prefixSha: ev.system_sha8,
    },
    { warmth: s.accountingWarmth },
  );
  if (acc.safetyFlagged) {
    ps.safetyFlagged++;
    s.safetyFlagged++;
  }
  ps.reasoningItemsTotal += ev.gpt_reasoning_items ?? 0;
  ps.encryptedReasoningItemsTotal += ev.gpt_encrypted_reasoning_items ?? 0;
  ps.renderCacheHits += ev.gpt_render_cache_hits ?? 0;
  ps.renderCacheMisses += ev.gpt_render_cache_misses ?? 0;
  ps.renderCacheSavedMs += ev.gpt_render_cache_saved_ms ?? 0;
  if (ev.gpt_prompt_cache_key_present) ps.promptCacheKeyEvents++;
  s.total++;
  if (ev.status >= 200 && ev.status < 300) s.ok2xx++;
  else if (ev.status >= 400 && ev.status < 500) s.err4xx++;
  else if (ev.status >= 500) s.err5xx++;

  if (ev.compressed === true) {
    s.compressed++;
    if (typeof ev.orig_chars === 'number') s.origCharsTotal += ev.orig_chars;
    if (typeof ev.image_bytes === 'number') s.imageBytesTotal += ev.image_bytes;
  } else if (ev.compressed === false) {
    s.passthrough++;
    if (ev.reason) s.skipReasons.set(ev.reason, (s.skipReasons.get(ev.reason) ?? 0) + 1);
  }

  if (typeof ev.duration_ms === 'number') s.durationMs.push(ev.duration_ms);
  if (typeof ev.first_byte_ms === 'number') s.firstByteMs.push(ev.first_byte_ms);

  const hasUsage = acc.haveUsage;
  if (hasUsage) {
    s.eventsWithUsage++;
    s.inputTokensTotal += ev.input_tokens ?? 0;
    s.ordinaryInputTokensTotal += acc.ordinaryInputTokens;
    s.outputTokensTotal += ev.output_tokens ?? 0;
    s.cacheCreateTokensTotal += ev.cache_create_tokens ?? 0;
    s.cacheReadTokensTotal += ev.cache_read_tokens ?? 0;
    s.openAICachedTokensTotal += provider === 'openai' ? acc.cacheReadTokens : 0;
    s.openAICacheWriteTokensTotal += provider === 'openai' ? acc.cacheWriteTokens : 0;
    if ((ev.cache_read_tokens ?? 0) > 0 || (provider === 'openai' && acc.cacheReadTokens > 0)) s.cacheHitEvents++;
    ps.eventsWithUsage++;
    ps.inputTokensTotal += ev.input_tokens ?? 0;
    ps.ordinaryInputTokensTotal += acc.ordinaryInputTokens;
    ps.outputTokensTotal += ev.output_tokens ?? 0;
    ps.reasoningTokensTotal += ev.reasoning_tokens ?? 0;
    ps.cacheCreateTokensTotal += ev.cache_create_tokens ?? 0;
    ps.cacheReadTokensTotal += ev.cache_read_tokens ?? 0;
    ps.cachedTokensTotal += provider === 'openai' ? acc.cacheReadTokens : 0;
    ps.cacheWriteTokensTotal += provider === 'openai' ? acc.cacheWriteTokens : 0;
    if ((ev.cache_read_tokens ?? 0) > 0 || (provider === 'openai' && acc.cacheReadTokens > 0)) ps.cacheHitEvents++;
  }
  ps.imageTokensTotal += ev.image_tokens ?? 0;
  ps.baselineImagedTokensTotal += ev.baseline_imaged_tokens ?? 0;

  // Provider-aware savings. The same helper is used by the live dashboard and
  // sessions; passthrough, probe-failed, safety, and error rows contribute to
  // request telemetry but never to the savings numerator.
  if (acc.creditSaving) {
    const saved = acc.baselineInputEff - acc.actualInputEff;
    s.baselineMeasuredCount++;
    s.baselineInputWeighted += acc.baselineInputEff;
    s.actualInputWeighted += acc.actualInputEff;
    s.savedInputWeighted += saved;
    ps.baselineMeasuredCount++;
    ps.baselineInputWeighted += acc.baselineInputEff;
    ps.actualInputWeighted += acc.actualInputEff;
    ps.savedInputWeighted += saved;
  }
  if (acc.billableUsage) {
    s.allBaselineEquivalentWeighted += acc.baselineInputEff;
    s.allActualInputWeighted += acc.actualInputEff;
    s.allOutputWeighted += acc.outputEquiv;
    ps.allBaselineEquivalentWeighted += acc.baselineInputEff;
    ps.allActualInputWeighted += acc.actualInputEff;
    ps.allOutputWeighted += acc.outputEquiv;
  }

  if (ev.cwd) {
    const k = ev.cwd;
    const e = s.byCwd.get(k) ?? { count: 0, origChars: 0, imageBytes: 0 };
    e.count++;
    e.origChars += ev.orig_chars ?? 0;
    e.imageBytes += ev.image_bytes ?? 0;
    s.byCwd.set(k, e);
  }

  if (ev.system_sha8) {
    s.systemShaHist.set(ev.system_sha8, (s.systemShaHist.get(ev.system_sha8) ?? 0) + 1);
  }

  if (ev.unknown_static_tags) {
    for (const t of ev.unknown_static_tags) {
      s.unknownTags.set(t, (s.unknownTags.get(t) ?? 0) + 1);
    }
  }

  return s;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

/** Format a number with thousands separators. Used for big token counts. */
function fmtN(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtPct(num: number, denom: number): string {
  if (denom === 0) return '   —';
  return ((num / denom) * 100).toFixed(1).padStart(4) + '%';
}

// ---- text report ----------------------------------------------------------

export function renderTextReport(s: Summary): string {
  const lines: string[] = [];
  const sortedDur = [...s.durationMs].sort((a, b) => a - b);
  const sortedFB = [...s.firstByteMs].sort((a, b) => a - b);

  lines.push('━━━ pxpipe stats ━━━');
  lines.push('');
  lines.push(`requests:       ${fmtN(s.total)}`);
  lines.push(
    `  2xx:          ${fmtN(s.ok2xx).padStart(8)}   ` +
      `4xx: ${fmtN(s.err4xx).padStart(6)}   5xx: ${fmtN(s.err5xx).padStart(6)}`,
  );
  lines.push(
    `  compressed:   ${fmtN(s.compressed).padStart(8)}  (${fmtPct(s.compressed, s.total)})`,
  );
  lines.push(
    `  passthrough:  ${fmtN(s.passthrough).padStart(8)}  (${fmtPct(s.passthrough, s.total)})`,
  );
  lines.push('');

  lines.push('latency (ms):');
  lines.push(
    `  duration  p50=${percentile(sortedDur, 50)}  p95=${percentile(sortedDur, 95)}  p99=${percentile(sortedDur, 99)}`,
  );
  lines.push(
    `  first-byte p50=${percentile(sortedFB, 50)}  p95=${percentile(sortedFB, 95)}  p99=${percentile(sortedFB, 99)}`,
  );
  lines.push('');

  lines.push('compression:');
  lines.push(`  orig text rendered: ${fmtN(s.origCharsTotal)} chars`);
  lines.push(`  image bytes:        ${fmtN(s.imageBytesTotal)} B`);
  const ratio =
    s.origCharsTotal > 0 ? (s.imageBytesTotal / s.origCharsTotal).toFixed(3) : '—';
  lines.push(`  bytes/char ratio:   ${ratio}`);
  lines.push('');

  for (const [provider, p] of s.byProvider) {
    if (p.eventsWithUsage === 0) continue;
    if (provider === 'anthropic') {
      lines.push('Claude / Anthropic token usage:');
      lines.push(`  input:         ${fmtN(p.inputTokensTotal).padStart(12)}`);
      lines.push(`  output:        ${fmtN(p.outputTokensTotal).padStart(12)}`);
      lines.push(`  cache create:  ${fmtN(p.cacheCreateTokensTotal).padStart(12)}`);
      lines.push(`  cache read:    ${fmtN(p.cacheReadTokensTotal).padStart(12)}`);
      const totalIn = p.inputTokensTotal + p.cacheCreateTokensTotal + p.cacheReadTokensTotal;
      lines.push(`  cache hit rate (by tokens):  ${fmtPct(p.cacheReadTokensTotal, totalIn)}`);
      lines.push(`  cache hit rate (by events):  ${fmtPct(p.cacheHitEvents, p.eventsWithUsage)}`);
      lines.push(`  provider input saved: ${fmtN(Math.round(p.savedInputWeighted))}`);
      lines.push('  monetary conversion: use the documented Anthropic model rate');
    } else if (provider === 'openai') {
      lines.push('GPT / OpenAI token telemetry (not Anthropic-priced):');
      lines.push(`  input:         ${fmtN(p.inputTokensTotal).padStart(12)}`);
      lines.push(`  output:        ${fmtN(p.outputTokensTotal).padStart(12)}`);
      lines.push(`  reasoning:     ${fmtN(p.reasoningTokensTotal).padStart(12)}`);
      lines.push(`  cached read:   ${fmtN(p.cachedTokensTotal).padStart(12)}`);
      lines.push(`  cache writes:  ${fmtN(p.cacheWriteTokensTotal).padStart(12)}`);
      lines.push(`  image tokens:  ${fmtN(p.imageTokensTotal).padStart(12)}`);
      lines.push(`  text baseline: ${fmtN(p.baselineImagedTokensTotal).padStart(12)}`);
      lines.push(`  cache hit rate (by events): ${fmtPct(p.cacheHitEvents, p.eventsWithUsage)}`);
      lines.push(`  provider input credits saved: ${fmtN(Math.round(p.savedInputWeighted))}`);
      lines.push('  monetary conversion: unsupported — use provider credits/tokens');
    } else {
      lines.push('Other provider telemetry (unpriced):');
      lines.push(`  input: ${fmtN(p.inputTokensTotal)}  output: ${fmtN(p.outputTokensTotal)}`);
    }
    lines.push('');
  }

  if (s.modelHist.size > 0) {
    lines.push('models observed:');
    const topModels = [...s.modelHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    for (const [model, count] of topModels) lines.push(`  ${fmtN(count).padStart(8)}  ${model}`);
    lines.push('');
  }

  if (s.skipReasons.size > 0) {
    lines.push('top skip reasons:');
    const top = [...s.skipReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [reason, count] of top) {
      lines.push(`  ${count.toString().padStart(6)}  ${reason}`);
    }
    lines.push('');
  }

  if (s.byCwd.size > 0) {
    lines.push('top working dirs (by request count):');
    const top = [...s.byCwd.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10);
    for (const [cwd, e] of top) {
      const cratio = e.origChars > 0 ? (e.imageBytes / e.origChars).toFixed(2) : '—';
      lines.push(`  ${e.count.toString().padStart(6)}  ratio=${cratio}  ${cwd}`);
    }
    lines.push('');
  }

  if (s.systemShaHist.size > 0) {
    lines.push('top system prompts (system_sha8, high count = cache reuse):');
    const top = [...s.systemShaHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [sha, count] of top) {
      lines.push(`  ${count.toString().padStart(6)}  ${sha}`);
    }
    const unique = s.systemShaHist.size;
    const reuseRate =
      s.total > 0 ? (((s.total - unique) / s.total) * 100).toFixed(1) : '—';
    lines.push(`  unique prompts: ${unique}    reuse rate: ${reuseRate}%`);
    lines.push('');
  }

  if (s.unknownTags.size > 0) {
    lines.push('⚠  unknown tag-shaped blocks observed in static slab:');
    const top = [...s.unknownTags.entries()].sort((a, b) => b[1] - a[1]);
    for (const [tag, count] of top) {
      lines.push(`  ${count.toString().padStart(6)}  <${tag}>`);
    }
    lines.push(
      '  → consider adding these to DYNAMIC_BLOCK_TAGS in src/core/transform.ts',
    );
    lines.push('');
  }

  return lines.join('\n');
}

// ---- file-backed aggregation (used by the dashboard) ----------------------

/**
 * Stream an events JSONL file and fold every row into a Summary. Returns the
 * Summary plus a parsed/dropped tally so callers can detect empty/garbage
 * inputs. The dashboard wraps this for the /api/stats.json endpoint.
 *
 * Note: this is a full re-read on every call. The dashboard already has a
 * 50-event ring buffer of the *recent* slice; stats need the full history
 * to compute cache-hit-rate over thousands of requests. ~1.5 MB JSONL
 * streams in well under 100 ms on an SSD.
 */
export async function aggregateEventsFile(
  file: string,
): Promise<{ summary: Summary; parsed: number; dropped: number } | undefined> {
  if (!fs.existsSync(file)) return undefined;
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const summary = newSummary();
  let parsed = 0;
  let dropped = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as TrackEvent;
      fold(summary, ev);
      parsed++;
    } catch {
      dropped++;
    }
  }
  return { summary, parsed, dropped };
}

/**
 * Convert a Summary to a JSON-serializable shape for the dashboard's
 * /api/stats.json endpoint. JSON.stringify drops Map entries silently, so
 * we materialize the top-N entries of each map into plain [key, value]
 * tuples. Caps each map at 20 entries to keep the response bounded.
 */
export function summaryToJson(s: Summary): Record<string, unknown> {
  const topN = <K, V>(m: Map<K, V>, n = 20): [K, V][] =>
    [...m.entries()].sort((a, b) => {
      const av = typeof a[1] === 'number' ? a[1] : 0;
      const bv = typeof b[1] === 'number' ? b[1] : 0;
      return bv - av;
    }).slice(0, n);
  const sortedDur = [...s.durationMs].sort((a, b) => a - b);
  const sortedFB = [...s.firstByteMs].sort((a, b) => a - b);
  return {
    total: s.total,
    ok2xx: s.ok2xx,
    err4xx: s.err4xx,
    err5xx: s.err5xx,
    compressed: s.compressed,
    passthrough: s.passthrough,
    origCharsTotal: s.origCharsTotal,
    imageBytesTotal: s.imageBytesTotal,
    inputTokensTotal: s.inputTokensTotal,
    ordinaryInputTokensTotal: s.ordinaryInputTokensTotal,
    outputTokensTotal: s.outputTokensTotal,
    cacheCreateTokensTotal: s.cacheCreateTokensTotal,
    cacheReadTokensTotal: s.cacheReadTokensTotal,
    openAICachedTokensTotal: s.openAICachedTokensTotal,
    openAICacheWriteTokensTotal: s.openAICacheWriteTokensTotal,
    cacheHitEvents: s.cacheHitEvents,
    eventsWithUsage: s.eventsWithUsage,
    // These are provider-credit equivalents. They are intentionally not
    // exposed as USD because a mixed Claude/GPT total has no single price.
    baselineMeasuredCount: s.baselineMeasuredCount,
    baselineInputWeighted: Math.round(s.baselineInputWeighted),
    actualInputWeighted: Math.round(s.actualInputWeighted),
    savedInputWeighted: Math.round(s.savedInputWeighted),
    allBaselineEquivalentWeighted: Math.round(s.allBaselineEquivalentWeighted),
    allActualInputWeighted: Math.round(s.allActualInputWeighted),
    allOutputWeighted: Math.round(s.allOutputWeighted),
    durationP50: percentile(sortedDur, 50),
    durationP95: percentile(sortedDur, 95),
    firstByteP50: percentile(sortedFB, 50),
    firstByteP95: percentile(sortedFB, 95),
    skipReasons: topN(s.skipReasons),
    byCwd: topN(s.byCwd),
    systemShaHist: topN(s.systemShaHist),
    unknownTags: topN(s.unknownTags),
    models: topN(s.modelHist),
    serviceTiers: topN(s.serviceTierHist),
    stopReasons: topN(s.stopReasonHist),
    safetyFlagged: s.safetyFlagged,
    byProvider: Object.fromEntries(
      [...s.byProvider.entries()].map(([provider, p]) => [provider, {
        provider: p.provider,
        total: p.total,
        ok2xx: p.ok2xx,
        err4xx: p.err4xx,
        err5xx: p.err5xx,
        compressed: p.compressed,
        passthrough: p.passthrough,
        eventsWithUsage: p.eventsWithUsage,
        inputTokensTotal: p.inputTokensTotal,
        ordinaryInputTokensTotal: p.ordinaryInputTokensTotal,
        outputTokensTotal: p.outputTokensTotal,
        reasoningTokensTotal: p.reasoningTokensTotal,
        cacheCreateTokensTotal: p.cacheCreateTokensTotal,
        cacheReadTokensTotal: p.cacheReadTokensTotal,
        cachedTokensTotal: p.cachedTokensTotal,
        cacheWriteTokensTotal: p.cacheWriteTokensTotal,
        imageTokensTotal: p.imageTokensTotal,
        baselineImagedTokensTotal: p.baselineImagedTokensTotal,
        cacheHitEvents: p.cacheHitEvents,
        safetyFlagged: p.safetyFlagged,
        models: topN(p.models),
        serviceTiers: topN(p.serviceTiers),
        stopReasons: topN(p.stopReasons),
        reasoningItemsTotal: p.reasoningItemsTotal,
        encryptedReasoningItemsTotal: p.encryptedReasoningItemsTotal,
        renderCacheHits: p.renderCacheHits,
        renderCacheMisses: p.renderCacheMisses,
        renderCacheSavedMs: p.renderCacheSavedMs,
        promptCacheKeyEvents: p.promptCacheKeyEvents,
        baselineMeasuredCount: p.baselineMeasuredCount,
        baselineInputWeighted: Math.round(p.baselineInputWeighted),
        actualInputWeighted: Math.round(p.actualInputWeighted),
        savedInputWeighted: Math.round(p.savedInputWeighted),
        allBaselineEquivalentWeighted: Math.round(p.allBaselineEquivalentWeighted),
        allActualInputWeighted: Math.round(p.allActualInputWeighted),
        allOutputWeighted: Math.round(p.allOutputWeighted),
      }]),
    ),
  };
}
