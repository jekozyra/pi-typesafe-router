# ADR 0003: Automate changesets and npm releases

Status: Accepted — pending repository and npm activation

## Context

Pull requests need release metadata before merge, but asking contributors to choose package versions or write Changesets makes release policy part of every contribution. Publishing also needs a deliberate review boundary without a long-lived npm token.

The automation handles untrusted pull-request content and uses GitHub App and OpenRouter credentials. It must not execute pull-request code in a privileged workflow. This package remains pre-1.0, so breaking changes increment the minor version rather than producing `1.0.0`.

## Decision

We generate one deterministic Changeset for each same-repository pull request, prepare releases only through a manual workflow, and publish only when the managed release pull request merges. Reviewing and merging that pull request authorizes npm publication.

```text
same-repository PR → classify impact → generated Changeset
                   → merge to main
manual dispatch    → managed release PR → review and merge
                   → exact merged commit → npm → tag and GitHub Release
```

### Pull-request Changesets

`.github/workflows/changeset.yml` uses `pull_request_target` and checks out only the trusted base revision. It never checks out, installs, or executes pull-request code. It reads GitHub's diff API as bounded data and rejects forks before creating credentials.

The model in the `RELEASE_CLASSIFIER_MODEL` Actions variable chooses `none`, `patch`, `minor`, or `major`. For releasable changes, the model in `RELEASE_WRITER_MODEL` writes the changelog prose. Both requests go through OpenRouter. Code owns the package name, filename, frontmatter, and bump mapping. A `major` classification becomes a Changesets `minor` bump while retaining breaking-change wording.

A releasable pull request owns `.changeset/pr-<number>.md`. Regeneration overwrites edits to that file. A `none` decision removes an obsolete generated file. The head-specific `release / changeset` check records successful `none` decisions. Incomplete or oversized diffs, missing binary patches, stale writes, and invalid model output fail closed.

### Maintainer overrides

Apply exactly one override label:

- `release:none`
- `release:patch`
- `release:minor`
- `release:major`

The actor who applied the label must have write, maintain, or admin permission. A releasable override also requires this pull-request body section:

```markdown
## Release note

Concise user-facing description. Start with `Breaking:` when applicable.
```

Overrides do not call OpenRouter. Conflicting labels, unauthorized actors, and missing release notes fail the check. Review the override again after substantive changes.

### Release preparation

Run **Prepare release** manually from `main`. The workflow first requires the current version to exist on npm with a matching `vX.Y.Z` tag and GitHub Release. It then uses Changesets in version-only mode to consume pending Changesets, update `package.json`, `package-lock.json`, and `CHANGELOG.md`, and create or refresh `changeset-release/main`. With no pending Changesets, it does nothing.

Do not merge `main` into a stale release branch. If `main` advances, rerun **Prepare release**, wait for strict up-to-date checks, and review the candidate again. Validation rejects unrelated files, unconsumed Changesets, version or lockfile drift, malformed changelogs, forged identity, and versions at or above `1.0.0`.

### Publication

Configure npm trusted publishing for owner `jekozyra`, repository `pi-typesafe-router`, and workflow `publish.yml`. The workflow uses a GitHub-hosted runner, Node 22.19.0, npm 12.0.2, and `id-token: write`. We do not store an npm token.

When the managed release pull request merges, `publish.yml` checks out its exact merge commit and validates the release diff against its parent. It runs repository checks, packs once, smoke-tests that tarball, and publishes the same file with lifecycle scripts disabled. After npm succeeds, it creates the immutable `vX.Y.Z` tag and matching GitHub Release from the changelog. Preparation and publication share the non-cancelling `release` concurrency group.

Existing npm versions, tags, releases, ambiguous registry responses, stale candidates, forged release identity, and attempts to move `latest` backward stop publication.

## Repository setup

Create a GitHub App installed only on `jekozyra/pi-typesafe-router`. Grant **Contents: read/write**, **Checks: read/write**, **Pull requests: read**, and **Metadata: read**. Add these Actions secrets:

- `RELEASE_APP_CLIENT_ID` — the App's public client ID, used to mint installation tokens
- `RELEASE_APP_PRIVATE_KEY`
- `OPENROUTER_API_KEY`

Add these repository Actions variables:

- `RELEASE_CLASSIFIER_MODEL` — initially `typesafe/jev-1.13`
- `RELEASE_WRITER_MODEL` — initially `openai/gpt-5.6-luna`

Model IDs use OpenRouter's `provider/model` form. Variable changes do not require a code change. Review the repository audit log and rerun affected checks after an update because reruns use current values.

Create the four override labels. Configure the App's public numeric integration ID from `infra/github`:

```sh
pulumi config set releaseAppIntegrationId <id>
```

The managed ruleset binds `release / changeset` to this App and requires up-to-date Node 22 and Node 24 checks. Deploy that ruleset only after observing the expected checks on an ordinary pull request and a managed release pull request.

Configure npm trusted publishing for the exact `publish.yml` identity and permit trusted publication to `latest`.

## Consequences and alternatives

- We accept model variability for impact classification and prose, but deterministic code retains authority over package identity and version mechanics. Maintainers can override classifications explicitly.
- We reject fork pull requests before privileged operations. Reproduce an accepted fork contribution on a branch in this repository.
- Actions variables make model updates operational rather than code changes. This reduces reproducibility: rerunning the same commit after a variable update can use different models.
- We use a manual preparation step instead of publishing from ordinary merges. This gives maintainers one reviewable release boundary.
- We use npm OIDC instead of a stored npm token. Offline tests cannot prove account configuration or live publication.
- Never force-move a release tag, unpublish a version, or move `latest` backward to repair a run.

If npm succeeds but GitHub finalization fails, do not rerun publication blindly. Verify `npm view pi-typesafe-router@X.Y.Z dist` and confirm the source is the merged release commit. Create `vX.Y.Z` at that commit, then run:

```sh
gh release create vX.Y.Z --target <merge-sha> --notes-file <notes>
```

A maintainer owns this exceptional recovery.

## Implementation and verification

- [Changeset workflow](../.github/workflows/changeset.yml), [preparation workflow](../.github/workflows/prepare-release.yml), and [publication workflow](../.github/workflows/publish.yml).
- [Release policy](../scripts/release/policy.ts), [model adapters](../scripts/release/models.ts), [candidate validation](../scripts/release/candidate.ts), and [publication validation](../scripts/release/publish.ts).
- Run `npm run check`, `npm run smoke:package`, and `cd infra/github && npm run check` for offline verification.
- The first maintainer-approved release must confirm npm publication and provenance, the `vX.Y.Z` tag target, and the GitHub Release. Mocked tests do not establish live OIDC or model access.
