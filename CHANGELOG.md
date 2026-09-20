# pi-typesafe-router

## 0.2.1

### Patch Changes

- 2f31bbc: Release metadata files can now be up to 1 MiB without triggering the generated changeset size limit, while oversized files are rejected with clearer errors and their response bodies are cancelled.
- e611624: Preserve lockfile dependency metadata during release versioning by updating only the package version fields instead of regenerating the lockfile.

## 0.2.0

### Minor Changes

- 37e5553: Release preparation now supports bootstrapping the initial 0.1.0 release when its npm package, Git tag, and GitHub Release are all absent, while continuing to reject partial or ambiguous release states.

### Patch Changes

- 885c7ba: Update release automation to supported Node and Changesets versions and pin CI runners to Ubuntu 24.04.
