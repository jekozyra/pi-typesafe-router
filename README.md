# pi-typesafe-router

Use Jev to classify requests and route them to the right model for the task.

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

Configuration examples are provided for [TypeSafe](examples/typesafe.json), [Cloudflare](examples/cloudflare.json), [Vercel](examples/vercel.json), and [OpenRouter](examples/openrouter.json).

To use one:

```text
/typesafe-router setup [typesafe|cloudflare|vercel|openrouter]
```

| Backend               | Credential                                                | Model               |
| --------------------- | --------------------------------------------------------- | ------------------- |
| TypeSafe              | `TYPESAFE_API_KEY`                                        | `jev-1.13.0`        |
| Cloudflare AI Gateway | `CLOUDFLARE_API_TOKEN`, account and gateway IDs in config | `typesafe/jev`      |
| Vercel AI Gateway     | `AI_GATEWAY_API_KEY`                                      | `typesafe-ai/jev`   |
| OpenRouter            | `OPENROUTER_API_KEY`                                      | `typesafe/jev-1.13` |

## Project structure

- `src/classifier.ts`: transport adapters and response validation.
- `src/config.ts`, `context.ts`, `routing.ts`: schema, bounded text projection, and deterministic policy.
- `src/index.ts`, `settings.ts`: Pi lifecycle, commands, cancellation, and global settings.
- `tests/`: synthetic transport, policy, lifecycle, and real Pi SDK tests. No paid API calls.
- `infra/github/`: [Pulumi-managed repository settings](infra/github/README.md) and `main` ruleset.
- `docs/`: architecture decision records (ADRs), recording implemented decisions and their tradeoffs.

## Testing

Run `npm run check` for offline tests, lint, formatting, and typechecking.

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
