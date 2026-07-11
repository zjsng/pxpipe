# GPT 5.6 plan-usage audit — 2026-07-11

## Result

The available Codex transcripts do **not** show GPT 5.6 using the plan at twice
GPT 5.5's rate after applying the current Codex credit card to each resolved
Sol/Terra/Luna response.

| Metric | GPT 5.5 | GPT 5.6 family | 5.6 vs 5.5 |
|---|---:|---:|---:|
| sessions with measured usage | 282 | 23 | — |
| API responses | 21,394 | 1,052 | — |
| raw input / response | 115,415 | 101,741 | −11.8% |
| cached share of input | 94.9% | 94.1% | −0.7 pp |
| Codex credits / response | 2.404 | 2.075 | −13.7% |
| model calls / Codex turn | 13.6 | 17.2 | **+26.5%** |
| Codex credits / turn | 32.7 | 35.8 | **+9.5%** |

The current official rate card prices Sol exactly like GPT 5.5 (125 / 12.5 /
750 credits per million uncached-input / cached-input / output tokens). Terra is
half that rate and Luna one-fifth. Reasoning tokens are part of output, not an
additional bucket. The observed family mix was 920 Sol, 95 Terra, and 37 Luna
responses, so grouping all three at Sol's rate would overstate usage.

Official references: [Codex pricing](https://learn.chatgpt.com/docs/pricing#what-are-tokens-and-credits)
and [image-input tokenization](https://developers.openai.com/api/docs/guides/images-vision#calculating-costs).

The closest observable plan-limit comparison also rejects the 2× hypothesis:

- GPT 5.6: one five-hour window moved 48 percentage points while the captured
  traffic used 8.88M price-weighted tokens, or about **185k tokens per point**.
- Recent GPT 5.5: six high-utilization five-hour windows used about **203k
  tokens per point** in aggregate.
- The weekly samples were similarly close: about **1.11M tokens per point** for
  GPT 5.6 versus **1.30M** for the closest recent GPT 5.5 window.

GPT 5.6 therefore appeared to move the meter roughly 10–17% faster per Codex
turn in these samples, not 100% faster. The quota evidence points primarily to
more model calls per turn; GPT-5.6 cache-write pricing is tracked separately in
the follow-up below. Whole-percentage reporting, concurrent agents,
and auto-review traffic make exact limit-window comparisons noisy.

## What is burning usage

Across all pre-audit GPT 5.6 responses:

- 107.03M raw input tokens were sent, of which 100.77M were cached.
- Current Codex rates price that traffic at about 2,183 credits.
- Reasoning tokens were 34.1% of output, versus 26.4% on GPT 5.5. This is a
  model/client-effort lever, not something pxpipe can safely remove.
- The 23 GPT 5.6 sessions made 1,052 model calls in 3h36m. Several
  concurrent agent runs dominate the total; the largest single transcript made
  210 calls and accounted for 29% of GPT 5.6's measured token-equivalent usage.

The proxied subset exposes the main pxpipe defect:

| pxpipe telemetry, 459 GPT 5.6 calls | Observed |
|---|---:|
| actual plan usage | 828.8 credits |
| estimated text-only counterfactual | 1,090.1 credits |
| existing pxpipe saving | 261.2 credits (24.0%) |
| `history_reason=prefix_too_short` | 428 (93.2%) |
| `history_reason=not_profitable` | 31 (6.8%) |
| successful history collapses | **0** |

The static system/tool slab was already helpful, but every old transcript prefix
continued to be resent as text. The false negatives came from three concrete
implementation issues:

1. The GPT gate estimated every partial page as a full 1,932 px image and reused
   Anthropic page-count geometry.
2. Reflowed `↵` markers were counted as physical row breaks even though the GPT
   renderer treats them as inline glyphs.
3. A hard ten-item minimum blocked one very large closed tool result even when
   it was well above the token and profitability floors.

The GPT tool image also duplicated content that remained native: top-level tool
descriptions and the JSON Schema skeleton were rendered while still being sent
in `tools[]`. That spent image patches without replacing text tokens and made
the image prefix churn when agent tool menus changed.

## Optimizations applied

- Price GPT pages from the renderer's actual wrapped lines, character cap, final
  partial-page height, and the exact o200k count of the text being replaced.
- Apply GPT 5.6's documented `detail: original` behavior: original 32px patch
  count with no resize/cap, using a patch-aligned 768×2624 full-page geometry.
- Let the existing token floor and closed-tool boundary govern history collapse;
  lower the redundant item-count floor from ten to one.
- Render only schema annotations actually stripped from native tool definitions.
  Keep tool names, top-level descriptions, types, properties, required fields,
  and enums native and lossless.
- Record the model returned by the upstream response so Sol, Terra, and Luna can
  be compared separately instead of inheriting the requested alias.
- Route authenticated `/models` and `/models/:id` requests to the OpenAI
  upstream, matching the endpoint shape used by Codex model discovery.

These changes target input usage only. pxpipe should not force a lower reasoning
effort or alter agent orchestration because those are product-quality choices.

## Measurement method and caveats

The audit scanned 631 unique JSONL rollouts (871 MB) present when analysis
started under
`~/.codex/sessions` and `~/.codex/archived_sessions`. Each usage event was
assigned to the latest `turn_context.model`. Duplicate/stale token snapshots
were removed by differencing `total_token_usage`; counter resets began a new
segment. Model ids `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` were
grouped as GPT 5.6.

The comparison is frozen immediately before the first audit prompt at
`2026-07-10T18:03:37.247Z`; the multiple analysis agents created after that
cutoff are intentionally excluded from the model totals.

This is an observational comparison, not a controlled A/B test: GPT 5.5 spans
2026-04-24 through 2026-07-06, while GPT 5.6 spans 2026-07-09 through
2026-07-10. Plan percentages are integer-valued global snapshots and include
concurrent auto-review traffic. The next trustworthy step is a live on/off A/B
with the same task corpus and concurrency, comparing price-weighted tokens and
plan-percentage movement rather than raw input tokens alone.

## Follow-up: all GPT-5.6 tiers and history barriers

The family analysis and regressions explicitly cover `gpt-5.6-sol`,
`gpt-5.6-terra`, and `gpt-5.6-luna`. Re-run the aggregate-only analyzer with:

```sh
pnpm audit:gpt-usage -- --before 2026-07-11T00:00:00Z
pnpm audit:gpt-usage -- --json > /tmp/gpt-usage.json
```

The follow-up transcript-shape scan found that Codex custom tool pairs occurred
roughly five times as often as standard function pairs. Supporting those pairs
made 62.2% of post-call states eligible for history collapse; preserving opaque
agent messages and starting after the latest barrier raised eligibility to
81.2%. These are candidate states, not claimed realized savings.

GPT-5.6+ cache writes are now captured separately as `cache_write_tokens` and
priced at 1.25x for API-cost reporting. Gross input remains the plan-usage view,
because cached tokens still contribute to rate limits.
