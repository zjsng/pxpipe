/**
 * Provider-aware, cache-aware usage accounting shared by the live dashboard,
 * replay, sessions, and full-history stats.
 *
 * This module deliberately reports provider input-credit equivalents rather
 * than pretending that GPT/Codex subscription telemetry has an Anthropic USD
 * price.  The caller supplies the small normalized set of fields available on
 * either a live ProxyEvent or a persisted TrackEvent.
 */

import {
  computeActualInputEff,
  computeBaselineInputEff,
  deriveBaselineWarmth,
  type BaselineWarmthPrev,
} from './baseline.js';
import {
  computeOpenAIActualInputEff,
  computeOpenAIBaselineInputEff,
  computeOpenAIBaselineRawTokens,
  openAIOutputRate,
  splitOpenAIInputTokens,
} from './openai-savings.js';
import { type ProviderId } from './provider.js';

export interface AccountingState {
  /** Per-session prefix history used only to split a proven warm read into
   * reused vs grown text-prefix tokens. The cache-read field remains the only
   * warm/cold signal. */
  warmth: Map<string, BaselineWarmthPrev>;
  cacheTtlSec?: number;
}

export interface UsageAccountingInput {
  provider: ProviderId;
  model?: string;
  status: number;
  compressed: boolean;
  safetyFlagged?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  /** Anthropic cache-create tokens. */
  cacheCreateTokens?: number;
  /** Anthropic cache-read tokens. */
  cacheReadTokens?: number;
  /** OpenAI cached prompt tokens; a subset of inputTokens. */
  cachedTokens?: number;
  /** OpenAI cache-write tokens; a subset of inputTokens. */
  cacheWriteTokens?: number;
  imageTokens?: number;
  baselineImagedTokens?: number;
  baselineTokens?: number;
  baselineCacheableTokens?: number;
  baselineProbeStatus?: 'ok' | 'partial' | 'failed' | string;
  sessionId?: string;
  /** Completion and request-start times in epoch seconds. */
  completionSec?: number;
  requestStartSec?: number;
  prefixSha?: string;
}

export interface UsageAccounting {
  provider: ProviderId;
  compressed: boolean;
  safetyFlagged: boolean;
  /** A usage block carried at least one positive token count. */
  haveUsage: boolean;
  /** Usage on a successful response; only this is eligible for bill totals. */
  billableUsage: boolean;
  /** A trustworthy provider-specific text counterfactual was available. */
  haveBaseline: boolean;
  /** This row was compressed, successful, non-safety, usage-bearing, and had
   * a trustworthy counterfactual. Negative values are intentional: imaging
   * can lose on a cold/cache-write turn. */
  creditSaving: boolean;
  actualInputEff: number;
  baselineInputEff: number;
  outputEquiv: number;
  rawActualTokens: number;
  rawBaselineTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  /** OpenAI ordinary input after removing clamped cache subsets; for Claude it
   * is the provider-reported input_tokens value. */
  ordinaryInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** For Anthropic this is the observed cache-read state. For OpenAI it is
   * cached prompt tokens > 0. */
  warm: boolean;
}

export const ACCOUNTING_CACHE_TTL_SEC = 300;

export function isSafetyStopReason(reason: string | undefined): boolean {
  return reason === 'refusal'
    || reason === 'content_filter'
    || reason === 'safety'
    || reason === 'safety_refusal'
    || reason === 'blocked';
}

function positive(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Calculate one event's accounting values. `state` is mutated only to record a
 * completed, successful usage-bearing Anthropic turn for a later warm-prefix
 * split. It is safe to use the same function for live completion and replay.
 */
export function accountUsage(
  input: UsageAccountingInput,
  state: AccountingState,
): UsageAccounting {
  const inp = positive(input.inputTokens);
  const out = positive(input.outputTokens);
  const reasoning = positive(input.reasoningTokens);
  const cc = positive(input.cacheCreateTokens);
  const cr = positive(input.cacheReadTokens);
  const cached = positive(input.cachedTokens);
  const written = positive(input.cacheWriteTokens);
  const image = positive(input.imageTokens);
  const baselineImaged = positive(input.baselineImagedTokens);
  const baseline = positive(input.baselineTokens);
  const cacheable = positive(input.baselineCacheableTokens);
  const safetyFlagged = input.safetyFlagged === true;
  const haveUsage = inp > 0 || out > 0 || reasoning > 0 || cc > 0 || cr > 0 || cached > 0 || written > 0;
  const billableUsage = haveUsage && input.status >= 200 && input.status < 300;

  let haveBaseline = false;
  let actualInputEff = 0;
  let baselineInputEff = 0;
  let outputEquiv = 0;
  let rawActualTokens = 0;
  let rawBaselineTokens = 0;
  let warm = false;

  if (input.provider === 'openai') {
    const split = splitOpenAIInputTokens(inp, cached, written);
    actualInputEff = computeOpenAIActualInputEff(inp, cached, input.model, written);
    haveBaseline = image > 0 && baselineImaged > 0;
    const baselineEff = computeOpenAIBaselineInputEff(
      inp,
      cached,
      image,
      baselineImaged,
      input.model,
      written,
    );
    const deltaIsCreditable = haveBaseline && billableUsage && input.compressed && !safetyFlagged;
    baselineInputEff = deltaIsCreditable ? baselineEff : actualInputEff;
    outputEquiv = billableUsage ? out * openAIOutputRate(input.model) : 0;
    rawActualTokens = inp;
    rawBaselineTokens = computeOpenAIBaselineRawTokens(inp, image, baselineImaged);
    warm = cached > 0;
    return {
      provider: input.provider,
      compressed: input.compressed,
      safetyFlagged,
      haveUsage,
      billableUsage,
      haveBaseline,
      creditSaving: deltaIsCreditable,
      actualInputEff,
      baselineInputEff,
      outputEquiv,
      rawActualTokens,
      rawBaselineTokens,
      cacheReadTokens: split.cached,
      cacheWriteTokens: split.written,
      inputTokens: inp,
      ordinaryInputTokens: split.ordinary,
      outputTokens: out,
      reasoningTokens: reasoning,
      warm,
    };
  }

  actualInputEff = computeActualInputEff(inp, cc, cr);
  const probeOk = input.baselineProbeStatus === 'ok'
    || (input.baselineProbeStatus === undefined && baseline > 0);
  haveBaseline = baseline > 0 && probeOk;
  const prev = input.sessionId ? state.warmth.get(input.sessionId) : undefined;
  const completionSec = input.completionSec ?? input.requestStartSec ?? 0;
  const requestStartSec = input.requestStartSec ?? completionSec;
  const derived = deriveBaselineWarmth(
    prev,
    requestStartSec,
    cacheable,
    cr,
    state.cacheTtlSec ?? ACCOUNTING_CACHE_TTL_SEC,
    input.prefixSha,
  );
  warm = derived.warm;
  const deltaIsCreditable = haveBaseline && billableUsage && input.compressed && !safetyFlagged;
  baselineInputEff = deltaIsCreditable
    ? computeBaselineInputEff(
        baseline,
        cacheable,
        inp,
        cc,
        cr,
        warm,
        derived.prevCacheable,
      )
    : actualInputEff;
  outputEquiv = billableUsage ? out * 5 : 0;
  rawActualTokens = inp + cc + cr;
  rawBaselineTokens = baseline;

  // Do not let an error or an incomplete usage row alter the cache-prefix
  // history used by later counterfactuals.
  if (input.sessionId && billableUsage) {
    state.warmth.set(input.sessionId, {
      ts: completionSec,
      cacheable: cacheable > 0 ? cacheable : (prev?.cacheable ?? 0),
      prefixSha: input.prefixSha ?? prev?.prefixSha,
    });
  }

  return {
    provider: input.provider,
    compressed: input.compressed,
    safetyFlagged,
    haveUsage,
    billableUsage,
    haveBaseline,
    creditSaving: deltaIsCreditable,
    actualInputEff,
    baselineInputEff,
    outputEquiv,
    rawActualTokens,
    rawBaselineTokens,
    cacheReadTokens: cr,
    cacheWriteTokens: cc,
    inputTokens: inp,
    ordinaryInputTokens: inp,
    outputTokens: out,
    reasoningTokens: reasoning,
    warm,
  };
}
