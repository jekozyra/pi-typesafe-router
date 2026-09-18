# Consolidated router doctor

## Approved requirements

Replace validate/check/reload with doctor. Remove cancel/recover commands. Keep setup, doctor, status, on, shadow, off. Doctor automatically sends one synthetic classifier request; no confirmation and no conversation history. Never generate or replay a user task. Synthetic generation probes are the approved exception described below. Preserve ordered preflight generation fallbacks. Manual failure recovery uses Pi's /model.

Doctor refreshes configuration while retaining the session's current mode (diagnostics must not enable routing). Missing or invalid config disables routing and produces actionable diagnostics. Show runtime, config path/application result, actual active mode, backend/model, credential source, local eligibility of every mapped target, and actual classifier result/latency. Never claim generation-provider health from local eligibility. Report incomplete/cancelled work explicitly, not success. Off/Escape abort pending work; shutdown does not publish stale UI output. Serialize doctor with preflight/model selection.

Status is read-only: show active effective configuration and mode, current activity, selected generation model, and last decision labeled historical. Report disk changes or inability to check the disk rather than pretending the in-memory snapshot is current. Doctor is the only apply-and-test command.

## Resolved design questions

### R1. How should configuration diagnostics be organized?

**Option A, One doctor command.** Chosen by user: apply configuration, perform local checks, and test the classifier in one command. Remove redundant commands. Reports use web-agent's plain label/result style with conditional next steps.

### R2. Should doctor automatically send its classifier test?

**Option A, Automatic synthetic check.** Chosen by user. Sends no conversation history, may incur charges. Report progress before the request and explicit failure or cancellation afterward.

**Option B, Confirm every test.** Rejected by user in favor of automatic testing.

## Implementation

1. Record approved output mocks before code changes. Existing output source: src/index.ts; reference: installed pi-web-agent doctor/show uses a single multiline notification with runtime/config/health lines and actionable failures. Mock colors are viewer-only: actual notifications inherit Pi's theme.
2. Extract report formatting and safe reason-to-action mapping into a small diagnostic module. Keep lifecycle ownership in registerRouter.
3. Add serialized doctor configuration loading and synthetic classifier evaluation; remove obsolete command branches and recovery state where unnecessary. Preserve latest-action/off/shutdown precedence.
4. Update status and all notifications/help/docs to reflect actual effective state, with no generic reload reminders or dead commands.
5. Migrate tests for doctor lifecycle, automatic requests, local failures, stale completions, no generation/replay, live status versus disk config, and command removal. Run lint/typecheck/tests/package smoke and fix/format stability.

## Limits

Tests use synthetic transports; no live service calls during implementation. Invoking doctor explicitly in TUI or headless mode authorizes its one synthetic network request even with routing off. Pi setModel remains non-cancellable; off must retain the selection lock until auth settles. Running doctor applies settings but never selects a generation model. A successful classifier test is not a benchmark or proof of generation availability.

## Generation readiness: subsequent approved decision

### R3. Should generation providers be contacted before routing?

**Option A, Probe and gate routing.** Approved by user. Doctor sends a minimal synthetic no-tools request through Pi to each distinct configured generation model. Routing stays blocked until the classifier succeeds and every route has at least one locally eligible model whose probe passed. Only passed candidates participate in ordered preflight fallback. Proofs live in session memory, are discarded at the start of a new doctor run, and are invalidated by configuration, model descriptor, or credential-source/reference changes. No cached successful probe guarantees future service availability.

Use the actual Pi model registry completion path to preserve OAuth, custom endpoints, headers, and auth behavior. Request maxTokens 128 where supported, disable retries, and bound each probe by generationProbeTimeoutMs (default 15000, range 100–60000). Probe text and responses are not added to the conversation or persisted. Only safe outcomes are displayed. Cancellation cannot publish partial proofs. Auto/shadow startup configuration does not bypass doctor. Manual Pi use with routing off is unaffected.
