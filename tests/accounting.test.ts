import { describe, expect, it } from 'vitest';
import { accountUsage } from '../src/core/accounting.js';

function state() {
  return { warmth: new Map() };
}

describe('shared provider accounting', () => {
  it('normalizes overlapping OpenAI cache subsets once for every consumer', () => {
    const result = accountUsage({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      status: 200,
      compressed: true,
      inputTokens: 10_000,
      outputTokens: 100,
      cachedTokens: 12_000,
      cacheWriteTokens: 3_000,
      imageTokens: 1_000,
      baselineImagedTokens: 5_000,
    }, state());

    // cached is clamped to input; no write or ordinary tokens remain. The
    // displayed ordinary/read/write split must therefore match actual_eff.
    expect(result.ordinaryInputTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(10_000);
    expect(result.cacheWriteTokens).toBe(0);
    expect(result.actualInputEff).toBe(1_000);
    expect(result.creditSaving).toBe(true);
  });

  it('treats reasoning-only successful telemetry as usage, without inventing input savings', () => {
    const result = accountUsage({
      provider: 'openai',
      model: 'gpt-5.6-terra',
      status: 200,
      compressed: false,
      reasoningTokens: 42,
    }, state());

    expect(result.haveUsage).toBe(true);
    expect(result.billableUsage).toBe(true);
    expect(result.creditSaving).toBe(false);
    expect(result.outputEquiv).toBe(0);
  });

  it('never credits a refusal/error even when a counterfactual and usage exist', () => {
    for (const status of [400, 500]) {
      const result = accountUsage({
        provider: 'openai',
        model: 'gpt-5.6-luna',
        status,
        compressed: true,
        inputTokens: 10_000,
        cachedTokens: 2_000,
        imageTokens: 1_000,
        baselineImagedTokens: 5_000,
        safetyFlagged: status === 400,
      }, state());
      expect(result.billableUsage).toBe(false);
      expect(result.creditSaving).toBe(false);
    }
  });
});
