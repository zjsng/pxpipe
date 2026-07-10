/**
 * Runtime compression kill-switch regression for the OpenAI Responses path.
 * The client remains connected to pxpipe in passthrough mode, but the outbound
 * request body must be byte-for-byte identical and contain no injected images.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createProxy } from '../src/core/proxy.js';
import { DashboardState } from '../src/dashboard.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('dashboard compression toggle — GPT Responses', () => {
  it('forwards the original GPT request body unchanged when compression is disabled', async () => {
    const dashboard = new DashboardState();
    dashboard.handleCompressionToggle({ enabled: false });

    let upstreamBody = '';
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBody = typeof init?.body === 'string'
        ? init.body
        : new TextDecoder().decode(init?.body as Uint8Array);
      return new Response(JSON.stringify({
        model: 'gpt-5.6',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const originalBody = JSON.stringify({
      model: 'gpt-5.6',
      instructions: 'Large system instruction. '.repeat(2_000),
      input: 'Answer this request.',
    });
    const proxy = createProxy({
      openAIUpstream: 'https://openai.example.test',
      transform: () => dashboard.getCompressionEnabled()
        ? { minCompressChars: 1 }
        : { compress: false },
    });

    const response = await proxy(new Request('http://localhost/responses', {
      method: 'POST',
      headers: {
        authorization: 'Bearer fake-key',
        'content-type': 'application/json',
      },
      body: originalBody,
    }));
    await response.arrayBuffer();

    expect(upstreamBody).toBe(originalBody);
    expect(upstreamBody).not.toContain('data:image/png;base64,');
  });
});
