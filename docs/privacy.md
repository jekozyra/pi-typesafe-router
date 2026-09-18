# What leaves your machine

Enabling `auto` or `shadow` sends the current request and bounded recent user/assistant text to the configured classification backend. That text can contain private code, credentials, or personal data. **This extension is not a secret scanner or redaction system.** Do not enable it for material you cannot share with that backend.

The default projection excludes system prompts, raw tool calls/results, reasoning blocks, image bytes, attachments, compaction summaries, and arbitrary files. If an assistant quotes a tool result or secret in ordinary text, that text can still be included. Slash-command/template input is not classified before expansion; the conservative route is used instead. There is no background classification while the router is off.

## Recipients and retention

- Direct: TypeSafe's API.
- Cloudflare: your account's Workers AI endpoint and its upstream service arrangement.
- Vercel: AI Gateway and its upstream service arrangement. The request explicitly enables `zeroDataRetention` by default.

The router never silently changes classification backends, follows HTTP redirects, or retries classification. A failed classifier uses a local configured generation route instead. Generation content goes to the model provider selected in Pi, under that provider's normal settings.

No-training promises do not establish zero data retention. TypeSafe's enterprise ZDR offering, gateway logging, account controls, and contract terms need separate review. The extension cannot verify a service's retention behavior. Review [TypeSafe's terms](https://typesafe.ai/legal/mca), [Cloudflare's model documentation](https://developers.cloudflare.com/ai/models/typesafe/jev/), and [Vercel's evaluation documentation](https://vercel.com/docs/ai-gateway/modalities/evaluation) before sharing sensitive content.

## Local data and credentials

Configuration is global and contains credential references, not keys. Setup creates it with mode `0600` where supported. Existing files and symlinks are never overwritten. Credentials are resolved at request time and are not placed in session records. Pi-managed credential reuse is explicit and forwards only an API key, not provider-specific headers.

Session custom entries contain route/model IDs, classifier labels/probabilities/confidence, normalized usage, elapsed time, safe failure reasons, and skipped candidates. They do not contain request text, raw responses, HTTP error bodies, or API keys. Pi itself already records ordinary conversation content independently of this extension. There is no extension telemetry or external analytics.

Diagnostics report configuration errors without printing Zod values or filesystem error bodies. Model IDs and config paths are shown locally; do not use secrets as identifiers. Gateway/provider warnings are suppressed rather than printed verbatim.
