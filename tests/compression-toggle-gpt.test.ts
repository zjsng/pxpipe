/**
 * Runtime compression kill-switch regression for the OpenAI Responses path.
 * The client remains connected to pxpipe in passthrough mode, but the outbound
 * request body must be byte-for-byte identical and contain no injected images.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProxy } from '../src/core/proxy.js';
import type { ProxyEvent } from '../src/core/proxy.js';
import { DashboardState } from '../src/dashboard.js';

const realFetch = globalThis.fetch;
const originalModels = process.env.PXPIPE_MODELS;

beforeEach(() => {
  // GPT-family compression is opt-in. Enable the test model so this suite
  // exercises the runtime switch rather than the applicability gate.
  process.env.PXPIPE_MODELS = 'gpt-5.6';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (originalModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = originalModels;
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
    let observedEvent: ProxyEvent | undefined;
    const proxy = createProxy({
      openAIUpstream: 'https://openai.example.test',
      transform: () => dashboard.getCompressionEnabled()
        ? { minCompressChars: 1 }
        : { compress: false, compressionDisableSource: 'dashboard' },
      onRequest: (event) => { observedEvent = event; },
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
    expect(observedEvent?.info?.eligibleButUncompressed).toBe(true);
    expect(observedEvent?.info?.compressionDisableSource).toBe('dashboard');
  });

  it('classifies an unlabelled explicit disable as request-level', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      model: 'gpt-5.6', output: [], usage: { input_tokens: 1, output_tokens: 1 },
    }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;

    let observedEvent: ProxyEvent | undefined;
    const proxy = createProxy({
      openAIUpstream: 'https://openai.example.test',
      transform: { compress: false },
      onRequest: (event) => { observedEvent = event; },
    });
    const response = await proxy(new Request('http://localhost/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer fake-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: 'hello' }),
    }));
    await response.arrayBuffer();

    expect(observedEvent?.info?.eligibleButUncompressed).toBe(true);
    expect(observedEvent?.info?.compressionDisableSource).toBe('request');
  });

  it('does not mark unsupported models eligible', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      model: 'gpt-4.1', output: [], usage: { input_tokens: 1, output_tokens: 1 },
    }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;

    let observedEvent: ProxyEvent | undefined;
    const proxy = createProxy({
      openAIUpstream: 'https://openai.example.test',
      transform: { compress: false, compressionDisableSource: 'dashboard' },
      onRequest: (event) => { observedEvent = event; },
    });
    const response = await proxy(new Request('http://localhost/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer fake-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4.1', input: 'hello' }),
    }));
    await response.arrayBuffer();

    expect(observedEvent?.info?.eligibleButUncompressed).toBeUndefined();
    expect(observedEvent?.info?.compressionDisableSource).toBeUndefined();
    expect(observedEvent?.info?.reason).toBe('unsupported_model');
  });
});
