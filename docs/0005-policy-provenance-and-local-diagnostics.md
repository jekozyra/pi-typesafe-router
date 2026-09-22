# ADR 0005: One policy artifact, verified classifier provenance, and local diagnostics

Status: Accepted — implemented against Pi 0.85.1.

## Context

Three weaknesses survived ADR 0004.

The classifier rubric existed twice. `src/classifier.ts` carried a frozen object and a separate
measurement script carried a hand-copied twin. Nothing compared them, so a rubric change
silently invalidated every measurement recorded before it.

The classifier's answer was never checked against the configured model. The direct TypeSafe
response names the model that answered, and the router parsed that field into
`Classification.returnedModel` and then ignored it. A provider-side alias move would have
changed the calibration behind the confidence floor with no signal.

Two disclosures were also coarser than they needed to be. Recent **assistant** messages were
projected to the classifier, and an assistant message can quote file contents or tool output
that the router itself never forwards. And a doctor run made a synthetic classifier request and
one generation probe per distinct target, which meant the only available diagnosis was the
billable one.

## Decision

### The rubric is one artifact

`policy.json` beside the extension is the only definition of the rubric. `src/policy.ts`
validates it strictly and throws on a malformed file, and `src/classifier.ts` builds its
`questions` object from the validated value. A measurement script loads the same file rather
than carrying a copy, so a measurement always describes the rubric that ships.

`src/provenance.ts` hashes the artifact canonically, and every decision records that digest, so
a consumer can compare its own measurement with the runtime. That is the anti-drift gate: the
runtime and the measurement can no longer disagree about what was asked.

### An external rubric is a path, so it is read as one

A configuration may name its own artifact with an absolute `policyPath`; the built-in artifact
remains the default. The classifier's request and its answer envelope are keyed by the
validated policy's `question`, so a policy that names its question something other than
`task_class` still round-trips on every transport.

A path is not a document, so `src/bounded-file.ts` owns the read for both the policy and the
router configuration. It opens with `O_NONBLOCK` and rejects anything whose descriptor is not a
regular file, which is what keeps a FIFO, socket, device, or directory from parking Pi's event
loop; it caps the byte count before parsing; and it checks the caller's `AbortSignal` between
chunks. A missing file keeps its `ENOENT` error so a caller can treat absence as a supported
state. Cancellation propagates its own reason, and every other failure is one fixed path-free
sentence, so a rejected path or body can never reach a terminal.

### Provenance is verified where the transport can attest it

`src/provenance.ts` decides what each backend can prove.

| Backend    | Response carries a model       | Rule                                                  |
| ---------- | ------------------------------ | ----------------------------------------------------- |
| TypeSafe   | yes                            | the returned ID must equal the configured model       |
| OpenRouter | yes                            | the returned ID must equal the configured model       |
| Cloudflare | no                             | unavailable; the alias is pinned by the config schema |
| Vercel     | gateway reports the request ID | unavailable; the alias is pinned by the config schema |

A missing or different ID on an attesting backend is a `model-mismatch` classifier failure. It
follows the ADR 0004 recovery path: the prompt continues untouched on Pi's current model, and
the decision records the reason. Nothing is retried and no fallback model is substituted,
because a different classifier model would invalidate the confidence floor.

### Decisions carry provenance, not prompts

Every decision records three canonical SHA-256 hashes plus the requested and returned classifier
model:

- `policyHash` — the rubric that produced the classification;
- `configHash` — the applied configuration, including credential _references_;
- `candidateSnapshotHash` — the ordered route chains, preserving preference and fallback order.

Canonical JSON sorts object keys, so reformatting a file or reordering its keys does not change
a hash, while a changed route order or thinking level does. Configuration holds credential
references and never credential values, so the hash covers which credential was selected without
containing anything secret. Prompt text, conversation text, provider error bodies, and resolved
auth material are never hash inputs.

### The projection is stated in the file

Configuration version 2 adds `historyRoles`. Version 1 has no such field and keeps the
historical user-and-assistant projection, so an installed file is not silently reinterpreted.
The generated Home configuration and `/typesafe-router setup` both write version 2 with
`["user"]`, which is the privacy default: assistant text can carry quoted tool or file content
that the router deliberately does not forward itself.

`historyRoles` is bounded and rejects duplicates. A version-2 operator who wants the old
behavior can still write `["user", "assistant"]` deliberately, and `/typesafe-router on` reports
the projection it will use rather than a fixed sentence.

### Diagnostics separate local and live checks

| Command                         | Network                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| `/typesafe-router doctor local` | none — config, catalogue, scope, eligibility, hashes                    |
| `/typesafe-router doctor live`  | synthetic classifier call plus one probe per distinct configured target |
| `/typesafe-router doctor`       | alias for `live`, for compatibility                                     |

A local run reports the same route table with every candidate marked "not checked" and states
that no request was made. It applies the configuration and deliberately does not clear earned
generation proofs, because a run that proves nothing must not discard proofs a live run paid
for. Only a live run clears and rebuilds them.

Automatic routing is unchanged: one real classification, then a probe of the selected route's
candidates only. A classifier fault in shadow mode now records the failure rather than a
proposed target, since with no valid classification shadow would have applied nothing.

### The unused adapter closure loads lazily

The AI SDK is imported only on the Vercel path. TypeSafe, OpenRouter, and Cloudflare are plain
HTTP, and loading the gateway, OIDC, and undici closure for them was cost with no effect.

## Consequences and alternatives

- The policy artifact is checked in beside the extension, so a store copy carries its own copy
  and resolves it relative to the module. It is not user-editable through `/setup`, and a
  malformed artifact is a startup failure rather than a fallback to a built-in rubric.
- Exact provenance on OpenRouter is a deliberate risk. If that endpoint returns a namespaced or
  dated variant, routing fails closed to the current model with a `model-mismatch` reason. The
  alternative — accepting any returned ID — would make the confidence floor unverifiable, and
  the OpenRouter backend is not in use here.
- The gateway backends have no provenance check at all. Their models are schema literals, so the
  request is pinned, but upstream drift inside the alias is not observable through these
  transports.
- Hashes are provenance, not trust. They show which policy, configuration, and candidate order
  produced a decision; they say nothing about whether the decision was good.
- Hashing the whole configuration means a cosmetic edit changes `configHash`. That is intended:
  the hash answers "which file produced this", and a false negative would be worse.
- Version 1 remains accepted, so a configuration predating this ADR keeps working, and the
  runtime reports which projection it is using instead of assuming one.
- The remaining `ai` dependency stays vendored. Lazy import reduces load cost, not the store
  closure.

## Implementation and verification

- [Policy artifact](../policy.json), [policy loading](../src/policy.ts),
  [provenance and hashing](../src/provenance.ts), [classifier](../src/classifier.ts),
  [versioned config](../src/config.ts), [projection](../src/context.ts), and
  [diagnostics](../src/index.ts).
- Regressions in [policy](../tests/policy.test.ts), [provenance](../tests/provenance.test.ts),
  [config](../tests/config.test.ts), [context](../tests/context.test.ts),
  [classifier](../tests/classifier.test.ts), and [runtime](../tests/runtime.test.ts) tests.
- `npm run check` typechecks, lints, and runs the offline suite; the policy tests validate
  `policy.json` and forbid a second rubric copy, and the classifier test asserts the AI SDK is
  not statically imported.
- Outcome and feedback telemetry, a threshold change, and any per-route calibration remain
  later work; this ADR records no routing-policy change and keeps the 0.8 floor.
