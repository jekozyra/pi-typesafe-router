# Configure task routing

The router reads only `typesafe-router.json` under Pi's agent directory (normally `~/.pi/agent`). `PI_CODING_AGENT_DIR` changes that directory. It does not read project files or discover credentials in a repository.

## Map classes to model chains

Copy an [example](../examples/typesafe.json), or run `/typesafe-router setup typesafe` in Pi. Replace every example target with exact IDs from Pi's model catalogue. A provider ID cannot contain a slash; a model ID can.

```json
{
  "version": 1,
  "mode": "off",
  "allowHeadless": false,
  "backend": {
    "type": "typesafe",
    "model": "jev-1.13.0",
    "auth": { "source": "env", "variable": "TYPESAFE_API_KEY" }
  },
  "timeoutMs": 1500,
  "generationProbeTimeoutMs": 15000,
  "minConfidence": 0.8,
  "maxContextChars": 12000,
  "historyMessages": 4,
  "outputReserveTokens": 8192,
  "defaultRoute": "deep",
  "uncertainRoute": "deep",
  "routes": {
    "quick": [{ "provider": "your-provider", "model": "your-fast-model" }],
    "standard": [{ "provider": "your-provider", "model": "your-balanced-model" }],
    "deep": [
      { "provider": "your-provider", "model": "your-strong-model" },
      { "provider": "another-provider", "model": "your-backup-model" }
    ]
  }
}
```

Each chain contains one to eight distinct targets. Order is authoritative: targets without a current successful doctor generation proof, or failing local eligibility, are skipped; selection stops at the first successful `pi.setModel`. A failed first target does not prevent selection of a later successful one. Remaining successful candidates keep their configured order. Doctor deduplicates probes across chains by exact provider/model identity. There is no random sampling, cost lookup, or per-task remote health probe. `auto`, `smart-router`, and `typesafe-router` virtual providers are rejected.

Unknown fields, duplicate targets, invalid types, and out-of-range settings reject the entire file. Missing, unreadable, or invalid configuration disables routing. Repair the file and run `/typesafe-router doctor` to apply it; explicitly enable routing afterward if desired.

| Setting                    | Default | Accepted values                                                                  |
| -------------------------- | ------- | -------------------------------------------------------------------------------- |
| `version`                  | `1`     | `1`                                                                              |
| `mode`                     | `off`   | `off`, `shadow`, `auto`                                                          |
| `allowHeadless`            | `false` | Boolean; explicitly permit automatic routing outside TUI                         |
| `timeoutMs`                | `1500`  | Integer, 100–30000; credentials plus classification                              |
| `generationProbeTimeoutMs` | `15000` | Integer, 100–60000; timeout for each model’s doctor generation probe             |
| `minConfidence`            | `0.8`   | Number, 0–1                                                                      |
| `maxContextChars`          | `12000` | Integer, 256–32000; combined request and history text                            |
| `historyMessages`          | `4`     | Integer, 0–20                                                                    |
| `outputReserveTokens`      | `8192`  | Integer, 256–131072; capped at candidate's maximum output                        |
| `defaultRoute`             | `deep`  | `quick`, `standard`, `deep`; classifier failure/unavailability                   |
| `uncertainRoute`           | `deep`  | Same values; uncertainty, absent/low confidence, oversized or unexpanded request |

`generationProbeTimeoutMs` is a top-level setting applied separately to each distinct model probe, not a total doctor deadline. Probes request `maxTokens: 128` where supported and `maxRetries: 0`; these are fixed probe options, not configuration fields. They do not establish a strict monetary cap.

Character limits use JavaScript string length. The current request is never truncated. If it cannot fit, classification is skipped and the conservative route is used. Only contiguous newest fitting conversation text is included. Set `historyMessages: 0` for request-only classification.

## Select one classification backend

### TypeSafe direct

```json
{
  "type": "typesafe",
  "model": "jev-1.13.0",
  "auth": { "source": "env", "variable": "TYPESAFE_API_KEY" }
}
```

Requests go to `https://api.typesafe.ai/v1/systemone`. The versioned model ID is the default; explicitly configured aliases may change behavior over time. No automatic retries occur.

### Cloudflare Workers AI

```json
{
  "type": "cloudflare",
  "accountId": "0123456789abcdef0123456789abcdef",
  "model": "typesafe/jev",
  "auth": { "source": "env", "variable": "CLOUDFLARE_API_TOKEN" }
}
```

Use your own 32-hex-character account ID and a token authorized for Workers AI. The fixed account-scoped REST endpoint is `https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run`. This is Workers AI evaluation, not arbitrary Cloudflare AI Gateway chat compatibility.

### Vercel AI Gateway

```json
{
  "type": "vercel",
  "model": "typesafe-ai/jev",
  "zeroDataRetention": true,
  "auth": { "source": "env", "variable": "AI_GATEWAY_API_KEY" }
}
```

This uses AI SDK `experimental_evaluate`, pinned to SDK `7.0.105`, and the Gateway evaluation model interface. No OpenAI-compatible chat endpoint is involved. `zeroDataRetention` defaults to true; the provider may reject unsupported retention options instead of silently weakening them.

Confidence is read from the per-question `providerMetadata.typesafe.confidence.task_class` map. Public documentation identifies the enclosing confidence metadata but does not demonstrate its full shape. Missing confidence remains missing and selects `uncertainRoute`; malformed confidence fails validation and selects `defaultRoute`. Run `/typesafe-router doctor` with your account before relying on this experimental integration. No live service parity is claimed.

### Optional Pi-managed credentials

All backends also accept `{"source":"pi","provider":"your-provider-id"}` as `auth`. This calls Pi 0.85.1's `getProviderAuth` at request time. It is opt-in, never an implicit fallback from a missing environment key. Only the resolved API key is forwarded; custom auth headers are not. A provider credential does not establish that the target evaluation endpoint accepts it. Verify audience, permissions, and backend compatibility yourself. Environment credentials are the recommended initial setup.

## Commands

| Command                                | Effect                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `setup [typesafe\|cloudflare\|vercel]` | Interactive creation of an off-mode config; never overwrites                                               |
| `doctor`                               | Apply config, test the classifier and distinct generation targets, and refresh session verification        |
| `status` (default)                     | Read-only report of applied config, runtime mode, current model/activity, and disk differences; no network |
| `on` / `shadow` / `off`                | Change session mode; on/shadow require successful doctor; off cancels preflight                            |

Prefix each with `/typesafe-router`. With no subcommand, the command shows status.

`doctor` reloads valid configuration while preserving the current session's on/off/shadow mode, rather than adopting the file's mode. It never enables an off session. Missing or invalid configuration disables routing. It never changes the selected generation model or runs or replays a user task.

Doctor automatically sends one synthetic classifier request and one isolated synthetic generation request per distinct configured provider/model, without confirmation. No actual conversation transcript is sent, and generation probes have `tools: []`. **These requests may incur charges**; there is no strict monetary cap. Explicit invocation authorizes them even with routing off or in print/RPC mode with `allowHeadless: false`. Automatic routing in those modes still requires `allowHeadless: true` and an enabled mode. Headless diagnostics go to stderr, not the assistant's output.

Generation probes run through Pi's `modelRegistry.complete`, using the actual configured credential providers, including OAuth, custom headers, and custom endpoints. Credentials may refresh during diagnostics. This differs from the classifier's optional API-key-only Pi credential reuse described above.

Readiness requires doctor to complete successfully, including the classifier check, and at least one locally eligible, successfully probed target in each of `quick`, `standard`, and `deep`. Not every target must pass. Failed targets are skipped in subsequent preflight, preserving the configured order of remaining successful candidates. Until ready, `on`, `shadow`, and automatic input are blocked; `off` and manual Pi use remain available. A configured startup mode does not bypass verification.

Verification is session-only and never persisted. Restart/reload requires doctor again. Changes to routes, credential references, backend configuration, or model metadata invalidate it even if provider/model IDs stay the same. Native auth status and provider references contribute to an in-memory identity hash; no secrets are persisted. Each doctor refresh invalidates previous proofs. Cancellation or incomplete checks never partially unlock routing; run doctor again to recover.

Doctor reports runtime, config path/application result, actual session mode, current generation model, backend/model, credential source, local eligibility, classifier result/latency, generation probe outcomes, and readiness. Reports give conditional next steps for the actual state. Local eligibility alone does not prove generation-provider health; a successful probe is a health snapshot, not a guarantee of later availability, quota, or task quality.

Status reports the applied configuration, not merely the file on disk. It identifies disk differences or inability to check the file, and labels the last routing decision as historical. It neither applies changes nor tests services. Use doctor to apply and test changes.

Escape/Ctrl+C in the TUI or `off` cancels preflight. While Pi's non-cancellable model setter is pending, the selection lock remains held; verify the selected model before resubmitting. Doctor is serialized with preflight/model selection.

After generation fails, use `/model`, inspect completed tool effects, and manually continue when safe. The router performs no post-generation fallback and never replays a task.

Manual `/model` selection turns routing off. Ordinary tool loops and queued steering/follow-up messages do not reroute. Session-tree navigation turns routing off. Active preflight blocks concurrent submissions and session navigation; after cancellation settles, repeat the desired submission/navigation yourself.
