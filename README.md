# pi-typesafe-router

Use Jev to classify requests and route them to the right model for the task.

## Setup

Do not enable this alongside another automatic router.

Install via:

```bash
pi install npm:pi-typesafe-router
```

Choose a real provider/model in Pi first, then run:

```text
/typesafe-router setup typesafe
```

This creates `~/.pi/agent/typesafe-router.json`, initially **off**, using your selected model
for all three routes. Edit the mappings, set `TYPESAFE_API_KEY` in the environment that
launches Pi, and run `/reload`.

## Usage

A classified prompt is probed only on the route it selects, and it continues on Pi's current
model whenever routing cannot complete. A router fault never drops the submitted prompt; only
an explicit cancellation does.

```text
/typesafe-router doctor local  # offline: config, catalogue, scope, and hashes only
/typesafe-router doctor live   # adds a synthetic classifier call and every target probe
/typesafe-router feedback deep # label the newest decision with the class it should have taken
/typesafe-router on            # enable automatic routing for this session
/typesafe-router shadow        # classify without switching models
/typesafe-router off           # disable it for this session
```

`doctor live` sends synthetic requests to the classifier and to every distinct configured
model; those checks may incur charges. It never sends your conversation, uses tools, or changes
the selected model. `doctor local` makes no request at all. Bare `/typesafe-router doctor` is a
compatibility alias for `doctor live`.

Automatic routing does not require a doctor run. A classified prompt earns a proof for the
target it actually selects, and `doctor live` is how you pre-warm every route or diagnose an
account. A successful live doctor run persists its proofs in the session; a reload or tree
navigation restores the ones whose configuration, model, provider, and credential references
still match.

Escape or `/typesafe-router off` during an active routing decision cancels it and restores the
submitted text to the editor. Image attachments are not restored.

## What leaves the machine

The classifier receives the current request plus recent conversation text, bounded by
`maxContextChars` and `historyMessages`. Configuration version 2 states which roles those are;
`/typesafe-router setup` writes `"historyRoles": ["user"]`, so assistant messages never leave
the machine. A version-1 file keeps the historical user-and-assistant projection, and
`/typesafe-router on` reports the projection it will actually use.

Tool results, files, images, reasoning, and the system prompt are never projected. Decision
entries store the route, the confidence, and provenance hashes; they store no prompt text and
no credential value.

## What is recorded

Each routing decision appends a session custom entry, and so does the generation it routed. Pi
custom entries never enter model context. What they hold is counts, enums, hashes, and numbers:

| Entry                      | Held                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typesafe-router-decision` | route, mode, applied status, ordered candidate outcomes, label and probabilities, margin, latency, provenance hashes, projection size              |
| `typesafe-router-outcome`  | provider, model, configured thinking, settled/aborted/error, stop reason, response count, numeric usage and cost, elapsed time since routing began |
| `typesafe-router-feedback` | the decision it binds to, and one class or `skip`                                                                                                  |

No entry holds prompt text, conversation text, response text, a raw provider body, or a
credential value. An outcome states that a run settled, errored, or aborted; it never states
that the work was correct.

Every applied route records exactly one terminal outcome, even when generation ends before any
assistant message is observable: that case is recorded as `aborted` with a response count of
zero, so a decision is never left without its outcome.

`/typesafe-router feedback quick|standard|deep|uncertain|skip` labels the newest decision on the
active branch. It accepts no free text and changes no routing behavior. A decision written by
another copy under the upstream type name carries no ID and cannot be labelled.

Because each submitted prompt may select a different model, alternating route classes can
repeatedly lose provider prompt-cache reuse and raise total cost; routing is not assumed to
save money.

Run `/typesafe-router help` for a table explaining every command.

## Configuration

Configuration examples are provided for [TypeSafe](examples/typesafe.json),
[Cloudflare](examples/cloudflare.json), [Vercel](examples/vercel.json), and
[OpenRouter](examples/openrouter.json). To use one:

```text
/typesafe-router setup [typesafe|cloudflare|vercel|openrouter]
```

The backend credential environment variables and classifier models are:

| Backend               | Credential                                                | Model               |
| --------------------- | --------------------------------------------------------- | ------------------- |
| TypeSafe              | `TYPESAFE_API_KEY`                                        | `jev-1.13.0`        |
| Cloudflare AI Gateway | `CLOUDFLARE_API_TOKEN`, account and gateway IDs in config | `typesafe/jev`      |
| Vercel AI Gateway     | `AI_GATEWAY_API_KEY`                                      | `typesafe-ai/jev`   |
| OpenRouter            | `OPENROUTER_API_KEY`                                      | `typesafe/jev-1.13` |

A configuration is version 1 or version 2. Version 1 has no projection field and keeps the
historical user-and-assistant disclosure. Version 2 states it in `historyRoles`.

Every target carries a `thinking` level that is applied after the route selects it, so the
model catalog owns availability while the route owns the effort appropriate to the task.

### Rubric

`policy.json` beside the extension is the classifier rubric: the instructions, the question
key, and one criterion per class. It is validated strictly at load.

Set an absolute `policyPath` in the configuration to use a different artifact:

```json
{
  "version": 2,
  "mode": "auto",
  "historyRoles": ["user"],
  "policyPath": "/absolute/path/to/policy.json",
  "backend": {
    "type": "typesafe",
    "model": "jev-1.13.0",
    "auth": { "source": "env", "variable": "TYPESAFE_API_KEY" }
  },
  "routes": {
    "quick": [
      { "provider": "deepseek", "model": "deepseek-flash", "thinking": "low" },
      { "provider": "openai-codex", "model": "gpt-5.1", "thinking": "low" }
    ],
    "standard": [{ "provider": "openai-codex", "model": "gpt-5.1", "thinking": "medium" }],
    "deep": [{ "provider": "openai-codex", "model": "gpt-5.1", "thinking": "high" }]
  }
}
```

The external file is validated with the same schema, its canonical hash is recorded in every
decision, and an unreadable or invalid file disables automatic routing rather than silently
falling back to the bundled rubric. A relative path is rejected. The path must name a regular
file of at most 64 KiB; a directory, FIFO, or device is refused instead of being read.

### Provenance

Provenance depends on the backend. Direct backends must return the configured model; a missing
or different model ID is a `model-mismatch` failure and the prompt continues on the current
model. Gateway backends cannot attest an upstream model and keep their alias pinned by the
schema instead. [ADR 0005](docs/0005-policy-provenance-and-local-diagnostics.md) records the
full contract.

## Project structure

- `policy.json`: the default classifier rubric.
- `src/bounded-file.ts`: the bounded, non-blocking regular-file read shared by the policy and
  the router configuration.
- `src/policy.ts`: strict validation for the bundled artifact and any configured `policyPath`.
- `src/classifier.ts`: transport adapters and response validation.
- `src/config.ts`, `context.ts`, `routing.ts`: schema, bounded text projection, and
  deterministic policy.
- `src/provenance.ts`: canonical hashes for the policy, configuration, and candidate snapshot,
  plus the classifier-model provenance check.
- `src/verification.ts`, `generation-probe.ts`: per-target access proofs and the synthetic probe.
- `src/telemetry.ts`: the versioned decision, outcome, and feedback payloads, and the strict
  schemas that are the only thing separating a routing event from a session file.
- `src/index.ts`, `settings.ts`: Pi lifecycle, commands, cancellation, and file access.
- `tests/`: offline transport, policy, filesystem, lifecycle, and real Pi SDK tests. No paid API
  calls.
- `docs/`: architecture decision records:
  - [ADR 0006](docs/0006-routing-telemetry-boundaries.md): telemetry boundaries;
  - [ADR 0005](docs/0005-policy-provenance-and-local-diagnostics.md): shared policy,
    provenance, and local or live diagnostics;
  - [ADR 0004](docs/0004-route-local-verification-and-recovery.md): route-local verification
    and fail-open recovery;
  - [ADR 0002](docs/0002-verify-routing-with-doctor.md): the superseded doctor gate;
  - [ADR 0001](docs/0001-route-before-generation.md): the original routing boundary.
- `infra/github/`: [Pulumi-managed repository settings](infra/github/README.md) and `main`
  ruleset.

## Testing

Run `npm run check` for formatting, lint, typechecking, and the offline tests.

`npm install` also installs the Lefthook pre-commit hook. Each commit formats and lints its
staged files, applying safe fixes before the commit is created. CI runs the same formatting and
lint checks as a required job in parallel with the test matrix.

E2E tests require the following variables to be set:

- `OPENROUTER_API_KEY`
- `TYPESAFE_API_KEY`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_GATEWAY_ID`
- `AI_GATEWAY_API_KEY`

Then:

```sh
TYPESAFE_ROUTER_LIVE_E2E=1 npm run test:e2e
```

## License

[MIT](LICENSE). Third-party models, services, and dependencies retain their own terms.
