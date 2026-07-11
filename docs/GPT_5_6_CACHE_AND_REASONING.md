# GPT-5.6 explicit caching and persisted reasoning

## Decision

pxpipe enables explicit prompt caching by default for the deterministic static
slab that it injects into GPT-5.6 requests. Persisted reasoning is implemented as
an opt-in for existing stateful Responses API chains.

These public API controls are not accepted by the ChatGPT subscription Codex
transport. A live `codex exec` request against
`https://chatgpt.com/backend-api/codex` returned HTTP 400 for
`prompt_cache_options`. pxpipe therefore detects that upstream, skips only its
explicit-cache additions, and preserves Codex's native caching fields.

This split is intentional:

- Explicit caching has a direct cost objective. GPT-5.6 cache writes cost 1.25x
  ordinary input, while cache reads are discounted. In implicit mode the service
  places a breakpoint on the latest message, which changes every turn. pxpipe's
  rendered system/tool slab is stable, so it is the safer write target.
- Persisted reasoning is a continuity and cache-efficiency feature, not a
  guaranteed token reduction. `all_turns` is appropriate when goals, assumptions,
  and priorities remain stable. It can be counterproductive after a task pivot.

Official references: [latest-model guide](https://developers.openai.com/api/docs/guides/latest-model),
[prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), and
[preserve reasoning across calls](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-across-calls).

## Explicit prompt caching

For a compressed GPT-5.6 Chat Completions or Responses request, pxpipe:

1. Adds `prompt_cache_breakpoint: {"mode":"explicit"}` to the final text block
   in its deterministic static slab.
2. Adds `prompt_cache_options: {"mode":"explicit"}` when the caller did not
   choose a mode. This disables the changing implicit latest-message breakpoint.
3. Adds a stable `prompt_cache_key` derived from pxpipe's static-slab SHA when the
   caller did not supply one.

Caller-provided cache keys, modes, and TTLs take precedence. Models before
GPT-5.6 are unchanged. `compress:false` remains byte-for-byte passthrough.
When the configured OpenAI upstream is the ChatGPT Codex subscription backend,
the public `prompt_cache_options` and `prompt_cache_breakpoint` additions are
disabled because that transport rejects them.

Disable the behavior with:

```sh
PXPIPE_GPT56_PROMPT_CACHE=false pxpipe
```

The prefix must contain at least 1,024 tokens to be cacheable. OpenAI currently
supports a `30m` minimum TTL for GPT-5.6 breakpoints. The service reports reads
as `cached_tokens` and writes as `cache_write_tokens`; pxpipe records and prices
both separately.

The cold write costs 25% more than ordinary input. If the cache-read price is
10% of ordinary input, one later full read more than repays the write premium:

```text
one cold write + one warm read = 1.25 + 0.10 = 1.35
two ordinary inputs           = 1.00 + 1.00 = 2.00
```

Actual savings depend on exact-prefix reuse and eviction, so use pxpipe telemetry
rather than assuming every breakpoint hits.

## Persisted reasoning

Enable it with:

```sh
PXPIPE_GPT56_REASONING_CONTEXT=all_turns pxpipe
```

pxpipe adds `reasoning.context: "all_turns"` only when all of these are true:

- the model is in the GPT-5.6 family;
- the route is the Responses API;
- the request already contains `previous_response_id` or `conversation`; and
- the caller did not already set `reasoning.context`.

pxpipe deliberately does not create response chains, force `store: true`, add
encrypted reasoning content, or attempt to reconstruct stateless histories. A
stateless `store:false`/ZDR client must request
`include: ["reasoning.encrypted_content"]`, preserve every output item, and replay
the complete history itself, as required by the OpenAI guide.

Codex CLI 0.144.1 was observed doing exactly that: its request used
`store: false`, `include: ["reasoning.encrypted_content"]`, and
`reasoning.context: "all_turns"`. Since the caller already selected the mode,
pxpipe leaves it intact.

The same live transport also supplies its own `prompt_cache_key`. A July 2026
`codex exec` smoke test through pxpipe succeeded with that native key while the
public-only `prompt_cache_options` and breakpoint fields were absent. pxpipe
records only a non-reversible fingerprint of the key, never the raw value.

Use `all_turns` for a stable multi-turn task. Leave the option off, or have the
caller set `current_turn`, when the goal changes or earlier analysis is no longer
relevant.

## Verification fields

JSONL events expose:

- `gpt_prompt_cache_explicit`
- `gpt_persisted_reasoning`
- `gpt_reasoning_items`
- `gpt_encrypted_reasoning_items`
- `gpt_reasoning_bytes`
- `gpt_encrypted_reasoning_bytes`
- `gpt_reasoning_effort`
- `gpt_reasoning_context`
- `gpt_prompt_cache_key_present`
- `gpt_prompt_cache_key_fingerprint`
- `request_body_input_bytes`
- `request_body_output_bytes`
- `gpt_render_cache_hits`
- `gpt_render_cache_misses`
- `gpt_render_cache_saved_ms`
- `cached_tokens`
- `cache_write_tokens`

A useful evaluation compares price-weighted input, output/reasoning tokens,
latency, and task quality across matched workflows. Lower raw input alone is not
enough if persisted context increases output work or changes task success.

## Local render cache

OpenAI prompt caching avoids repeated model-side prefix work. It does not avoid
pxpipe's own PNG generation. GPT frozen-history sections and the static slab are
deterministic, so pxpipe keeps their rendered pages in a process-local 64 MiB
LRU keyed by the full text and render geometry. In-flight requests share the
same render promise. A restart clears the cache; correctness never depends on a
hit.

On the first live request after deployment, 13 pages rendered in 1,076 ms. The
next same-prefix requests hit all 13 cached sections and transformed in 277–308
ms, avoiding about 0.75–0.80 seconds of local work per request.

`eval/benchmark-gpt-history-sections.ts` tests the frozen-section sizing against
a 75-turn, roughly 77k-token, tool-heavy transcript. The 2k and 4k settings were
identical; 6k increased physical images; 8k left a partial tail uncollapsed; and
12k reduced image tokens by only about 1%. The production 2k default therefore
remains unchanged.
