/**
 * Compare GPT frozen-history section sizes against a tool-heavy Codex-shaped
 * transcript. Run with:
 *   pnpm tsx eval/benchmark-gpt-history-sections.ts
 */

import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { planGptCollapse, type HistoryTurn } from '../src/core/openai-history.js';
import { openAIVisionTokens } from '../src/core/openai.js';
import { clearOpenAIRenderCache } from '../src/core/openai-render-cache.js';

const SECTION_SIZES = [2_000, 4_000, 6_000, 8_000, 12_000];
const MODEL = 'gpt-5.6-luna';

function tokenSizedText(target: number, index: number): string {
  const row = `{"turn":${index},"path":"/workspace/src/dashboard.ts","status":"changed","detail":"render cache telemetry benchmark"}\n`;
  let text = `<tool_result id="bench-${index}">\n`;
  while (countTokens(text) < target) text += row;
  return text + '</tool_result>';
}

function observedShape(): HistoryTurn[] {
  // Four compact agent/tool turns followed by one large tool result approximates
  // the live 75-turn / ~79k-token session that sealed into ~15 sections.
  return Array.from({ length: 75 }, (_, i) => ({
    text: tokenSizedText(i % 5 === 4 ? 4_000 : 250, i),
    openIds: [],
    closeIds: [],
    opaque: false,
  }));
}

const turns = observedShape();
const transcriptTokens = turns.reduce((sum, turn) => sum + countTokens(turn.text), 0);
const results: Array<Record<string, number>> = [];

for (const sectionTokens of SECTION_SIZES) {
  clearOpenAIRenderCache();
  const started = performance.now();
  const plan = await planGptCollapse(turns, 0, () => true, {
    keepTail: 0,
    collapseChunk: 0,
    minCollapsePrefix: 1,
    minCollapseTokens: 1,
    sectionTokens,
    maxImages: 100,
    maxHeightPx: 2624,
  });
  const images = [...plan.images, ...plan.imagesAfter];
  results.push({
    section_tokens: sectionTokens,
    transcript_tokens: transcriptTokens,
    collapsed_tokens: countTokens(plan.text),
    images: images.length,
    image_tokens: images.reduce(
      (sum, image) => sum + openAIVisionTokens(MODEL, image.width, image.height),
      0,
    ),
    png_bytes: images.reduce((sum, image) => sum + image.png.byteLength, 0),
    render_ms: Math.round(performance.now() - started),
  });
}

console.table(results);
