# pi-typesafe-router

An opt-in [Pi](https://github.com/earendil-works/pi) extension that asks Jev to classify a task, then selects a generation model from your ordered mappings.

Classification supports **TypeSafe direct, Cloudflare Workers AI, and Vercel AI Gateway**. Model fallback happens only before generation. A failed task is never automatically replayed by this extension.

## Setup

Requires Node.js 22.19+ and Pi 0.85.1. This is an unpublished local implementation; no live backend credentials have been tested.

From this checkout, install dependencies and load the extension for one session:

```sh
npm ci
pi -e ./src/index.ts
```

Do not enable this alongside another automatic router. Choose a real provider/model in Pi first, then run:

```text
/typesafe-router setup typesafe
```

This creates `~/.pi/agent/typesafe-router.json`, initially **off**, using your selected model for all three routes. It never overwrites a file. Edit the mappings, set `TYPESAFE_API_KEY` in the environment that launches Pi, and restart Pi. Never put the key in your prompt or config file.

For a persistent local installation, use `pi install /absolute/path/to/pi-typesafe-router`. Once published, the equivalent will be `pi install npm:pi-typesafe-router`.

## Usage

Validate the mappings, optionally test a synthetic request, then enable routing:

```text
/typesafe-router validate
/typesafe-router check
/typesafe-router on
```

Use `shadow` instead of `on` to classify without changing the model. **Shadow mode still transmits text and can incur charges.** `/typesafe-router off` stops classification. `/model` selection also turns automatic routing off. Session mode changes are recorded in that session; `reload` resets to the file's mode.

Escape, Ctrl+C, or `/typesafe-router cancel` cancels preflight and stops the original prompt. If Pi is already resolving generation credentials, cancellation waits for its non-cancellable model setter; verify the selected model before resubmitting. Prompts rejected or cancelled during preflight are not automatically queued or replayed.

After a failed routed generation, `/typesafe-router recover` explicitly selects the next eligible model and turns routing off. **It sends no message.** Review completed tool effects before deciding what to send next. Pi's own retry and compaction settings remain unchanged.

## Configuration

See the [configuration reference](docs/configuration.md) and examples for [TypeSafe](examples/typesafe.json), [Cloudflare](examples/cloudflare.json), and [Vercel](examples/vercel.json). Only the global file is read; `PI_CODING_AGENT_DIR` relocates it. Project-local configuration is intentionally ignored.

| Backend | Credential | Model |
| --- | --- | --- |
| TypeSafe | `TYPESAFE_API_KEY` | `jev-1.13.0` |
| Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN`, account ID in config | `typesafe/jev` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `typesafe-ai/jev` |

Backends are explicit; there is no cross-backend failover. Vercel uses the experimental AI SDK evaluation protocol, not a chat-completions endpoint. Missing confidence uses the conservative route; confidence is **not** the probability that the generation model will solve your task.

## Project structure

- `src/classifier.ts`: transport adapters and response validation.
- `src/config.ts`, `context.ts`, `routing.ts`: schema, bounded text projection, and deterministic policy.
- `src/index.ts`, `settings.ts`: Pi lifecycle, commands, cancellation, and global settings.
- `tests/`: synthetic transport, policy, lifecycle, and real Pi SDK tests. No paid API calls.
- `docs/`: [privacy](docs/privacy.md), [architecture and limits](docs/architecture.md), and [release checklist](docs/releasing.md).

## Contributing

Run `npm run check` before proposing changes. Tests must remain offline and must not read real credentials. Use `npm run smoke:package` to check the packed extension in an isolated Pi installation. Public benchmark or performance claims require clarification of TypeSafe's terms first.

## License

[MIT](LICENSE). Third-party models, services, and dependencies retain their own terms.
