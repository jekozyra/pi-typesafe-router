# ADR 0001: Classify tasks, select locally, and route only before generation

Status: Accepted — implemented against Pi 0.85.1

## Context

We want task-aware model selection without replacing Pi's providers, credentials, conversation handling, or tools. Jev can classify task demand, but its confidence does not measure whether a generation model will complete the task. Untrusted conversation text can also influence classification.

The routing boundary matters. In Pi 0.85.1, `before_agent_start` runs after initial model authentication and compaction. A virtual generation provider would hide the real selected model and require us to preserve downstream streaming, limits, identity, and recovery behavior. Switching after generation begins risks repeating tool side effects.

## Decision

We use Jev as an advisory classifier and keep selection policy local. We route once at an eligible idle `input` boundary, before generation authentication and compaction. We select real Pi models rather than registering a synthetic provider.

```text
idle input → session verification → bounded text classification
           → local route policy → ordered eligibility checks
           → serialized model selection → original input continues once
```

### Classification does not grant authority

- We use a fixed `quick` / `standard` / `deep` taxonomy plus `uncertain`. Configuration maps routes to flat, ordered lists of exact provider/model identities. This avoids inferred model names, route graphs, and implicit destinations.
- We validate labels, probability distributions, and confidence at runtime. Errors and timeouts use `defaultRoute`; uncertainty or missing/low confidence uses `uncertainRoute`. Both default to `deep`. Confidence is not a downstream success probability.
- We check current catalogue availability, model scope, image support, context/output budgets, and the generation proofs from [ADR 0002](0002-verify-routing-with-doctor.md). Failed selection advances only within the configured chain. An exhausted chain stops the prompt rather than silently using a stale model.
- We use Pi's context accounting and token estimates rather than treating bytes as tokens. Unknown post-compaction usage leaves compaction to Pi; we do not trim generation history to fit a cheaper target.

### Disclosure and transport are explicit

We read only global configuration under Pi's agent directory. Repository-local configuration could redirect private content without a deliberate global choice. Configuration stores credential references, not keys; setup creates an off-mode file without overwriting existing settings.

We send the intact current request and bounded recent user/assistant text, not system prompts, raw tool results, reasoning, images, or files. Oversized, empty, or unexpanded slash input takes the conservative route without classification. This limits disclosure and irrelevant context, but ordinary text can still contain secrets. Shadow mode also sends text and can incur charges.

We support one explicitly selected backend: TypeSafe direct, Cloudflare AI Gateway's account-scoped universal REST API with an explicit gateway ID, Vercel AI Gateway's experimental evaluation API, or OpenRouter's alpha Decisions API. Small HTTP adapters serve TypeSafe, Cloudflare, and OpenRouter; Vercel uses pinned AI SDK `7.0.105` because evaluation is not a chat-completions protocol. All adapters share the rubric and normalized validation boundary.

We do not retry classification, follow redirects, accept arbitrary classifier endpoints, or fail over between backends. Credentials and classification share a deadline. This bounds optional overhead and avoids silently changing recipients or billing. Pi-managed classifier credentials are opt-in API-key reuse, not proof of endpoint compatibility. Cloudflare requests disabled logging/cache and one attempt; Vercel requests zero data retention by default. Neither control establishes a universal retention guarantee.

### Pi owns generation; we do not replay tasks

We skip extension-generated input, steering, and queued follow-ups. The router keeps selection sticky through the tool loop rather than chasing per-step prices or sacrificing cache reuse. Manual model selection disables routing. Pi's native retry and compaction behavior remains unchanged; failure guidance waits for `agent_settled` and directs manual recovery through `/model`. There is no router recovery command that selects a post-generation fallback or resubmits work.

We serialize operations and invalidate stale work with epochs and abort signals. Cancellation stops the original submission; it does not authorize fallback generation. We return `handled` to stop input because Pi can catch an input-hook exception and continue.

Pi's asynchronous `setModel()` has no cancellation argument. We await the actual setter even after cancellation, keeping the selection lock held. Racing it against a timeout and selecting another candidate could let the abandoned setter overwrite the newer choice. Concurrent submissions are rejected; navigation is refused during preflight; teardown cancels and awaits completion. We do not roll back to a potentially stale model.

## Consequences and alternatives

- We retain Pi's real model identity and generation machinery instead of maintaining a proxy provider. We cannot offer transparent runtime outage failover or exclusive ownership against competing extensions. Do not enable competing routers.
- A cancelled setter can still change the model. A credential plugin that never resolves can block selection and reload; restarting Pi is the recovery. TUI Escape/Ctrl+C and `off` cancel router preflight; headless callers must use `off` because normal agent abort is not active yet.
- Context estimates are conservative, not exact candidate-specific tokenization. Later prompt expansion and other extensions can change the eventual request.
- We defer learned cost optimization, arbitrary classifier rubrics, automatic thinking-level routing, and per-tool-step rerouting. These need outcome evidence, not merely confident task labels.
- Synthetic tests establish local behavior, not live backend parity, savings, retention, or task quality. Vercel confidence metadata remains account-dependent evidence to verify; missing confidence stays conservative. OpenRouter's Decisions API is alpha and may change. Public performance claims require review of TypeSafe's terms.

## Implementation and verification

- [Configuration](../src/config.ts), [projection](../src/context.ts), [classifier adapters](../src/classifier.ts), and [pure routing policy](../src/routing.ts).
- [Lifecycle and cancellation](../src/index.ts); regressions in [core](../tests/core.test.ts), [classifier](../tests/classifier.test.ts), [runtime](../tests/runtime.test.ts), and [real Pi integration](../tests/pi-integration.test.ts) tests.
- Setup and configuration examples: [README](../README.md#configuration).
