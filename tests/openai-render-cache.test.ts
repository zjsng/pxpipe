import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearOpenAIRenderCache,
  getOpenAIRenderCacheStats,
  renderOpenAITextCached,
} from '../src/core/openai-render-cache.js';

describe('OpenAI rendered-image cache', () => {
  beforeEach(() => clearOpenAIRenderCache());

  it('reuses byte-identical rendered pages for the same geometry and text', async () => {
    const text = 'stable rendered section '.repeat(4_000);
    const first = await renderOpenAITextCached(text, 152, 2624);
    const second = await renderOpenAITextCached(text, 152, 2624);

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.images).toBe(first.images);
    expect(second.savedRenderMs).toBe(first.renderMs);
    expect(getOpenAIRenderCacheStats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('does not reuse a render across text or geometry changes', async () => {
    const text = 'cache-key boundary '.repeat(1_000);
    const a = await renderOpenAITextCached(text, 152, 2624);
    const b = await renderOpenAITextCached(text + 'changed', 152, 2624);
    const c = await renderOpenAITextCached(text, 160, 2624);

    expect(a.cacheHit).toBe(false);
    expect(b.cacheHit).toBe(false);
    expect(c.cacheHit).toBe(false);
    expect(getOpenAIRenderCacheStats()).toMatchObject({ hits: 0, misses: 3 });
  });

  it('deduplicates concurrent renders of the same section', async () => {
    const text = 'concurrent immutable section '.repeat(4_000);
    const [a, b] = await Promise.all([
      renderOpenAITextCached(text, 152, 2624),
      renderOpenAITextCached(text, 152, 2624),
    ]);

    expect(a.images).toBe(b.images);
    expect([a.cacheHit, b.cacheHit].sort()).toEqual([false, true]);
    expect(getOpenAIRenderCacheStats()).toMatchObject({ hits: 1, misses: 1 });
  });
});
