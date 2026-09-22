# ADR 0002: Gate routing on session-local doctor verification

Status: Superseded by [ADR 0004](0004-route-local-verification-and-recovery.md).

## Context

A catalogue entry and configured credentials do not prove remote model access. They cannot establish permissions, quota, endpoint compatibility, or whether authentication succeeds. Enabling routing from these signals alone can send the first real task into a broken configuration.

Separate reload, validation, and network-check commands also make it easy to inspect one configuration while routing with another. We need a single explicit operation that applies configuration and tests access, without enabling routing or running the actual task.

## Decision

We consolidate configuration refresh, local eligibility checks, classifier testing, and generation probes into `/typesafe-router doctor`. We keep `status` and `help` read-only. The command surface is `setup`, `doctor`, `status`, `on`, `shadow`, `off`, and `help`; omitted subcommands show status. Help prints a command table without reading configuration, making network calls, or interrupting active work. Old check/validate/reload/recover/cancel commands are not part of the contract.

### Verification is required, not inferred

Every doctor refresh discards previous proofs before checking anything. Readiness requires a completed run with a successful classifier check and at least one locally eligible, successfully probed model in **each** route. We do not require every fallback target to pass: a broken primary should not defeat a working authorized alternative. Later preflight skips failed targets and preserves the configured order of successful candidates.

`on`, `shadow`, and automatic input require current verification. Shadow shares the gate so it evaluates a configuration we can actually use, even though it does not select a model. After the gate passes, shadow records its proposal without blocking generation for an empty proposed candidate chain. Off/manual Pi use remains available without doctor.

Doctor applies valid configuration while preserving the current session mode. It never enables an off session; invalid or missing configuration disables routing. Status reports applied configuration, disk differences, current activity/model/mode, and a historical last decision. It neither applies changes nor renews proofs. This separates observation from operations with network and billing effects.

### Probes exercise the actual generation path without the task

Doctor performs local checks, then concurrently runs one synthetic classifier request and one isolated generation probe per distinct configured provider/model. Targets shared across routes are probed once. Generation probes use Pi's `modelRegistry.complete`, not `setModel`, so they exercise configured providers, OAuth, headers, and endpoints without changing the selected model.

Probes contain no conversation transcript and use `tools: []`, `maxTokens: 128` where supported, and `maxRetries: 0`. Each generation probe has its own `generationProbeTimeoutMs` deadline, separate from classification. We validate response identity, stop reason, absence of tool calls, and nonempty text rather than trusting the model to declare its own health.

Explicit doctor invocation authorizes potentially billable diagnostics without a second confirmation, including while off or headless with `allowHeadless: false`. That flag still gates automatic routing. One command gives a complete access report rather than another optional step that can be mistaken for verification. The cost is real: token and time limits are not a strict monetary cap, and credentials may refresh.

### Proofs belong to the current session and configuration

We retain passed target identities and a verification fingerprint only in memory. The fingerprint covers configuration, resolved model metadata, provider object identities, auth status, and registered provider configuration, including classifier-only Pi credential providers. We never persist the fingerprint or credential material as verification evidence.

Restart/reload or an identity change requires a fresh doctor run. Current local eligibility is rechecked before enabling or routing, so changed scope or context can invalidate readiness. Provider refreshes can conservatively require another run even with unchanged provider/model IDs. The fingerprint does not detect every secret rotation; changing an environment variable's value alone does not change it. Persisted proofs would imply validity across changes we cannot reliably observe.

Doctor serializes with preflight and model selection. Cancellation aborts the batch; incomplete work never publishes partial readiness. Probes check cancellation again after authentication and before transport, so late credential resolution cannot start an abandoned request or publish a proof. A credential plugin can still finish authentication or refresh credentials after cancellation.

### Reports distinguish progress, access, and readiness

We count completed checks, including failures, while preserving configured route order in the final report. TUI progress uses one temporary widget above the editor, independent of routing mode and the footer, and clears on completion or cancellation. Other interfaces receive textual progress; headless diagnostics use stderr. This makes parallel work visible without a stream of persistent TUI notifications.

Reports show the applied configuration result, runtime mode, current model, credential source, local eligibility, classifier result, generation outcomes, and readiness. Next steps depend on the actual state. We report normalized reasons rather than raw provider errors or response bodies. Shutdown suppresses stale output.

## Consequences and alternatives

- We prefer active access checks over catalogue-only validation, but doctor is only a health snapshot. It does not guarantee later availability, quota, task quality, or classifier accuracy.
- Requiring fresh session proofs adds startup friction and charges, including for shadow mode. We accept this rather than silently treating old success or partial checks as readiness.
- Deduplication and concurrency reduce duplicate charges and elapsed time, but a large target set still creates a burst of requests. Per-model deadlines are not a total doctor deadline or spending limit.
- We keep diagnostics separate from task recovery. Doctor never selects a generation model, executes tools, or retries the original task. Generation failure remains manual recovery as described in [ADR 0001](0001-route-before-generation.md).

## Implementation and verification

- [Command lifecycle and readiness gate](../src/index.ts), [verification identity](../src/verification.ts), [isolated probes](../src/generation-probe.ts), and [report formatting](../src/diagnostics.ts).
- Regressions in [verification](../tests/verification.test.ts), [probe](../tests/generation-probe.test.ts), [diagnostics](../tests/diagnostics.test.ts), and [runtime](../tests/runtime.test.ts) tests.
- Run `npm run check` for offline checks and `npm run smoke:package` for packed-install loading. Neither replaces account-specific live compatibility checks of response shape, confidence extraction, permissions, billing controls, and cancellation. Run live checks only with explicit approval for charges.
