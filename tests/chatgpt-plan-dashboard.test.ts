import { describe, expect, it } from 'vitest';
import { DashboardState } from '../src/dashboard.js';
import { renderHeaderFragment } from '../src/dashboard/fragments.js';
import type { StatsPayload } from '../src/dashboard/types.js';
import type { ProxyEvent } from '../src/core/proxy.js';

async function stats(dash: DashboardState): Promise<StatsPayload> {
  return await dash.serveStats().json() as StatsPayload;
}

function measuredEvent(subscription: boolean): ProxyEvent {
  return {
    method: 'POST', path: '/v1/responses', model: 'gpt-5.6-luna', serviceTier: 'luna',
    status: 200, durationMs: 10,
    usage: { input_tokens: 500, output_tokens: 10 } as ProxyEvent['usage'],
    info: { compressed: true, imageTokens: 100, baselineImagedTokens: 600 } as NonNullable<ProxyEvent['info']>,
    ...(subscription ? { chatgptSubscription: {
      subscription: true as const, planKey: 'plus' as const, planLabel: 'ChatGPT Plus',
      source: 'jwt_allowlisted_claim' as const, confidence: 'high' as const,
    } } : {}),
  };
}

describe('ChatGPT plan dashboard card', () => {
  it('is present only for subscription traffic and labels estimates honestly', async () => {
    const dash = new DashboardState();
    dash.update(measuredEvent(true));
    const payload = await stats(dash);
    expect(payload.chatgpt_plan_usage).toMatchObject({
      plan_label: 'ChatGPT Plus', plan_weighted_savings: 100,
      calibration_source: 'empirical_transcript_range',
    });
    const html = renderHeaderFragment(payload, 7777);
    expect(html).toContain('Estimated plan usage preserved');
    expect(html).toContain('Cumulative across logged and reset windows; not your current remaining balance');
    expect(html).toContain('not an official quota');
    expect(html).not.toMatch(/\$[^<]*plan usage/i);
  });

  it('is absent for API-key/non-subscription traffic', async () => {
    const dash = new DashboardState();
    dash.update(measuredEvent(false));
    const payload = await stats(dash);
    expect(payload.chatgpt_plan_usage).toBeUndefined();
    expect(renderHeaderFragment(payload, 7777)).not.toContain('Estimated plan usage preserved');
  });
});
