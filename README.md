# pi-typesafe-router

An opt-in [Pi](https://github.com/earendil-works/pi) extension that asks Jev to classify a task, then selects a generation model from your ordered mappings.

Supported jev providers are **TypeSafe, Cloudflare AI Gateway, and Vercel AI Gateway**.

## Setup

Do not enable this alongside another automatic router.

Install via:

```bash
`pi install npm:pi-typesafe-router`
```

Choose a real provider/model in Pi first, then run:

```text
/typesafe-router setup typesafe
```

This creates `~/.pi/agent/typesafe-router.json`, initially **off**, using your selected model for all three routes. Edit the mappings, set `TYPESAFE_API_KEY` in the environment that launches Pi, and run `/reload`.

`pi install npm:pi-typesafe-router`.

## Usage

Verify your configuration, then enable routing:

```text
/typesafe-router doctor
/typesafe-router on
```

Doctor tests the classifier and configured models with synthetic requests, without sending your conversation, using tools, or changing the selected model. These checks may incur charges.

Run `/typesafe-router help` for a table explaining every command.

## Configuration

Configuration examples are provided for [TypeSafe](examples/typesafe.json), [Cloudflare](examples/cloudflare.json), and [Vercel](examples/vercel.json).

To use one:

```text
/typesafe-router setup [typesafe|cloudflare|vercel]
```

| Backend               | Credential                                                | Model             |
| --------------------- | --------------------------------------------------------- | ----------------- |
| TypeSafe              | `TYPESAFE_API_KEY`                                        | `jev-1.13.0`      |
| Cloudflare AI Gateway | `CLOUDFLARE_API_TOKEN`, account and gateway IDs in config | `typesafe/jev`    |
| Vercel AI Gateway     | `AI_GATEWAY_API_KEY`                                      | `typesafe-ai/jev` |

## Project structure

- `src/classifier.ts`: transport adapters and response validation.
- `src/config.ts`, `context.ts`, `routing.ts`: schema, bounded text projection, and deterministic policy.
- `src/index.ts`, `settings.ts`: Pi lifecycle, commands, cancellation, and global settings.
- `tests/`: synthetic transport, policy, lifecycle, and real Pi SDK tests. No paid API calls.
- `docs/`: [0001 — pre-generation routing](docs/0001-route-before-generation.md) and [0002 — doctor verification](docs/0002-verify-routing-with-doctor.md), recording implemented decisions and their tradeoffs.

## Testing

Run `npm run check` for offline tests, lint, formatting, and typechecking.

Live E2E tests cover TypeSafe, Cloudflare, and Vercel. Each authenticates to Jev through the production adapter, then runs the real Pi CLI's `doctor` and checks session verification. All tiers use OpenRouter's `openai/gpt-5.6-luna` from the same [stock configuration](tests/e2e/fixtures/router.json).

Provide these environment variables through your shell or secret manager; never commit keys:

| Service    | Required variables                                                       |
| ---------- | ------------------------------------------------------------------------ |
| Generation | `OPENROUTER_API_KEY`                                                     |
| TypeSafe   | `TYPESAFE_API_KEY`                                                       |
| Cloudflare | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID` |
| Vercel     | `AI_GATEWAY_API_KEY`                                                     |

Then explicitly opt into paid calls:

```sh
TYPESAFE_ROUTER_LIVE_E2E=1 npm run test:e2e
```

Tests use temporary Pi profiles, do not read personal Pi credentials, and leave routing off. They cover API-key authentication, not interactive OAuth login. Live tests are excluded from `npm test`, `npm run check`, and automatic CI.

## License

[MIT](LICENSE). Third-party models, services, and dependencies retain their own terms.
