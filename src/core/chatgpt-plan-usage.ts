/** Privacy-safe ChatGPT subscription detection and plan-usage estimation. */

export const CHATGPT_PLAN_CLAIM = 'https://api.openai.com/auth.chatgpt_plan_type';

export interface ChatGptSubscription {
  subscription: true;
  planKey?: 'plus' | 'pro' | 'team' | 'business' | 'enterprise' | 'edu';
  planLabel: string;
  source: 'jwt_allowlisted_claim' | 'subscription_transport';
  confidence: 'high' | 'medium';
}

const PLANS: Record<string, Pick<ChatGptSubscription, 'planKey' | 'planLabel'>> = {
  plus: { planKey: 'plus', planLabel: 'ChatGPT Plus' },
  pro: { planKey: 'pro', planLabel: 'ChatGPT Pro' },
  team: { planKey: 'team', planLabel: 'ChatGPT Team' },
  business: { planKey: 'business', planLabel: 'ChatGPT Business' },
  enterprise: { planKey: 'enterprise', planLabel: 'ChatGPT Enterprise' },
  edu: { planKey: 'edu', planLabel: 'ChatGPT Edu' },
};

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export function normalizePlan(value: unknown): Pick<ChatGptSubscription, 'planKey' | 'planLabel'> {
  if (typeof value !== 'string') return { planLabel: 'ChatGPT plan (type unavailable)' };
  const known = PLANS[value.trim().toLowerCase()];
  return known ?? { planLabel: 'ChatGPT plan (type unavailable)' };
}

/** Returns only allowlisted, normalized data. The token and payload never escape. */
export function detectChatGptSubscription(
  upstreamBase: string,
  headers: Headers,
): ChatGptSubscription | undefined {
  let url: URL;
  try { url = new URL(upstreamBase); } catch { return undefined; }
  if (url.hostname.toLowerCase() !== 'chatgpt.com' || !url.pathname.startsWith('/backend-api/codex')) {
    return undefined;
  }
  const auth = headers.get('authorization')?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  // A subscription route without subscription bearer auth is not enough to
  // classify API-key traffic. JWT shape is the fail-closed discriminator.
  if (!auth || auth.split('.').length !== 3) return undefined;
  const payload = decodeJwtPayload(auth);
  const hasClaim = payload && Object.prototype.hasOwnProperty.call(payload, CHATGPT_PLAN_CLAIM);
  const normalized = normalizePlan(payload?.[CHATGPT_PLAN_CLAIM]);
  return {
    subscription: true,
    ...normalized,
    source: hasClaim ? 'jwt_allowlisted_claim' : 'subscription_transport',
    confidence: hasClaim ? 'high' : 'medium',
  };
}

export const PLAN_TIER_MULTIPLIERS = { sol: 1, terra: 0.5, luna: 0.2 } as const;

export function planTierMultiplier(tier: string | undefined): number | undefined {
  if (!tier) return undefined;
  return PLAN_TIER_MULTIPLIERS[tier.trim().toLowerCase() as keyof typeof PLAN_TIER_MULTIPLIERS];
}

export interface EstimateRange { min: number; max: number }

export function estimatePlanPercentages(planWeightedSavings: number): {
  fiveHour: EstimateRange; weekly: EstimateRange;
} {
  const saved = Math.max(0, planWeightedSavings);
  // Empirical, user-specific transcript calibration; deliberately not inferred
  // from plan name because OpenAI's plan allowances are dynamic/unpublished.
  return {
    fiveHour: { min: saved / 203_000, max: saved / 185_000 },
    weekly: { min: saved / 1_300_000, max: saved / 1_110_000 },
  };
}
