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

Use `all_turns` for a stable multi-turn task. Leave the option off, or have the
caller set `current_turn`, when the goal changes or earlier analysis is no longer
relevant.

## Verification fields

JSONL events expose:

- `gpt_prompt_cache_explicit`
- `gpt_persisted_reasoning`
- `gpt_reasoning_items`
- `gpt_encrypted_reasoning_items`
- `cached_tokens`
- `cache_write_tokens`

A useful evaluation compares price-weighted input, output/reasoning tokens,
latency, and task quality across matched workflows. Lower raw input alone is not
enough if persisted context increases output work or changes task success.
