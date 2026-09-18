# Routing before generation

Jev classifies task demand. A local policy chooses eligible generation targets. Neither classifier output nor task text can supply a provider URL, invent a model target, or bypass the configured chains.

```text
idle user input
  → current session doctor verification gate
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

Model selection requires a current successful doctor generation proof, then checks exact catalogue identity, configured auth presence, nonempty scoped-model restrictions, image support, and conservative context/output budgets. A setter returning false or throwing skips to the next candidate before generation. Failed doctor targets are skipped, even when first in a chain; remaining successful candidates keep their configured order. Catalogue eligibility alone does not prove remote credentials, quotas, availability, or task quality. A successful probe is only a health snapshot, not a guarantee of future generation. Context sizing uses Pi's `ctx.getContextUsage()` count, which incorporates provider-reported usage and Pi's trailing-message estimates. Unsent input uses Pi's exported `estimateTokens`; the router does not count serialized metadata or treat bytes as tokens. If Pi reports unknown usage immediately after compaction, the router skips only its context-size check and leaves compaction/accounting to Pi. If no usage API result is available, it sums Pi's message estimates. Counts are not exact candidate-specific tokenization; Pi's current accounting is the shared basis. Unknown post-input changes from templates, context hooks, tools, or other extensions cannot be predicted.

## Cancellation and concurrency

Each operation has an epoch and an AbortController. Classifier credentials and HTTP share a deadline. Late classification/credential results are ignored. Escape/Ctrl+C are intercepted during TUI preflight, and `/typesafe-router off` also invalidates the operation. Headless callers must use `off` during preflight; Pi's normal agent abort signal is not yet active there.

Pi's `setModel()` is asynchronous and has **no cancellation argument**. A timeout race cannot prevent it from later changing the model. The router therefore awaits the actual setter, never starts another selection in parallel, and consumes the cancelled original input afterward. Concurrent input is rejected, even if routing was turned off while authentication was pending. Model selection may finish after cancellation; users must verify it before resubmitting. There is no unsafe rollback to a stale model.

Session navigation is refused while preflight is active, cancelling the operation first. Shutdown/reload cancels and awaits its completion before allowing teardown. If a credential plugin never resolves its model-auth promise, selection and reload can remain blocked; restarting Pi is the recovery. This is an explicit limitation of the host setter, not something a timer can safely fix.

## Failure and recovery

Classification errors, timeouts, invalid responses, or missing keys use `defaultRoute`. Low/missing confidence and explicit uncertainty use `uncertainRoute`. Oversized, empty, and unexpanded slash input skip classification and use the conservative route. No eligible candidate consumes the prompt with an error instead of silently using a stale model. After the doctor gate passes, shadow mode records the proposed route but neither changes the model nor blocks generation for an empty candidate chain. Both on and shadow modes, including automatic input, are blocked without current doctor verification; off/manual Pi use remains available.

After generation fails, guidance points to Pi's `/model`, inspection of completed tool effects, and manual continuation when safe. The router does not select a post-generation fallback or replay a task. Manual model selection disables routing. Do not run multiple routers: Pi does not provide exclusive model-selection ownership between extensions.

## Diagnostics and configuration

`/typesafe-router doctor` serializes with preflight and model selection. It applies valid configuration while retaining the current session's on/off/shadow mode; it never enables an off session. Missing or invalid configuration disables routing. Every refresh invalidates old proofs before checking anything. Readiness requires a completed, successful doctor run: the classifier check must succeed and every quick/standard/deep route must contain at least one locally eligible target with a successful generation probe. Cancellation or incomplete work cannot publish partial readiness.

Doctor checks local eligibility, then runs the synthetic classifier request and one isolated synthetic generation request per distinct configured provider/model concurrently, deduplicated across routes. A shared progress counter counts completed checks (including failures), while the final report preserves configured route order. TUI progress updates one widget above the editor, independent of the footer and routing mode, and clears on completion, failure, or cancellation. Other interfaces receive textual progress notifications. Cancelling doctor aborts the whole batch; partial results cannot grant verification. Generation probes use Pi's `modelRegistry.complete` with the actual credential providers, including OAuth, custom headers, and configured endpoints. Credentials may refresh. Probes contain no actual conversation transcript and use `tools: []`, `maxTokens: 128` where supported, and `maxRetries: 0`. `generationProbeTimeoutMs` bounds each model probe (default 15000 ms), separately from the classifier's `timeoutMs`. These limits are not a strict monetary cap. Explicit invocation authorizes potentially billable diagnostics even while off or headless with `allowHeadless: false`. Doctor never calls the generation model setter, changes the selected model, or runs or replays the original task.

Generation proofs and readiness live only in memory, not session records or config. Restart/reload requires doctor again. The verification identity covers routes, credential references, backend configuration, and model metadata, so changes under the same provider/model IDs still invalidate it. Native auth status and provider references contribute to an in-memory hash; no secrets are persisted. A changed identity requires a fresh successful doctor run, not reuse of old proofs. Effective Pi provider object identity covers native registrations and applied `models.json` changes; a provider-registry refresh can conservatively require doctor again. Classifier-only Pi credential providers are included. Before enabling or routing, every route must still have an eligible verified candidate, including current scope and context limits.

Probe cancellation releases doctor promptly and checks the abort signal again after Pi resolves authentication, before invoking provider transport. A credential plugin that ignores cancellation may still finish authentication or refresh credentials later; its late result cannot start the probe transport or publish verification.

Reports reflect runtime, config path/application result, actual mode, current model, backend/model, credential source, local eligibility, classifier result/latency, generation probe outcomes, and readiness, with conditional next steps. Cancellation and incomplete work are explicit; shutdown suppresses stale output. Off/Escape cancels pending work but cannot release a pending model setter's lock early.

`status`, also the default subcommand, is read-only and makes no network calls. It reports applied configuration and on-disk differences (or inability to check), current activity/model/mode, and a historical last decision. It does not apply configuration or renew verification. Classifier success alone does not prove generation-provider health; successful generation probes do not guarantee later availability, quota, or task quality.

## Verification boundaries

Offline tests validate schema/policy, request serialization, normalized responses, cancellation, no replay, and real SDK extension loading. Packed-install smoke tests exercise Pi's actual extension loader using an isolated profile and installed production dependencies. Synthetic transports do not establish live service contracts or quality. In particular, Gateway confidence metadata needs a live account check; absent confidence stays conservative.

Before claiming savings or quality, evaluate privately on representative coding tasks with pinned versions and per-model success/cost/latency outcomes. Classifier confidence measures concentration, not downstream success probability. TypeSafe's public benchmarking restrictions require permission/clarification before publishing results.
