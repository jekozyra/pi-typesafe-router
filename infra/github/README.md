# GitHub repository infrastructure

This Pulumi project is the source of truth for GitHub merge settings, the active `main` ruleset, and the protected deployment environment on `jekozyra/pi-typesafe-router`.

## Managed policy

- squash merges only, with the pull-request title and a blank commit body
- auto-merge enabled
- merged head branches deleted automatically
- changes to `main` require a pull request
- linear history required
- branch deletion and force pushes blocked
- lint/format, Node.js 22/24 test, and release checks required before merge
- repository administrators may always bypass the ruleset
- no approving review or resolved-conversation requirement
- every workflow deployment requires approval from the configured environment reviewer

The repository resource intentionally ignores product metadata such as its description, topics, visibility, and feature toggles. Those remain managed in GitHub. All managed resources are protected in Pulumi so `pulumi destroy` cannot delete them accidentally.

## Prerequisites

1. Install the Node.js version in `.node-version` or newer and the Pulumi CLI version in `.pulumi.version`.
2. Authenticate to GCP with access to `gs://tinydog-pulumi-state/pi-typesafe-router`.
3. In `tinydog-infra`, provision a dedicated service account with object access to that state path and a Workload Identity Federation binding restricted to `jekozyra/pi-typesafe-router`.
4. Create fine-grained GitHub personal access tokens restricted to this repository. The preview token needs **Administration: read** and **Environments: read**; the deployment token needs **Administration: read/write** and **Environments: read/write**. Do not expose them until dependencies are installed.

Never commit the token, put it in a stack YAML file, or pass it on a command line where shell history may retain it.

## Adopt the existing resources

Import the existing repository and ruleset into a new stack once:

```sh
cd infra/github
npm ci --ignore-scripts
gcloud auth application-default login
pulumi login gs://tinydog-pulumi-state/pi-typesafe-router
read -rsp "Pulumi state passphrase: " PULUMI_CONFIG_PASSPHRASE && echo
export PULUMI_CONFIG_PASSPHRASE
pulumi stack init production --secrets-provider passphrase # omit if the stack already exists
read -rsp "GitHub token: " GITHUB_TOKEN && echo
export GITHUB_TOKEN
pulumi import github:index/repository:Repository repository pi-typesafe-router
pulumi import github:index/repositoryEnvironment:RepositoryEnvironment deployment pi-typesafe-router:github-infrastructure
pulumi import github:index/repositoryRuleset:RepositoryRuleset main pi-typesafe-router:23683409
pulumi preview --refresh
pulumi up --refresh
unset GITHUB_TOKEN PULUMI_CONFIG_PASSPHRASE
```

The imports adopt resources without changing them. Review the first preview carefully; it must not replace any resource. The subsequent update records resource protection and reconciles only the managed policy. State is stored under the dedicated prefix in the `tinydog-pulumi-state` bucket, never in this repository.

The ruleset and environment import IDs are deliberately absent from the steady-state program. When recovering lost state, obtain their current IDs from GitHub and repeat the imports. The repository keeps an inline `import` guard so a lost remote or state cannot cause Pulumi to create an empty replacement. Remove that guard only as an explicit break-glass step when intentionally recreating the repository.

## Configure deployment

The `github-infrastructure` environment requires approval from `jekozyra`, prevents administrator bypass, and accepts deployments only from protected branches. Self-approval is allowed so the repository owner can release a deployment they triggered.

After bootstrapping the `production` stack, configure the WIF resource names as repository variables, the preview credentials as repository secrets, and the write token on the protected environment:

```sh
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --body 'projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>'
gh variable set GCP_SERVICE_ACCOUNT --body 'pi-typesafe-router-pulumi@tinydog-infra.iam.gserviceaccount.com'
gh secret set PULUMI_CONFIG_PASSPHRASE
gh secret set GH_ADMIN_READ_TOKEN
gh secret set GH_ADMIN_TOKEN --env github-infrastructure
```

Use the same passphrase that initialized the Pulumi stack. Use the Administration/Environments read token for `GH_ADMIN_READ_TOKEN` and the corresponding read/write token for `GH_ADMIN_TOKEN`. GCP access is keyless through WIF. The preview job can read GitHub policy but cannot change it, and GitHub releases the write token only after approval.

### Approval-gate recovery

The workflow intentionally cannot repair its own missing or weakened approval gate. If the environment is deleted or its policy drifts, restore `github-infrastructure` in repository settings with these controls before rerunning the workflow:

- required reviewer: `jekozyra`
- administrator bypass disabled
- protected branches only
- self-review allowed

Recreate the environment-scoped `GH_ADMIN_TOKEN` secret after an environment deletion, then run the documented Pulumi import again if stack state also needs recovery. To change reviewers, update the live gate first so the newly merged preflight can verify it, then let Pulumi adopt the same reviewer configuration.

## Routine changes

A push to `main` triggers `.github/workflows/deploy-github-infrastructure.yml` only when a non-Markdown file under `infra/github/` changed. The first job fails closed unless the approval environment still has its reviewer, protected-branch restriction, and disabled administrator bypass. It then validates the program, publishes a read-only `pulumi preview --refresh` summary, and saves its update plan for one day.

After preview succeeds, the deployment job pauses at the protected environment so `jekozyra` can review the preview before approving `pulumi up` with that exact plan. Apply does not refresh or recalculate the approved plan; state changes make it fail and require a new preview. The job refuses to deploy if a newer commit reached `main` while approval was pending. Concurrent runs are serialized, active updates are never cancelled, and superseded pending revisions may be coalesced by GitHub.

Pull-request CI runs repository lint and formatting checks independently from the test matrix. The Node.js 22 test job runs `npm run check` in this directory without GitHub credentials; it validates the Pulumi TypeScript program but cannot preview or apply repository administration changes.

## Drift checks

The repository maintainer must run a credentialed drift check at least monthly and after any manual repository-administration change:

```sh
cd infra/github
npm ci --ignore-scripts
gcloud auth application-default login
pulumi login gs://tinydog-pulumi-state/pi-typesafe-router
pulumi stack select production
read -rsp "Pulumi state passphrase: " PULUMI_CONFIG_PASSPHRASE && echo
read -rsp "GitHub token: " GITHUB_TOKEN && echo
export PULUMI_CONFIG_PASSPHRASE GITHUB_TOKEN
pulumi preview --refresh --expect-no-changes
unset GITHUB_TOKEN PULUMI_CONFIG_PASSPHRASE
```

Any unexpected change requires reconciliation in Pulumi or an explicit update to this project. Keep administration credentials out of pull-request CI.
