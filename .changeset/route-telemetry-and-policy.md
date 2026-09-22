---
"pi-typesafe-router": minor
---

Route-local verification with fail-open recovery, a per-target thinking level, a validated
classifier policy artifact, consumer-selected policy paths, privacy-bounded decision and
outcome telemetry, and a rubric hash recorded in every decision.

A configuration is version 1 or version 2. Version 2 states the classifier projection in
`historyRoles`, and `/typesafe-router setup` writes user-only. Every route target carries a
`thinking` level applied after the route selects it.

Automatic routing now classifies the real prompt once, probes only the selected route, and
continues on Pi's current model whenever routing cannot complete. A router fault no longer
consumes the submitted prompt; only an explicit cancellation does. `/typesafe-router doctor
local` reports offline while `doctor live` probes the classifier and every configured target.

The classifier rubric is one validated artifact. Set an absolute `policyPath` in the
configuration to use a different file; an unreadable or invalid policy disables automatic
routing instead of falling back to the bundled rubric.

Successful live doctor verification is persisted per target and restored after a reload or
tree navigation when its target, provider, credential reference, and resolved catalogue entry
still match. Stale proofs are dropped and never claim validity across a change the process can
observe.

Every applied route now records exactly one terminal outcome, including a run that settles
before any assistant message is observable: that case is recorded once as `aborted` with a
response count of zero. External policy files and the router configuration are read through a
bounded, non-blocking regular-file reader, so a FIFO or oversized file fails loudly instead of
hanging Pi.
