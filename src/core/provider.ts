/** Provider and model helpers shared by telemetry, accounting, and the dashboard.
 *
 * The proxy supports more than one API family.  Keeping this classification in
 * one small, dependency-free module prevents a `/responses` row from being
 * accidentally priced with Anthropic's cache rates (the original dashboard
 * failure mode).
 */

export type ProviderId = 'anthropic' | 'openai' | 'other';

/** Return the pathname without a query string. */
export function cleanPath(path: string | undefined): string {
  if (!path) return '';
  const i = path.indexOf('?');
  return i >= 0 ? path.slice(0, i) : path;
}

/** Classify an event from its route first, then its model as a fallback. */
export function providerForPath(
  path: string | undefined,
  model?: string,
): ProviderId {
  const p = cleanPath(path);
  if (
    p === '/v1/messages'
    || p === '/anthropic/messages'
    || p === '/anthropic/v1/messages'
    || p.endsWith('/messages/count_tokens')
  ) return 'anthropic';
  if (
    p === '/responses'
    || p === '/v1/responses'
    || p.startsWith('/v1/responses/')
    || p === '/openai/responses'
    || p === '/openai/v1/responses'
    || p === '/v1/chat/completions'
    || p === '/openai/v1/chat/completions'
    // OpenAI-compatible model discovery has no model in the event.  `/models`
    // is the subscription Codex route; `/v1/models` is the public route.
    || p === '/models'
    || p.startsWith('/models/')
    || p === '/v1/models'
    || p.startsWith('/v1/models/')
  ) return 'openai';
  const m = (model ?? '').toLowerCase();
  if (/^(?:gpt|o[134]|codex)/.test(m)) return 'openai';
  if (/^claude/.test(m)) return 'anthropic';
  return 'other';
}

export function isOpenAIPath(path: string | undefined, model?: string): boolean {
  return providerForPath(path, model) === 'openai';
}

export function isAnthropicPath(path: string | undefined, model?: string): boolean {
  return providerForPath(path, model) === 'anthropic';
}

/** Make service-tier names readable without losing the exact model id. */
export function serviceTierFor(
  model?: string,
  reported?: string,
): string | undefined {
  if (reported && reported.trim()) return reported.trim();
  const m = model?.match(/(?:^|-)(sol|terra|luna)(?:-|$)/i);
  return m?.[1]?.toLowerCase();
}

export function providerLabel(provider: ProviderId): string {
  switch (provider) {
    case 'anthropic': return 'Claude / Anthropic';
    case 'openai': return 'GPT / OpenAI';
    default: return 'Other provider';
  }
}
