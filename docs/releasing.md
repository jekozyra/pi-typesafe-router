# Release checklist

Nothing in this repository publishes automatically. The package name was available during research, but is not reserved. There is no configured remote or maintainer identity yet.

## Before the first release

1. Confirm ownership of the npm name and choose the public Git repository. Add accurate `repository`, `homepage`, and `bugs` metadata to `package.json`.
2. Confirm the MIT license choice and maintainer identity. Review the public artifact list; research, local paths, tests, and development scripts are not shipped.
3. Run `npm ci`, `npm run check`, and `npm run smoke:package` on the supported Node/Pi versions. Inspect `npm pack --dry-run`.
4. With explicit approval for network charges, run `/typesafe-router doctor` for each backend and configured generation target set with least-privilege credentials. Doctor preserves session mode and sends a synthetic classifier request plus one isolated generation probe per distinct provider/model, without confirmation, actual conversation transcript, or tools. It may incur charges even while off or headless with `allowHeadless: false`; token/deadline limits are not a strict monetary cap. Confirm response shape, confidence extraction, permissions, and cancellation. Do not capture keys or raw private state in fixtures. Check the following:
   - Probes use Pi's `modelRegistry.complete` and actual credential providers, including OAuth refresh, custom headers, and custom endpoints. Options are `tools: []`, `maxTokens: 128` where supported, and `maxRetries: 0`. The top-level `generationProbeTimeoutMs` defaults to 15000 and accepts only integers from 100 through 60000, applied per model.
   - Readiness requires completed doctor success, including the classifier, and at least one locally eligible, successfully probed candidate in every quick/standard/deep route. Failed targets, including the first configured target, are skipped during later preflight; successful targets retain their configured order.
   - `on`, `shadow`, and automatic input are blocked without readiness; off/manual Pi use remains available. Doctor does not change the selected model or replay a user task.
   - Proofs are session-only and never persisted. Restart/reload requires doctor again. Route, credential-reference, backend, and model-metadata changes invalidate verification even under unchanged provider/model IDs. Native auth status/provider references contribute to an in-memory hash without persisting secrets.
   - Refresh invalidates old proofs, and cancellation or incomplete work never partially unlocks routing. Treat successful probes as health snapshots, not guarantees of future generation success.
5. Privately evaluate representative tasks. Seek clarification of TypeSafe MCA §2.3(f) before public benchmarks, performance numbers, or comparative claims.
6. Review privacy disclosures and experimental Vercel limitations. Choose the package version and record changes.
7. Configure npm trusted publishing for the chosen repository/workflow and an approved release environment. Use OIDC provenance rather than storing a long-lived npm token. This step depends on the final repository identity and is intentionally not preconfigured.
8. Only after release approval, publish the reviewed artifact with public access and provenance. Verify installation into a clean Pi profile.
9. Verify discovery in Pi's package gallery. The manifest already has the `pi-package` keyword and `pi.extensions` entry; gallery indexing is external and is not guaranteed by a local test.

The local smoke script installs the packed tarball and Pi into a temporary directory, disables resource discovery and network during extension loading, and checks the registered command through the actual loader. It does not alter the user's Pi settings or installed extensions.

## Ongoing releases

Keep host compatibility explicit. The tested host is Pi 0.85.1; wildcard optional peers avoid bundling a competing runtime but do not imply every Pi version is compatible. Re-characterize lifecycle/auth changes on a new host version. AI SDK evaluation is experimental and pinned; review serialization/metadata tests before upgrading it.
