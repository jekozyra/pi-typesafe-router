# What leaves your machine

Enabling `auto` or `shadow` sends the current request and bounded recent user/assistant text to the configured classification backend. That text can contain private code, credentials, or personal data. **This extension is not a secret scanner or redaction system.** Do not enable it for material you cannot share with that backend.

The default projection excludes system prompts, raw tool calls/results, reasoning blocks, image bytes, attachments, compaction summaries, and arbitrary files. If an assistant quotes a tool result or secret in ordinary text, that text can still be included. Slash-command/template input is not classified before expansion; the conservative route is used instead. There is no background classification while the router is off.

## Explicit diagnostics

`/typesafe-router doctor` applies valid configuration, checks local eligibility, and automatically sends one synthetic classifier request plus one isolated synthetic generation request to each distinct configured provider/model. It sends no actual conversation transcript, uses no tools (`tools: []`), asks for no confirmation, and **may incur charges**. Generation probes request `maxTokens: 128` where supported and `maxRetries: 0`, with a per-model `generationProbeTimeoutMs` deadline (default 15000 ms). These bounds are not a strict monetary cap.

Invoking doctor explicitly authorizes these requests even while routing is off or headless with `allowHeadless: false`; that setting still gates automatic routing. Doctor preserves the current session mode and never enables an off session. Missing or invalid configuration disables routing. Doctor never changes the selected model or runs or replays a user task. Isolated synthetic generation probes are not retries of the actual task.

Doctor must complete successfully, including the classifier check, and establish a locally eligible, successful generation candidate for each route before `on`, `shadow`, or automatic input is allowed. Off/manual Pi use remains available. Verification is session-only: restart/reload and identity changes require doctor again. Refresh discards old proofs; cancellation never partially unlocks routing.

`/typesafe-router status` (also the default) is read-only and makes no network calls. It reports applied configuration, runtime mode/current model, and on-disk differences. Local eligibility is not remote generation verification, and successful probes are only health snapshots, not future guarantees.

## Recipients and retention

- Direct: TypeSafe's API.
- Cloudflare: your account's Workers AI endpoint and its upstream service arrangement.
- Vercel: AI Gateway and its upstream service arrangement. The request explicitly enables `zeroDataRetention` by default.

The router never silently changes classification backends, follows HTTP redirects, or retries classification. A failed classifier uses a local configured generation route instead. Generation content goes to the model provider selected in Pi, under that provider's normal settings. Doctor also sends synthetic probe content to every distinct configured generation target through Pi's `modelRegistry.complete`, including custom endpoints and their normal provider arrangements.

No-training promises do not establish zero data retention. TypeSafe's enterprise ZDR offering, gateway logging, account controls, and contract terms need separate review. The extension cannot verify a service's retention behavior. Review [TypeSafe's terms](https://typesafe.ai/legal/mca), [Cloudflare's model documentation](https://developers.cloudflare.com/ai/models/typesafe/jev/), and [Vercel's evaluation documentation](https://vercel.com/docs/ai-gateway/modalities/evaluation) before sharing sensitive content.

## Local data and credentials

Configuration is global and contains credential references, not keys. Setup creates it with mode `0600` where supported. Existing files and symlinks are never overwritten. Credentials are resolved at request time and are not placed in session records. For classification, Pi-managed credential reuse is explicit and forwards only an API key, not provider-specific headers. Generation probes instead use Pi's actual credential providers, including OAuth and custom headers. Credentials may refresh during doctor, subject to Pi's normal credential storage behavior.

Generation proofs and readiness are held only in memory; the router never persists them. The verification identity covers routes, credential references, backend configuration, and model metadata, including changes under unchanged provider/model IDs. Native auth status and provider references contribute to an in-memory hash. No secrets are persisted by the router for verification.

Session custom entries contain route/model IDs, classifier labels/probabilities/confidence, normalized usage, elapsed time, safe failure reasons, and skipped candidates. They do not contain request text, raw responses, HTTP error bodies, or API keys. Pi itself already records ordinary conversation content independently of this extension. There is no extension telemetry or external analytics.

Diagnostics report configuration errors without printing Zod values or filesystem error bodies. Model IDs and config paths are shown locally; do not use secrets as identifiers. Gateway/provider warnings are suppressed rather than printed verbatim.
