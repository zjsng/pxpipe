/**
 * Cache-aware GPT/OpenAI savings math.
 *
 * This is deliberately separate from src/core/baseline.ts (Anthropic): OpenAI
 * has no `count_tokens`, and images are billed by OpenAI's vision-token formula rather than
 * text tokens. The transform path records two GPT-specific facts per imaged
 * request:
 *
 *   imageTokens           = what the rendered images actually cost as input
 *   baselineImagedTokens  = o200k text tokens the imaged/stripped content would
 *                           have cost if left as plain text
 *
 * OpenAI usage then tells us how many prompt tokens were served from prompt
 * cache (`cached_tokens`, a subset of input_tokens). For the gpt-5 family, cached
 * input is billed at ~0.1× the normal input rate. GPT-5.6+ additionally reports
 * cache writes, billed at 1.25×.
 */

import { CACHE_READ_RATE } from './baseline.js';

/** gpt-5 cached input list ratio: $0.125 / $1.25 per 1M tokens. */
export const OPENAI_GPT5_CACHE_READ_RATE = 0.1;
export const OPENAI_GPT56_CACHE_WRITE_RATE = 1.25;

/** gpt-5 output/input list ratio: $10 / $1.25 per 1M tokens. */
export const OPENAI_GPT5_OUTPUT_RATE = 8;

/** Older OpenAI families use a less aggressive cached-input discount. pxpipe's
 * GPT compression gate is currently gpt-5.x-only, but keep the helper explicit
 * so passthrough telemetry does not accidentally get priced at Anthropic rates. */
/** Grok cached prompt list ratio from xAI model pricing metadata
 *  (cachedPromptTokenPrice / promptTextTokenPrice = 5000/20000). */
export const GROK_CACHE_READ_RATE = 0.25;

/** Grok completion/input list ratio (completionTextTokenPrice / promptTextTokenPrice
 *  = 60000/20000). */
export const GROK_OUTPUT_RATE = 3;

export function openAICacheReadRate(model: string | undefined): number {
  const m = (model ?? '').toLowerCase();
  // Model-based rates on the shared Responses path (several families share /v1/responses).
  if (m.startsWith('claude') || m.includes('anthropic')) return CACHE_READ_RATE;
  if (m.startsWith('grok-')) return GROK_CACHE_READ_RATE;
  if (/^gpt-5/.test(m)) return OPENAI_GPT5_CACHE_READ_RATE;
  return 0.5;
}

export function openAIOutputRate(model: string | undefined): number {
  const m = (model ?? '').toLowerCase();
  if (m.startsWith('claude') || m.includes('anthropic')) return 5;
  if (m.startsWith('grok-')) return GROK_OUTPUT_RATE;
  if (/^gpt-5/.test(m)) return OPENAI_GPT5_OUTPUT_RATE;
  // Good-enough fallback for non-compressed OpenAI rows; they normally do not
  // enter the savings numerator, but the all-usage denominator should still be
  // roughly dollar-weighted.
  return 4;
}

export interface OpenAIInputSplit {
  /** Ordinary input tokens after clamping provider-reported subsets. */
  ordinary: number;
  /** Prompt-cache read tokens (a subset of input). */
  cached: number;
  /** Prompt-cache write tokens (a subset of the remaining input). */
  written: number;
}

/**
 * Normalize the OpenAI usage subsets once, so the accounting number, the
 * dashboard's ordinary-input column, and the sessions/stats rollups cannot
 * disagree on malformed or overlapping provider telemetry. OpenAI reports
 * cached and written tokens as subsets of `input_tokens`; neither is additive
 * to it.
 */
export function splitOpenAIInputTokens(
  inputTokens: number,
  cachedTokens = 0,
  cacheWriteTokens = 0,
): OpenAIInputSplit {
  const total = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0;
  const cached = Number.isFinite(cachedTokens)
    ? Math.min(Math.max(0, cachedTokens), total)
    : 0;
  const written = Number.isFinite(cacheWriteTokens)
    ? Math.min(Math.max(0, cacheWriteTokens), total - cached)
    : 0;
  return { ordinary: total - cached - written, cached, written };
}

export function openAICacheWriteRate(model: string | undefined): number {
  return /^gpt-5\.6(?:-|$)/.test((model ?? '').toLowerCase())
    ? OPENAI_GPT56_CACHE_WRITE_RATE
    : 1;
}

/** Weighted input tokens actually paid to OpenAI this turn. `cachedTokens` is a
 * subset of `inputTokens`, not an additive bucket. */
export function computeOpenAIActualInputEff(
  inputTokens: number,
  cachedTokens: number,
  model?: string,
  cacheWriteTokens = 0,
): number {
  const split = splitOpenAIInputTokens(inputTokens, cachedTokens, cacheWriteTokens);
  return split.ordinary
    + split.cached * openAICacheReadRate(model)
    + split.written * openAICacheWriteRate(model);
}

/** Raw token count for the unproxied GPT counterfactual: replace the rendered
 * images with the o200k text they stood in for. */
export function computeOpenAIBaselineRawTokens(
  inputTokens: number,
  imageTokens: number,
  baselineImagedTokens: number,
): number {
  if (inputTokens <= 0) return 0;
  const delta = (baselineImagedTokens || 0) - (imageTokens || 0);
  return Math.max(0, inputTokens + delta);
}

/** Weighted input tokens for the unproxied GPT text counterfactual.
 *
 * We cannot ask OpenAI `count_tokens`, and the API does not expose per-block
 * cache accounting. The only honest observable is whether this request had a
 * prompt-cache hit at all (`cached_tokens > 0`). The imaged slab sits in the
 * stable prefix; when OpenAI reports cached tokens, that slab would have been
 * cached as text too, so the text↔image delta is discounted by the same cached
 * input rate. On a cold/no-cache turn, the delta is paid at the full input rate.
 */
export function computeOpenAIBaselineInputEff(
  inputTokens: number,
  cachedTokens: number,
  imageTokens: number,
  baselineImagedTokens: number,
  model?: string,
  cacheWriteTokens = 0,
): number {
  const actual = computeOpenAIActualInputEff(inputTokens, cachedTokens, model, cacheWriteTokens);
  if (inputTokens <= 0 || imageTokens <= 0 || baselineImagedTokens <= 0) return actual;
  const delta = baselineImagedTokens - imageTokens;
  const deltaWeight = (cachedTokens || 0) > 0
    ? openAICacheReadRate(model)
    : (cacheWriteTokens || 0) > 0
      ? openAICacheWriteRate(model)
      : 1.0;
  return actual + delta * deltaWeight;
}
