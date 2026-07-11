import { afterEach, describe, expect, it } from 'vitest';
import { createProxy } from '../src/core/proxy.js';
import { applyGpt56RequestOptimizations } from '../src/core/openai.js';
import type { TransformInfo } from '../src/core/transform.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function captureForward(
  body: Record<string, unknown>,
  transform: Record<string, unknown> = {},
  path = '/responses',
  openAIUpstream = 'https://openai.test',
): Promise<Record<string, unknown>> {
  let forwarded = '';
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    forwarded = new TextDecoder().decode(init?.body as Uint8Array);
    return new Response(JSON.stringify({
      id: 'resp_test',
      model: body.model,
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const proxy = createProxy({
    openAIUpstream,
    transform: transform as never,
  });
  const response = await proxy(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  await response.arrayBuffer();
  return JSON.parse(forwarded) as Record<string, unknown>;
}

function findBreakpoint(req: Record<string, unknown>, collection: 'input' | 'messages'): unknown {
  for (const item of (req[collection] as Array<Record<string, unknown>>) ?? []) {
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content as Array<Record<string, unknown>>) {
      if (part.text === '[End of rendered GPT system/tool context.]') {
        return part.prompt_cache_breakpoint;
      }
    }
  }
  return undefined;
}

describe('GPT-5.6 API cost optimizations', () => {
  it('uses an explicit breakpoint and stable key for the compressed Responses slab', async () => {
    const out = await captureForward({
      model: 'gpt-5.6-sol',
      instructions: 'Stable coding-agent instruction. '.repeat(4_000),
      input: 'Fix the bug.',
    }, { minCompressChars: 1 });

    expect(out.prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(out.prompt_cache_key).toMatch(/^pxpipe:gpt56:[0-9a-f]{8}$/);
    expect(findBreakpoint(out, 'input')).toEqual({ mode: 'explicit' });
  });

  it('adds the same explicit slab policy to Chat Completions', async () => {
    const out = await captureForward({
      model: 'gpt-5.6-terra',
      messages: [
        { role: 'system', content: 'Stable coding-agent instruction. '.repeat(4_000) },
        { role: 'user', content: 'Fix the bug.' },
      ],
    }, { minCompressChars: 1 }, '/v1/chat/completions');

    expect(out.prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(findBreakpoint(out, 'messages')).toEqual({ mode: 'explicit' });
  });

  it('preserves caller cache routing and policy choices', async () => {
    const out = await captureForward({
      model: 'gpt-5.6-luna',
      prompt_cache_key: 'caller-key',
      prompt_cache_options: { mode: 'implicit', ttl: '30m' },
      instructions: 'Stable coding-agent instruction. '.repeat(4_000),
      input: 'Fix the bug.',
    }, { minCompressChars: 1 });

    expect(out.prompt_cache_key).toBe('caller-key');
    expect(out.prompt_cache_options).toEqual({ mode: 'implicit', ttl: '30m' });
    expect(findBreakpoint(out, 'input')).toEqual({ mode: 'explicit' });
  });

  it('can disable explicit prompt caching without disabling compression', async () => {
    const out = await captureForward({
      model: 'gpt-5.6',
      instructions: 'Stable coding-agent instruction. '.repeat(4_000),
      input: 'Fix the bug.',
    }, { minCompressChars: 1, gpt56PromptCaching: false });

    expect(out.prompt_cache_key).toBeUndefined();
    expect(out.prompt_cache_options).toBeUndefined();
    expect(findBreakpoint(out, 'input')).toBeUndefined();
    expect(JSON.stringify(out)).toContain('data:image/png;base64,');
  });

  it('does not send public explicit-cache fields to the ChatGPT Codex transport', async () => {
    const out = await captureForward({
      model: 'gpt-5.6-sol',
      prompt_cache_key: 'codex-native-key',
      include: ['reasoning.encrypted_content'],
      store: false,
      reasoning: { effort: 'high', context: 'all_turns' },
      instructions: 'Stable coding-agent instruction. '.repeat(4_000),
      input: 'Fix the bug.',
    }, { minCompressChars: 1 }, '/responses', 'https://chatgpt.com/backend-api/codex');

    expect(out.prompt_cache_key).toBe('codex-native-key');
    expect(out.prompt_cache_options).toBeUndefined();
    expect(findBreakpoint(out, 'input')).toBeUndefined();
    expect(out.reasoning).toEqual({ effort: 'high', context: 'all_turns' });
    expect(out.include).toEqual(['reasoning.encrypted_content']);
  });

  it('measures caller cache routing and encrypted reasoning without changing them', () => {
    const request = {
      model: 'gpt-5.6-luna',
      prompt_cache_key: 'codex-native-key',
      reasoning: { effort: 'max', context: 'all_turns' },
      input: [
        { type: 'reasoning', encrypted_content: 'encrypted-one', summary: [] },
        { type: 'reasoning', encrypted_content: 'encrypted-two', summary: [] },
        { role: 'user', content: 'Continue.' },
      ],
    };
    const body = new TextEncoder().encode(JSON.stringify(request));
    const info: TransformInfo = {
      compressed: true,
      origChars: 0,
      compressedChars: 0,
      imageCount: 0,
      imageBytes: 0,
      staticChars: 0,
      dynamicChars: 0,
      dynamicBlockCount: 0,
    };

    const out = applyGpt56RequestOptimizations(body, 'responses', {}, info, false);

    expect(out).toBe(body);
    expect(info).toMatchObject({
      gptReasoningItems: 2,
      gptEncryptedReasoningItems: 2,
      gptEncryptedReasoningBytes: 26,
      gptReasoningEffort: 'max',
      gptReasoningContext: 'all_turns',
      gptPromptCacheKeyPresent: true,
    });
    expect(info.gptReasoningBytes).toBeGreaterThan(26);
    expect(info.gptPromptCacheKeyFingerprint)
      .toMatch(/^fnv-[0-9a-f]{8}-16$/);
  });

  it('opts an existing previous_response_id chain into persisted reasoning', async () => {
    const out = await captureForward({
      model: 'gpt-5.6-sol',
      previous_response_id: 'resp_previous',
      reasoning: { effort: 'low' },
      input: 'Continue the same task.',
    }, { gpt56PersistedReasoning: true });

    expect(out.reasoning).toEqual({ effort: 'low', context: 'all_turns' });
  });

  it('does not invent state or override the caller reasoning context', async () => {
    const stateless = await captureForward({
      model: 'gpt-5.6-sol',
      reasoning: { effort: 'low' },
      input: 'A new task.',
    }, { gpt56PersistedReasoning: true });
    expect(stateless.reasoning).toEqual({ effort: 'low' });

    const callerControlled = await captureForward({
      model: 'gpt-5.6-sol',
      previous_response_id: 'resp_previous',
      reasoning: { effort: 'low', context: 'current_turn' },
      input: 'The goal changed.',
    }, { gpt56PersistedReasoning: true });
    expect(callerControlled.reasoning).toEqual({ effort: 'low', context: 'current_turn' });
  });

  it('keeps compress:false byte-for-byte even when reasoning is enabled', async () => {
    const original = {
      model: 'gpt-5.6-sol',
      previous_response_id: 'resp_previous',
      input: 'Continue.',
    };
    const out = await captureForward(original, {
      compress: false,
      gpt56PersistedReasoning: true,
    });
    expect(out).toEqual(original);
  });
});
