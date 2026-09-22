# ADR 0006: Record routing telemetry without recording the prompt

Status: Accepted — implemented against Pi 0.85.1. Extends
[ADR 0004](0004-route-local-verification-and-recovery.md) and
[ADR 0005](0005-policy-provenance-and-local-diagnostics.md).

## Context

Automatic routing decides which model answers a prompt, and nothing in the session records
whether routing behaved as intended. The only evidence is a synthetic calibration harness, which
measures classifier labels on twenty hand-written prompts and says nothing about real work.

Two facts constrain what a record may hold. A session file is long-lived, copied, and read by
other tools, so anything written there should be safe to read years later. And a prompt is the
most sensitive thing in a session: it can contain a credential, a customer name, or an incident
detail. Hashing it does not help, because a short prompt can be recovered from its digest.

## Decision

We will record routing telemetry as Pi session custom entries, and we will record counts,
narrow enums, hashes, and numbers only.

Three kinds of entry, each with its own custom type:

| Entry                      | Written when                              | Contents                                                                                                                                         |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `typesafe-router-decision` | routing completes                         | route, mode, applied status, ordered candidate outcomes, classifier label and probabilities, margin, latency, provenance hashes, projection size |
| `typesafe-router-outcome`  | the routed run settles                    | provider, model, configured thinking, operational status, stop reason, response count, numeric usage and cost, elapsed time since routing began  |
| `typesafe-router-feedback` | the user runs `/typesafe-router feedback` | the decision it binds to, and one class or `skip`                                                                                                |

Pi custom entries never enter model context, so they are read-only history. No second store, no
database, and no dashboard is added.

### What is never written

No entry holds any of the following:

- prompt text, or any part of the conversation history;
- response text, reasoning, tool results, files, or images;
- a raw provider body or an error body;
- a credential value.

A decision records the _size_ of the projection, never its content. The projection itself is
unchanged by this ADR: version 2 configuration already sends user text only
([ADR 0005](0005-policy-provenance-and-local-diagnostics.md)).

### The serializer is the boundary

`src/telemetry.ts` is the only module that builds these payloads, and each builder validates its
output against a strict schema before returning it. `src/index.ts` appends only a validated
payload, and drops one that does not match with a warning. A future change that adds a text field
therefore fails the schema instead of writing it. Losing a telemetry entry is cheaper than
leaking one.

The schema enforces the shape, not the intent: reasons are bounded lowercase tokens, identifiers
carry no whitespace, and probabilities and costs are finite numbers. Usage numbers that are not
finite are dropped individually rather than voiding the entry.

### An outcome is operational, not semantic

`typesafe-router-outcome` records that the routed run settled, aborted, or errored, how many
assistant responses it produced, and what it cost. If any response omits a numeric usage or cost
component, the aggregate omits that component instead of treating the missing value as zero. An
outcome never records whether the answer was correct, and no field in this design is a quality
signal. Only a decision that actually applied a target receives an outcome; a shadow decision and
a decision that fell back to the current model receive none, because neither produced a routed
generation. An applied route that settles before any assistant message is observable is still one
routed generation, so it is recorded once as `aborted` with a response count of zero.

### Feedback is a fixed enum

`/typesafe-router feedback quick|standard|deep|uncertain|skip` appends one entry bound to the
newest decision on the active branch. It accepts no free text, and it does not change routing,
the threshold, or any model binding — it is a label for later analysis, nothing more. A decision
that carries no `decisionId`, including one written by another copy under the upstream type name,
is not feedback-eligible.

### The report measures and refuses to conclude

A report over the session file aggregates legacy and version-2 entries. It reads the confidence
threshold from each entry rather than assuming one. It reports:

- route, label, and target counts;
- confidence and margin bins;
- classifier-model mismatches and infrastructure failures;
- candidate fallback positions;
- shadow versus applied decisions;
- outcome coverage, observed usage, and observed cost;
- feedback confusion against the decision each label bound to.

It does not claim the work was correct or that money was saved; the output states both as
`not_measured` and `not_claimed`. A cost derived from `--input-price-per-million` is labelled an
estimate, and observed cost from provider-reported usage is not. If any outcome omits a usage
component, its aggregate is `null` rather than a partial sum presented as a total; per-component
coverage reports how many outcomes supplied it. Every string the report echoes passes through a
sanitiser that removes whitespace and replaces a credential-shaped value, so the report cannot
become the place a secret that reached an entry becomes readable.

A malformed session line is counted and skipped. Failing the whole report over one damaged line
would hide the entries that are intact.

## Consequences and alternatives

- Evidence now accumulates from real work. The previously recorded synthetic calibration stays a
  regression smoke test, not a production-accuracy claim.
- Decision entries are larger than the pre-existing payload, and one outcome entry is added per
  routed run. Both stay bounded and carry no user content.
- Because a payload is dropped rather than repaired when it fails its schema, a future bug can
  lose telemetry silently apart from one warning. That is the deliberate direction of the
  trade-off.
- Telemetry records a decision only when the router ran. A session that fell back to the current
  model still records the decision and its fallback reason, so the fallback is measurable.
- Feedback can be attached to a decision from a previous session in the same branch, because the
  lookup reads the branch rather than an in-memory reference. It cannot be attached across
  sessions, since the branch does not include them.
- Outcome coverage is a coverage number, not a success rate. It counts matched entries, which is
  exactly as much as an operational record can support.

Rejected alternatives:

- a prompt digest, because a short prompt can be recovered from its hash;
- a separate `~/.pi` telemetry file, which is a second store to secure, rotate, and back up;
- a web dashboard, because no data existed to display and the report already runs offline;
- post-generation Jev grading, a second model call that would still not establish correctness.

## Implementation and verification

- [Payload builders and schemas](../src/telemetry.ts) and [lifecycle wiring](../src/index.ts).
- Regressions live in [telemetry units](../tests/telemetry.test.ts) and the [router
  lifecycle](../tests/runtime.test.ts).
- Run `npm run check` for the offline suite, the strict typecheck, and the lint gate.
