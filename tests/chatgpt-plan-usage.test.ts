import { describe, expect, it } from 'vitest';
import {
  CHATGPT_PLAN_CLAIM,
  detectChatGptSubscription,
  estimatePlanPercentages,
  normalizePlan,
  planTierMultiplier,
} from '../src/core/chatgpt-plan-usage.js';
import { toTrackEvent } from '../src/core/tracker.js';

function jwt(payload: Record<string, unknown>): string {
  const part = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${part}.signature`;
}

describe('privacy-safe ChatGPT plan usage helpers', () => {
  it('decodes only the exact namespaced plan claim and normalizes known plans', () => {
    const headers = new Headers({ authorization: `Bearer ${jwt({
      [CHATGPT_PLAN_CLAIM]: 'PLUS', email: 'secret@example.com', sub: 'user-secret', arbitrary: 'secret',
    })}` });
    expect(detectChatGptSubscription('https://chatgpt.com/backend-api/codex', headers)).toEqual({
      subscription: true, planKey: 'plus', planLabel: 'ChatGPT Plus',
      source: 'jwt_allowlisted_claim', confidence: 'high',
    });
    const detected = detectChatGptSubscription('https://chatgpt.com/backend-api/codex', headers)!;
    const persisted = JSON.stringify(toTrackEvent({
      method: 'POST', path: '/v1/responses', status: 200, durationMs: 1,
      chatgptSubscription: detected,
    }));
    expect(persisted).toContain('ChatGPT Plus');
    for (const secret of ['secret@example.com', 'user-secret', 'arbitrary', 'authorization', 'chatgpt-account-id']) {
      expect(persisted).not.toContain(secret);
    }
  });

  it('uses a safe generic label for unknown/missing claims and malformed JWTs fail closed', () => {
    expect(normalizePlan('future-plan')).toEqual({ planLabel: 'ChatGPT plan (type unavailable)' });
    const headers = new Headers({ authorization: `Bearer ${jwt({ plan_type: 'plus' })}` });
    expect(detectChatGptSubscription('https://chatgpt.com/backend-api/codex/', headers)).toMatchObject({
      planLabel: 'ChatGPT plan (type unavailable)', source: 'subscription_transport', confidence: 'medium',
    });
    expect(detectChatGptSubscription('https://chatgpt.com/backend-api/codex', new Headers({ authorization: 'Bearer nope' }))).toBeUndefined();
  });

  it('gates on subscription transport and does not classify API key traffic', () => {
    const headers = new Headers({ authorization: `Bearer ${jwt({ [CHATGPT_PLAN_CLAIM]: 'pro' })}` });
    expect(detectChatGptSubscription('https://api.openai.com/v1', headers)).toBeUndefined();
  });

  it('weights known tiers and fails closed on unknown tiers', () => {
    expect(planTierMultiplier('sol')).toBe(1);
    expect(planTierMultiplier('TERRA')).toBe(.5);
    expect(planTierMultiplier('luna')).toBe(.2);
    expect(planTierMultiplier('nova')).toBeUndefined();
    expect(planTierMultiplier(undefined)).toBeUndefined();
  });

  it('computes empirical percentage ranges', () => {
    const result = estimatePlanPercentages(1_300_000);
    expect(result.fiveHour.min).toBeCloseTo(1_300_000 / 203_000);
    expect(result.fiveHour.max).toBeCloseTo(1_300_000 / 185_000);
    expect(result.weekly).toEqual({ min: 1, max: 1_300_000 / 1_110_000 });
  });
});
