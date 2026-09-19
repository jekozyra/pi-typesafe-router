# Releasing

Release automation is being introduced in milestones. The automated PR changeset flow is active; release-PR preparation and npm publication are not yet implemented. Do not configure `release / changeset` as a required check until the managed release-PR path can satisfy it.

## Pull request changesets

For same-repository pull requests, `.github/workflows/changeset.yml` runs trusted code from the base revision with `pull_request_target`. It never checks out, installs, or executes pull-request code. It reads GitHub's diff API as bounded data.

The controller asks `typesafe/jev-1.13` for `none`, `patch`, `minor`, or `major`. For releasable changes, `openai/gpt-5.6-luna` writes the changelog prose. Both requests go through OpenRouter. Deterministic code owns the package name, filename, frontmatter, and bump mapping. Because this package remains pre-1.0, `major` is recorded as a Changesets `minor` bump while its breaking-change wording is retained.

A releasable PR owns `.changeset/pr-<number>.md`. Regeneration overwrites edits to that generated file. A `none` decision removes an obsolete generated file. The head-specific `release / changeset` check reports successful `none` decisions explicitly. Errors, incomplete or oversized diffs, missing binary patches, stale branch writes, and invalid model output fail closed.

Fork pull requests are rejected before App or OpenRouter credentials are created. A maintainer must reproduce an accepted fork contribution on a branch in this repository.

## Maintainer overrides

Apply exactly one of these labels:

- `release:none`
- `release:patch`
- `release:minor`
- `release:major`

The label must have been applied by a user with write, maintain, or admin repository permission. A releasable override also requires this PR-body section:

```markdown
## Release note

Concise user-facing description. Start with `Breaking:` when applicable.
```

Overrides do not call OpenRouter and remain authoritative until removed. Conflicting labels, an unauthorized label actor, or missing release-note text fail the check. Reviewers must reconsider an override after substantive PR changes.

## Repository setup

Create a dedicated GitHub App installed only on `jekozyra/pi-typesafe-router`. Grant repository **Contents: read/write**, **Checks: read/write**, **Pull requests: read**, and **Metadata: read**. Store its credentials as Actions secrets:

- `RELEASE_APP_ID`
- `RELEASE_APP_PRIVATE_KEY`
- `OPENROUTER_API_KEY`

The App token, rather than `GITHUB_TOKEN`, writes generated changesets so its commits trigger ordinary `push` and `pull_request` CI. Protect the App key from jobs that execute PR code. Create the four override labels exactly as listed above.

Before enabling a required check, verify both ordinary PRs and the future managed release PR can report the same `release / changeset` check. That activation is deferred to the manual release-preparation milestone.

## Current limitations

Model access and classification quality have only mocked coverage; no authenticated synthetic call is made by the test suite. Release preparation, npm trusted publishing, tags, and GitHub Releases are later milestones. Until those land, maintainers manage releases manually and must not merge a generated release PR expecting publication.
