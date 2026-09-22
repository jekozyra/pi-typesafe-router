# ADR 0004: Verify the selected route and recover without losing the prompt

Status: Accepted — implemented against Pi 0.85.1. Supersedes
[ADR 0002](0002-verify-routing-with-doctor.md), and supersedes the unreleased
configuration-wide verification record with the per-target store described below.

## Context

[ADR 0002](0002-verify-routing-with-doctor.md) required a completed doctor run before any
automatic routing. Readiness demanded one probed, eligible model in every route. That gate
costs a classifier request and one generation probe per distinct target on the first prompt of
every session.

It also couples unrelated routes. A broken `quick` credential blocks a prompt the classifier
would send to `deep`, and a stale fingerprint does the same. The old code answered both with
`handled`, so Pi dropped the typed prompt instead of generating anything.

Jev is an optimization layer, not a safety boundary. Pi's current model is already authorized
and usable. Discarding a user's prompt to protect a routing preference inverts that priority.

## Decision

Automatic routing classifies the real prompt once, then verifies only the route it selects. A
router fault never consumes the prompt; only an explicit cancellation does.

```text
idle input → structural config check → one classifier request
           → local route policy → selected-route probes, in order
           → model, then effort → the original input continues once
```

### The real classification is the classifier proof

The first prompt no longer runs a full doctor. A successful classification already proves the
configured backend, credential, endpoint, and response shape. A second synthetic classifier
call adds cost without adding evidence.

Generation access is a separate fact and stays actively probed. The selected route's candidates
are probed in configured order, one at a time, until one answers. A passed probe is remembered
for the session. An unrelated route's candidates are never contacted.

Manual `/typesafe-router doctor` remains the complete report. It probes every distinct
configured target, including routes this session never selects, and records what passed.

### Proofs are per target

ADR 0002 bound every proof to one configuration-wide fingerprint. Any provider, credential, or
catalogue change discarded all of them.

[`targetFingerprint`](../src/verification.ts) hashes one target instead. Its inputs are:

- the target's provider, model, and thinking level;
- the composed provider object's identity, auth status, and registered configuration;
- the resolved catalogue entry for that provider and model.

A change invalidates only the targets it touches.

A successful `/typesafe-router doctor` run records the proofs it earned in a session entry, and
a reload or tree navigation restores exactly the proofs whose fingerprints still match. A proof
whose target, provider, credential reference, or resolved catalogue entry changed is dropped,
and a verification entry whose proofs are all stale is replaced by a tombstone. Restoring is
safe because the fingerprint is recomputed against the live registry before a proof is adopted,
so a stored proof never claims validity across a change this process can observe.

Proofs earned by routing rather than by a doctor run stay in memory for the session. The store
is cleared whenever the configuration is reloaded, and is then rebuilt from the session branch
where a doctor run recorded one.

### A router fault leaves the prompt to Pi

Infrastructure failures continue generation on Pi's current model without touching model or
effort:

| Failure                                          | Behavior                                 |
| ------------------------------------------------ | ---------------------------------------- |
| unreadable or invalid configuration              | warn once, continue on the current model |
| classifier transport, timeout, or protocol error | warn, continue on the current model      |
| no eligible candidate in the selected route      | warn, continue on the current model      |
| every probe failed, or `setModel` failed         | warn, continue on the current model      |

Low confidence or an `uncertain` label is not a failure. It takes the conservative
`uncertainRoute`, exactly as before.

Each of those outcomes appends a decision entry with a normalized `fallback` reason. A
classifier failure records `classifier-failure`. A route that yielded nothing records
`no-eligible-target`, `probe-failed`, or `selection-failed`.

A configuration that is invalid while routing is off no longer blocks input. The router warns
once per session and steps aside.

### Cancellation is the one non-continue outcome

Escape, Ctrl+C, `/typesafe-router off`, or session navigation during an active operation
suppress generation and return `handled`. When the interface has a UI, the router restores the
submitted text with `ctx.ui.setEditorText`. Pi exposes no matching setter for image
attachments, so the warning names them instead of implying they came back. Headless routing
stays disabled by default, so this branch is unreachable without `allowHeadless`.

### Enabling routing no longer requires doctor

`/typesafe-router on` and `shadow` need a valid, applied configuration only. Requiring a full
doctor run would restore the gate this ADR removes. `doctor` stays the way to pre-warm every
proof and to diagnose an account.

## Consequences and alternatives

- Cost per session drops from one classifier request plus one probe per distinct target to one
  classifier request plus one probe per selected target. A route that was never selected is
  never probed.
- A failing primary is re-probed on each new submission. Caching failures would strand the
  session on a worse model after one transient error.
- Continuing on the current model preserves work and favors availability over cost routing. It
  is loud: a warning and a decision entry record every fallback.
- Proofs remain a snapshot. They prove access at one moment, not quota, task quality, or later
  availability.
- A `setModel` call that fails after partial authentication can still leave Pi's auth state
  changed. The cancellation warning says so.
- Dropping the doctor gate means the first prompt can pay for a probe it did not need when the
  user never submits a classified task.

## Implementation and verification

- [Route-local selection and fail-open recovery](../src/index.ts), [per-target
  proofs](../src/verification.ts), [isolated probes](../src/generation-probe.ts), and [reason
  formatting](../src/diagnostics.ts).
- Regressions in [verification](../tests/verification.test.ts),
  [probe](../tests/generation-probe.test.ts), [diagnostics](../tests/diagnostics.test.ts), and
  [runtime](../tests/runtime.test.ts) tests.
- Run `npm run check` for the offline suite, the strict typecheck, and the lint gate.
  Automatic routing stays in `auto` mode; rollout evidence, a shared policy artifact, and
  threshold changes are separate later work.
