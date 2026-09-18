# Configure task routing

The router reads only `typesafe-router.json` under Pi's agent directory (normally `~/.pi/agent`). `PI_CODING_AGENT_DIR` changes that directory. It does not read project files or discover credentials in a repository.

## Map classes to model chains

Copy an [example](../examples/typesafe.json), or run `/typesafe-router setup typesafe` in Pi. Replace every example target with exact IDs from Pi's model catalogue. A provider ID cannot contain a slash; a model ID can.

```json
{
  "version": 1,
  "mode": "off",
  "backend": { "type": "typesafe" },
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

Each chain contains one to eight distinct targets. Order is authoritative: unavailable or ineligible models are skipped; selection stops at the first successful `pi.setModel`. There is no random sampling, cost lookup, or automatic remote health check. `auto`, `smart-router`, and `typesafe-router` virtual providers are rejected.

Unknown fields, duplicate targets, invalid types, and out-of-range settings reject the entire file. An unreadable or invalid file blocks normal routed input until repaired and reloaded, or explicitly disabled with `off`. An absent file leaves the router off.

| Setting               | Default | Accepted values                                                                  |
| --------------------- | ------- | -------------------------------------------------------------------------------- |
| `version`             | `1`     | `1`                                                                              |
| `mode`                | `off`   | `off`, `shadow`, `auto`                                                          |
| `allowHeadless`       | `false` | Boolean; explicitly permit automatic routing outside TUI                         |
| `timeoutMs`           | `1500`  | Integer, 100–30000; credentials plus classification                              |
| `minConfidence`       | `0.8`   | Number, 0–1                                                                      |
| `maxContextChars`     | `12000` | Integer, 256–32000; combined request and history text                            |
| `historyMessages`     | `4`     | Integer, 0–20                                                                    |
| `outputReserveTokens` | `8192`  | Integer, 256–131072; capped at candidate's maximum output                        |
| `defaultRoute`        | `deep`  | `quick`, `standard`, `deep`; classifier failure/unavailability                   |
| `uncertainRoute`      | `deep`  | Same values; uncertainty, absent/low confidence, oversized or unexpanded request |

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

Confidence is read from the per-question `providerMetadata.typesafe.confidence.task_class` map. Public documentation identifies the enclosing confidence metadata but does not demonstrate its full shape. Missing confidence remains missing and selects `uncertainRoute`; malformed confidence fails validation and selects `defaultRoute`. Run `check` with your account before relying on this experimental integration. No live service parity is claimed.

### Optional Pi-managed credentials

All backends also accept `{"source":"pi","provider":"your-provider-id"}` as `auth`. This calls Pi 0.85.1's `getProviderAuth` at request time. It is opt-in, never an implicit fallback from a missing environment key. Only the resolved API key is forwarded; custom auth headers are not. A provider credential does not establish that the target evaluation endpoint accepts it. Verify audience, permissions, and backend compatibility yourself. Environment credentials are the recommended initial setup.

## Commands

| Command                                | Effect                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `setup [typesafe\|cloudflare\|vercel]` | Interactive creation of an off-mode config; never overwrites                                     |
| `on` / `shadow` / `off`                | Change session mode; on/shadow disclose text transmission                                        |
| `cancel`                               | Abort preflight; do not submit the original prompt                                               |
| `status`                               | Show file, mode, backend, and last routing decision                                              |
| `validate`                             | Re-read schema and check local catalogue/auth presence/scope/context, without remote calls       |
| `check`                                | Send one synthetic classifier request, without history; may incur charges                        |
| `reload`                               | Reload the file and use its configured mode                                                      |
| `recover`                              | After a failed routed generation, select the next eligible model; turn routing off; send nothing |

Prefix each with `/typesafe-router`. `check` is explicitly networked even when automatic routing is off. In print/RPC mode it does not show an interactive confirmation; invoking it is the explicit request. Automatic routing in those modes requires `allowHeadless: true` as well as an enabled mode. Headless diagnostics go to stderr, not the assistant's output.

Manual `/model` selection turns routing off. Ordinary tool loops and queued steering/follow-up messages do not reroute. Session-tree navigation turns routing off. Active preflight blocks concurrent submissions and session navigation; after cancellation settles, repeat the desired submission/navigation yourself.
