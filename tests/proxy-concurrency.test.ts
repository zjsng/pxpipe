import { afterEach, describe, expect, it } from 'vitest';
import { createProxy } from '../src/core/proxy.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function request(id: number): Request {
  return new Request('http://localhost/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify({ model: 'unsupported-test-model', input: `request ${id}`, stream: true }),
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('timed out waiting for test condition');
}

describe('OpenAI upstream concurrency gate', () => {
  it('holds queued requests until an active response body reaches EOF', async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.push(controller);
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    const events: Array<{ queueMs?: number; upstreamConcurrency?: number; queueDepth?: number }> = [];
    const proxy = createProxy({
      openAIUpstream: 'http://openai.test',
      openAIConcurrency: 2,
      onRequest: (event) => { events.push(event); },
    });

    const first = proxy(request(1));
    const second = proxy(request(2));
    const third = proxy(request(3));
    await waitFor(() => fetches === 2);

    expect(fetches).toBe(2);
    const firstResponse = await first;
    await second;
    controllers[0]!.close();
    await firstResponse.text();

    const thirdResponse = await third;
    expect(fetches).toBe(3);
    controllers[1]!.close();
    controllers[2]!.close();
    await thirdResponse.text();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toHaveLength(3);
    expect(events.some((event) => (event.queueDepth ?? 0) >= 1)).toBe(true);
    expect(events.every((event) => (event.upstreamConcurrency ?? 0) <= 2)).toBe(true);
  });

  it('does not gate model discovery requests', async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const proxy = createProxy({
      openAIUpstream: 'http://openai.test',
      openAIConcurrency: 1,
    });

    await Promise.all([
      proxy(new Request('http://localhost/models', { headers: { authorization: 'Bearer test' } })),
      proxy(new Request('http://localhost/models', { headers: { authorization: 'Bearer test' } })),
    ]);
    expect(fetches).toBe(2);
  });
});
