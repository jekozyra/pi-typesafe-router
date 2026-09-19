import * as github from "@pulumi/github";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();

const repositoryName = config.require("repository");

const deploymentReviewer = config.require("deploymentReviewer");

const releaseAppIntegrationId = config.requireNumber("releaseAppIntegrationId");

const deploymentReviewerUser = github.getUserOutput({ username: deploymentReviewer });

const repository = new github.Repository(
  "repository",
  {
    name: repositoryName,
    allowAutoMerge: true,
    allowMergeCommit: false,
    allowRebaseMerge: false,
    allowSquashMerge: true,
    allowUpdateBranch: true,
    deleteBranchOnMerge: true,
    squashMergeCommitTitle: "PR_TITLE",
    squashMergeCommitMessage: "BLANK",
  },
  {
    // Refuse to recreate an empty repository if state or the remote is lost.
    import: repositoryName,
    protect: true,
    // This stack owns merge behavior only. Product metadata remains managed in GitHub.
    ignoreChanges: [
      "allowForking",
      "archived",
      "defaultBranch",
      "description",
      "hasDiscussions",
      "hasDownloads",
      "hasIssues",
      "hasProjects",
      "hasWiki",
      "homepageUrl",
      "isTemplate",
      "mergeCommitMessage",
      "mergeCommitTitle",
      "pages",
      "private",
      "securityAndAnalysis",
      "topics",
      "visibility",
      "vulnerabilityAlerts",
      "webCommitSignoffRequired",
    ],
  },
);

const deploymentEnvironment = new github.RepositoryEnvironment(
  "deployment",
  {
    repository: repository.name,
    environment: "github-infrastructure",
    canAdminsBypass: false,
    preventSelfReview: false,
    reviewers: [{ users: [deploymentReviewerUser.id.apply(Number)] }],
    deploymentBranchPolicy: {
      protectedBranches: true,
      customBranchPolicies: false,
    },
  },
  {
    protect: true,
  },
);

const mainRuleset = new github.RepositoryRuleset(
  "main",
  {
    repository: repository.name,
    name: "main",
    target: "branch",
    enforcement: "active",
    bypassActors: [
      {
        actorId: 5,
        actorType: "RepositoryRole",
        bypassMode: "always",
      },
    ],
    conditions: {
      refName: {
        includes: ["refs/heads/main"],
        excludes: [],
      },
    },
    rules: {
      deletion: true,
      nonFastForward: true,
      requiredLinearHistory: true,
      requiredStatusChecks: {
        requiredChecks: [
          { context: "Checks / lint-and-format" },
          { context: "Checks / test (22)" },
          { context: "Checks / test (24)" },
          { context: "release / changeset", integrationId: releaseAppIntegrationId },
        ],
        strictRequiredStatusChecksPolicy: true,
      },
      pullRequest: {
        allowedMergeMethods: ["squash"],
        dismissStaleReviewsOnPush: false,
        requireCodeOwnerReview: false,
        requireLastPushApproval: false,
        requiredApprovingReviewCount: 0,
        requiredReviewThreadResolution: false,
      },
    },
  },
  {
    protect: true,
  },
);

export const repositoryUrl = repository.htmlUrl;

export const deploymentEnvironmentName = deploymentEnvironment.environment;

export const deploymentReviewerLogin = deploymentReviewerUser.login;

export const mainRulesetId = mainRuleset.rulesetId;
