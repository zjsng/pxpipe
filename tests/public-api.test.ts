import { describe, expect, it } from 'vitest';
import {
  buildCountTokensBodies,
  isPixelpipeSupportedModel,
  shouldTransformAnthropicMessages,
  transformAnthropicMessages,
} from '../src/core/index.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('public library API', () => {
  it('recognizes Opus 4.7 and only Opus 4.7 as supported', () => {
    expect(isPixelpipeSupportedModel('claude-opus-4-7')).toBe(true);
    expect(isPixelpipeSupportedModel('claude-opus-4-7-high')).toBe(true);
    expect(isPixelpipeSupportedModel('claude-opus-4-6')).toBe(false);
    expect(isPixelpipeSupportedModel('claude-sonnet-4-5')).toBe(false);
    expect(isPixelpipeSupportedModel(null)).toBe(false);
  });

  it('reports applicability with route/method/body gates', () => {
    expect(shouldTransformAnthropicMessages({
      model: 'claude-opus-4-7',
      method: 'POST',
      path: '/v1/messages',
      bodyBytes: 10,
    })).toEqual({ eligible: true, reason: 'eligible' });
    expect(shouldTransformAnthropicMessages({
      model: 'claude-opus-4-7',
      method: 'GET',
      path: '/v1/messages',
      bodyBytes: 10,
    }).reason).toBe('unsupported_method');
    expect(shouldTransformAnthropicMessages({
      model: 'claude-opus-4-7',
      method: 'POST',
      path: '/v1/messages/count_tokens',
      bodyBytes: 10,
    }).reason).toBe('unsupported_path');
  });

  it('builds count_tokens probe bodies from a messages body', () => {
    const body = enc.encode(JSON.stringify({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      stream: true,
      system: [{ type: 'text', text: 'sys' }],
      tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'cached', cache_control: { type: 'ephemeral', ttl: '1h' } },
            { type: 'text', text: 'tail' },
          ],
        },
      ],
    }));

    const probes = buildCountTokensBodies(body);
    expect(probes.fullBody).toBeInstanceOf(Uint8Array);
    const full = JSON.parse(dec.decode(probes.fullBody!)) as Record<string, unknown>;
    expect(full.model).toBe('claude-opus-4-7');
    expect(full.max_tokens).toBeUndefined();
    expect(full.stream).toBeUndefined();
    expect(Array.isArray(full.messages)).toBe(true);

    expect(probes.cacheablePrefixBody).toBeInstanceOf(Uint8Array);
    const prefix = JSON.parse(dec.decode(probes.cacheablePrefixBody!)) as { messages: Array<{ content: unknown }> };
    const last = prefix.messages.at(-1)!;
    expect(Array.isArray(last.content)).toBe(true);
    expect((last.content as unknown[])).toHaveLength(1);
  });

  it('wraps the transformer with model gating and cache ownership metadata', async () => {
    const unsupported = enc.encode(JSON.stringify({
      model: 'claude-opus-4-6',
      system: 'x'.repeat(20_000),
      messages: [{ role: 'user', content: 'hello' }],
    }));
    const skipped = await transformAnthropicMessages({ body: unsupported, model: 'claude-opus-4-6' });
    expect(skipped.applied).toBe(false);
    expect(skipped.reason).toBe('unsupported_model');
    expect(skipped.body).toBe(unsupported);

    const supported = enc.encode(JSON.stringify({
      model: 'claude-opus-4-7',
      system: 'Important system instruction. '.repeat(1200),
      tools: [{
        name: 'read_file',
        description: 'Read a file from disk. '.repeat(200),
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }],
      messages: [{ role: 'user', content: 'hello' }],
    }));
    const transformed = await transformAnthropicMessages({ body: supported, model: 'claude-opus-4-7' });
    expect(transformed.applied).toBe(true);
    expect(transformed.reason).toBe('applied');
    expect(transformed.info.compressedChars).toBeGreaterThan(0);
    expect(transformed.info.imageCount).toBeGreaterThan(0);
    expect(transformed.cache.ownsCacheControl).toBe(true);
    expect(transformed.cache.markerCount).toBeGreaterThan(0);
  });
});
