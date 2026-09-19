# GitHub repository infrastructure

This Pulumi project is the source of truth for GitHub merge settings and the active `main` ruleset on `jekozyra/pi-typesafe-router`.

## Managed policy

- squash merges only, with the pull-request title and a blank commit body
- auto-merge enabled
- merged head branches deleted automatically
- changes to `main` require a pull request
- linear history required
- branch deletion and force pushes blocked
- repository administrators may always bypass the ruleset
- no approving review or resolved-conversation requirement

The repository resource intentionally ignores product metadata such as its description, topics, visibility, and feature toggles. Those remain managed in GitHub. Both resources are protected in Pulumi so `pulumi destroy` cannot delete the repository or ruleset accidentally.

## Prerequisites

1. Install Node.js 22.19.0 or newer and the [Pulumi CLI](https://www.pulumi.com/docs/iac/download-install/).
2. Choose and log in to a durable Pulumi backend, such as Pulumi Cloud.
3. Create a fine-grained GitHub personal access token restricted to this repository with **Administration: read/write** access. Do not expose it until dependencies are installed.

Never commit the token, put it in a stack YAML file, or pass it on a command line where shell history may retain it.

## Adopt the existing resources

Import the existing repository and ruleset into a new stack once:

```sh
cd infra/github
npm ci --ignore-scripts
pulumi stack init production # omit if the stack already exists
read -rsp "GitHub token: " GITHUB_TOKEN && echo
export GITHUB_TOKEN
pulumi import github:index/repository:Repository repository pi-typesafe-router
pulumi import github:index/repositoryRuleset:RepositoryRuleset main pi-typesafe-router:23683409
pulumi preview --refresh
pulumi up --refresh
unset GITHUB_TOKEN
```

The imports adopt resources without changing them. Review the first preview carefully; it must not replace either resource. The subsequent update records resource protection and reconciles only the managed policy. Store Pulumi state in a supported backend, never in this repository.

The ruleset import ID is deliberately absent from the steady-state program. When recovering lost state, obtain the current ruleset ID from GitHub and repeat the imports. The repository keeps an inline `import` guard so a lost remote or state cannot cause Pulumi to create an empty replacement. Remove that guard only as an explicit break-glass step when intentionally recreating the repository.

## Routine changes

Change `index.ts` in a pull request, then preview and apply with an administration-capable token:

```sh
cd infra/github
npm ci --ignore-scripts
pulumi stack select production
read -rsp "GitHub token: " GITHUB_TOKEN && echo
export GITHUB_TOKEN
pulumi preview --refresh
pulumi up --refresh
unset GITHUB_TOKEN
```

CI runs `npm run check` without GitHub credentials. It validates the Pulumi TypeScript program but deliberately does not preview or apply repository administration changes.

## Drift checks

The repository maintainer must run a credentialed drift check at least monthly and after any manual repository-administration change:

```sh
cd infra/github
npm ci --ignore-scripts
pulumi stack select production
read -rsp "GitHub token: " GITHUB_TOKEN && echo
export GITHUB_TOKEN
pulumi preview --refresh --expect-no-changes
unset GITHUB_TOKEN
```

Any unexpected change requires reconciliation in Pulumi or an explicit update to this project. Keep administration credentials out of pull-request CI.
