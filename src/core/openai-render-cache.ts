/**
 * Bounded process-local cache for deterministic GPT text renders.
 *
 * Frozen history sections and the static system/tool slab are byte-identical
 * across many requests, but PNG encoding is CPU-heavy. Cache the immutable
 * RenderedImage arrays by full SHA-256(text + geometry), including in-flight
 * promises so concurrent requests do not render the same section twice.
 */

import { renderTextToPngs, type RenderedImage, type RenderStyle } from './render.js';

const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const KEY_VERSION = 'gpt-render-v1';

interface CacheValue {
  images: RenderedImage[];
  renderMs: number;
  bytes: number;
}

interface CacheEntry {
  promise: Promise<CacheValue>;
  bytes: number;
}

export interface CachedOpenAIRender {
  images: RenderedImage[];
  cacheHit: boolean;
  renderMs: number;
  /** Measured render time from the original miss, avoided by this cache hit. */
  savedRenderMs: number;
}

const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;
let hits = 0;
let misses = 0;
let evictions = 0;

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function fallbackHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnv-${(h >>> 0).toString(16).padStart(8, '0')}-${s.length}`;
}

async function cacheKey(text: string, cols: number, maxHeightPx: number, style: RenderStyle): Promise<string> {
  const source = `${KEY_VERSION}\0${cols}\0${maxHeightPx}\0${JSON.stringify(style)}\0${text}`;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fallbackHash(source);
  const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(source)));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function touch(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
}

function evictToLimit(): void {
  while (cacheBytes > MAX_CACHE_BYTES && cache.size > 0) {
    const oldest = cache.entries().next().value as [string, CacheEntry] | undefined;
    if (!oldest) break;
    cache.delete(oldest[0]);
    cacheBytes -= oldest[1].bytes;
    evictions++;
  }
}

export async function renderOpenAITextCached(
  text: string,
  cols: number,
  maxHeightPx: number,
  style: RenderStyle = {},
): Promise<CachedOpenAIRender> {
  const key = await cacheKey(text, cols, maxHeightPx, style);
  const existing = cache.get(key);
  if (existing) {
    hits++;
    touch(key, existing);
    const value = await existing.promise;
    return {
      images: value.images,
      cacheHit: true,
      renderMs: value.renderMs,
      savedRenderMs: value.renderMs,
    };
  }

  misses++;
  const entry: CacheEntry = {
    bytes: 0,
    promise: Promise.resolve({ images: [], renderMs: 0, bytes: 0 }),
  };
  entry.promise = (async () => {
    const started = nowMs();
    const images = await renderTextToPngs(text, cols, style, maxHeightPx);
    const renderMs = Math.max(0, Math.round(nowMs() - started));
    const bytes = images.reduce((sum, image) => sum + image.png.byteLength, 0);
    entry.bytes = bytes;
    cacheBytes += bytes;
    evictToLimit();
    return { images, renderMs, bytes };
  })().catch((error) => {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  });
  cache.set(key, entry);

  const value = await entry.promise;
  return {
    images: value.images,
    cacheHit: false,
    renderMs: value.renderMs,
    savedRenderMs: 0,
  };
}

export function getOpenAIRenderCacheStats(): {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
} {
  return { entries: cache.size, bytes: cacheBytes, hits, misses, evictions };
}

/** Test and lifecycle hook; a process restart naturally clears the same state. */
export function clearOpenAIRenderCache(): void {
  cache.clear();
  cacheBytes = 0;
  hits = 0;
  misses = 0;
  evictions = 0;
}
