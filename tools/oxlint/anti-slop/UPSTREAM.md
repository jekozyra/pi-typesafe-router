# Anti-slop provenance

Installed from the bundled `assets/anti-slop/` directory of the local `install-anti-slop` skill on 2026-09-18.

- Source bundle: `/home/devbox/.pi/agent/skills/install-anti-slop/assets/anti-slop/`.
- Source repository and upstream commit: unknown. The supplied skill is not a Git checkout and provides no top-level revision identifier. No claim of latest upstream is made.
- Installed path: `tools/oxlint/anti-slop/`; generic entry point: `index.ts`.
- `PRISTINE.sha256` records the SHA-256 digest of every copied asset, excluding this installation record and the manifest itself. The initial vendored tree is byte-identical to the supplied bundle. Preserve its installation commit as the recoverable pristine base when committing this change.
- Intentional source deviations: none. Only this record and the checksum manifest were added.
- The bundled `effect/` plugin is preserved but not enabled: this repository does not directly depend on Effect.
- Preserve `vendor/eslint-stylistic/LICENSE` and `vendor/eslint-stylistic/UPSTREAM.md`; they describe the nested vendored implementation separately.

Development dependencies `oxlint` and `@oxlint/plugins` are both pinned to `1.83.0`. Upgrade them together. The vendored tree and local agent assets are excluded from lint and formatting; application rules remain errors.
