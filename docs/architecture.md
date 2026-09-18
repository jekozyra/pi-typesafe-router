# Routing before generation

Jev classifies task demand. A local policy chooses eligible generation targets. Neither classifier output nor task text can supply a provider URL, invent a model target, or bypass the configured chains.

```text
idle user input
  → bounded text projection
  → one explicitly selected classifier adapter
  → validated quick / standard / deep / uncertain answer
  → local confidence policy
  → ordered candidate eligibility checks
  → serialized Pi model selection
  → original input continues once
```

`classify` normalizes three protocols. `chooseRoute` and `candidateChecks` are pure. `registerRouter` owns lifecycle and session-local state. This is not an LLM proxy and does not register a synthetic generation model.

## Lifecycle contract

The implementation targets Pi **0.85.1**. Its idle `input` hook runs before initial generation authentication and compaction. `before_agent_start` is too late for a router that must rescue a missing initial model/auth configuration. Selection happens once at the idle input boundary; streaming steering/follow-up and extension-generated input pass through without classification. Tool-loop selection is sticky by router policy, not by an immutable host guarantee.

The extension returns `handled` when preflight must stop a prompt. Throwing would be unsafe: Pi catches input-hook exceptions and can continue generation. No path uses `sendUserMessage`, resends the original input, or chooses a new model after a generation error. Native Pi retry/overflow recovery is not disabled or replaced. Failure guidance waits for `agent_settled`, after native recovery finishes.

Model selection checks exact catalogue identity, configured auth presence, nonempty scoped-model restrictions, image support, and conservative context/output budgets. A setter returning false or throwing skips to the next candidate before generation. Catalogue eligibility does not prove remote credentials, quotas, availability, or task quality. Context estimates use UTF-8 byte-based text counts and fixed image reserves, not a model tokenizer. Large sessions can be rejected before Pi would compact them; compact manually or use a larger-context model. Unknown post-input changes from templates, context hooks, tools, or other extensions cannot be predicted.

## Cancellation and concurrency

Each operation has an epoch and an AbortController. Classifier credentials and HTTP share a deadline. Late classification/credential results are ignored. Escape/Ctrl+C are intercepted during TUI preflight, and `cancel`/`off` also invalidate the operation. Headless callers must use the router's cancel command during preflight; Pi's normal agent abort signal is not yet active there.

Pi's `setModel()` is asynchronous and has **no cancellation argument**. A timeout race cannot prevent it from later changing the model. The router therefore awaits the actual setter, never starts another selection in parallel, and consumes the cancelled original input afterward. Concurrent input is rejected, even if routing was turned off while authentication was pending. Model selection may finish after cancellation; users must verify it before resubmitting. There is no unsafe rollback to a stale model.

Session navigation is refused while preflight is active, cancelling the operation first. Shutdown/reload cancels and awaits its completion before allowing teardown. If a credential plugin never resolves its model-auth promise, selection and reload can remain blocked; restarting Pi is the recovery. This is an explicit limitation of the host setter, not something a timer can safely fix.

## Failure and recovery

Classification errors, timeouts, invalid responses, or missing keys use `defaultRoute`. Low/missing confidence and explicit uncertainty use `uncertainRoute`. Oversized, empty, and unexpanded slash input skip classification and use the conservative route. No eligible candidate consumes the prompt with an error instead of silently using a stale model. Shadow mode records the proposed route but neither changes the model nor blocks generation for an empty candidate chain.

After generation fails, `recover` is an explicit model-selection command. It starts after the failed target in the same chain, respects current eligibility, selects a model, and turns routing off so the next continuation cannot immediately route back to the failed target. It sends no prompt and cannot know whether repeating a tool would be safe. Manual model selection also disables routing. Do not run multiple routers: Pi does not provide exclusive model-selection ownership between extensions.

## Verification boundaries

Offline tests validate schema/policy, request serialization, normalized responses, cancellation, no replay, and real SDK extension loading. Packed-install smoke tests exercise Pi's actual extension loader using an isolated profile and installed production dependencies. Synthetic transports do not establish live service contracts or quality. In particular, Gateway confidence metadata needs a live account check; absent confidence stays conservative.

Before claiming savings or quality, evaluate privately on representative coding tasks with pinned versions and per-model success/cost/latency outcomes. Classifier confidence measures concentration, not downstream success probability. TypeSafe's public benchmarking restrictions require permission/clarification before publishing results.
