/**
 * Helpers for measuring the uncompressed Anthropic Messages counterfactual.
 *
 * These are pure body-shaping utilities: no fetch, no auth, no Node APIs.
 * Hosts such as ocproxy can use them to run shadow /v1/messages/count_tokens
 * probes with their own transport/auth while pixelpipe transforms the real
 * request body.
 */

export interface CountTokensBodies {
  /** Full original body, filtered to the strict count_tokens parameter set. */
  readonly fullBody: Uint8Array | null;
  /** Original body truncated at the latest cache_control marker, or null when no marker exists. */
  readonly cacheablePrefixBody: Uint8Array | null;
}

/** /v1/messages/count_tokens accepts a strict subset of /v1/messages params.
 * Anything else (`stream`, `max_tokens`, `temperature`, `top_p`, `top_k`,
 * `stop_sequences`, `metadata`, `service_tier`) makes it 400 with
 * "Unknown parameter". Strip the verbatim body to the accepted fields.
 * Returns null if the body can't be parsed or is missing required fields. */
const COUNT_TOKENS_FIELDS = new Set([
  'model',
  'messages',
  'system',
  'tools',
  'tool_choice',
  'thinking',
  'mcp_servers',
]);

type BytesLike = Uint8Array | ArrayBuffer | ArrayBufferView;

function toUint8Array(bytes: BytesLike): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function buildCountTokensBodies(bytes: BytesLike): CountTokensBodies {
  const b = toUint8Array(bytes);
  return {
    fullBody: buildBaselineCountTokensBody(b),
    cacheablePrefixBody: buildCacheablePrefixCountTokensBody(b),
  };
}

export function buildBaselineCountTokensBody(bytes: BytesLike): Uint8Array | null {
  const b = toUint8Array(bytes);
  try {
    const obj = JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      if (COUNT_TOKENS_FIELDS.has(k)) out[k] = obj[k];
    }
    if (typeof out.model !== 'string' || !Array.isArray(out.messages)) return null;
    return new TextEncoder().encode(JSON.stringify(out));
  } catch {
    return null;
  }
}

/** Type guard for content blocks that may carry a cache_control marker.
 * Anthropic accepts `cache_control` on: any system block, any message
 * content block, any tool definition. We don't care about the marker's
 * value — only its presence/position. */
function hasCacheControl(x: unknown): boolean {
  return (
    typeof x === 'object'
    && x !== null
    && (x as { cache_control?: unknown }).cache_control != null
  );
}

/** Build a body that contains EXACTLY the tokens forming the longest
 * cacheable prefix on the unproxied path — everything up to and INCLUDING
 * the last `cache_control` marker in the original request, with everything
 * after that marker stripped. count_tokens on this body returns
 * `cacheable_prefix_tokens`; subtracting from the full count_tokens gives
 * `cold_tail_tokens` (always-cold input on both proxied and unproxied paths).
 *
 * Anthropic's cache-traversal order is tools → system → messages. We walk
 * messages first (latest), then system, then tools — the FIRST one we find
 * a marker in (walking backward) is the latest in cache order. Everything
 * after that marker in the same section is dropped; later sections are
 * dropped wholesale.
 *
 * Returns null when the original body has zero `cache_control` markers
 * anywhere — caller treats that as `cacheable_prefix_tokens = 0`. */
export function buildCacheablePrefixCountTokensBody(bytes: BytesLike): Uint8Array | null {
  const b = toUint8Array(bytes);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof obj.model !== 'string') return null;

  const system = obj.system;
  const messages = obj.messages;
  const tools = obj.tools;

  let truncated: Record<string, unknown> | null = null;
  if (Array.isArray(messages)) {
    for (let mi = messages.length - 1; mi >= 0 && truncated == null; mi--) {
      const msg = messages[mi] as { role?: unknown; content?: unknown };
      const content = msg?.content;
      if (Array.isArray(content)) {
        for (let bi = content.length - 1; bi >= 0; bi--) {
          if (hasCacheControl(content[bi])) {
            const truncatedMsg = { ...msg, content: content.slice(0, bi + 1) };
            const truncatedMessages = messages.slice(0, mi).concat([truncatedMsg]);
            truncated = {
              model: obj.model,
              messages: truncatedMessages,
            };
            if (system !== undefined) truncated.system = system;
            if (tools !== undefined) truncated.tools = tools;
            break;
          }
        }
      } else if (hasCacheControl(msg)) {
        truncated = {
          model: obj.model,
          messages: messages.slice(0, mi + 1),
        };
        if (system !== undefined) truncated.system = system;
        if (tools !== undefined) truncated.tools = tools;
      }
    }
  }

  if (truncated == null && Array.isArray(system)) {
    for (let si = system.length - 1; si >= 0; si--) {
      if (hasCacheControl(system[si])) {
        truncated = {
          model: obj.model,
          system: system.slice(0, si + 1),
          messages: [{ role: 'user', content: 'x' }],
        };
        if (tools !== undefined) truncated.tools = tools;
        break;
      }
    }
  }

  if (truncated == null && Array.isArray(tools)) {
    for (let ti = tools.length - 1; ti >= 0; ti--) {
      if (hasCacheControl(tools[ti])) {
        truncated = {
          model: obj.model,
          tools: tools.slice(0, ti + 1),
          messages: [{ role: 'user', content: 'x' }],
        };
        break;
      }
    }
  }

  if (truncated == null) return null;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(truncated)) {
    if (COUNT_TOKENS_FIELDS.has(k)) out[k] = truncated[k];
  }
  return new TextEncoder().encode(JSON.stringify(out));
}

/** Count cache_control markers anywhere in a JSON-ish Anthropic Messages body. */
export function countCacheControlMarkers(bytes: BytesLike): number {
  const b = toUint8Array(bytes);
  try {
    return countCacheControlValue(JSON.parse(new TextDecoder().decode(b)));
  } catch {
    return 0;
  }
}

function countCacheControlValue(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  let n = hasCacheControl(value) ? 1 : 0;
  if (Array.isArray(value)) {
    for (const item of value) n += countCacheControlValue(item);
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) {
      n += countCacheControlValue(item);
    }
  }
  return n;
}
