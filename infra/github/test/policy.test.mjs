import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as pulumi from "@pulumi/pulumi";
import { parse } from "yaml";

const workflowPath = fileURLToPath(
  new URL("../../../.github/workflows/deploy-github-infrastructure.yml", import.meta.url),
);

const checksWorkflowPath = fileURLToPath(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
);

const infraUrl = new URL("../", import.meta.url);

test("deployment workflow previews before an approved apply", async () => {
  const workflow = parse(await readFile(workflowPath, "utf8"));
  const packageJson = JSON.parse(await readFile(new URL("package.json", infraUrl), "utf8"));
  const project = parse(await readFile(new URL("Pulumi.yaml", infraUrl), "utf8"));
  const stack = parse(await readFile(new URL("Pulumi.production.yaml", infraUrl), "utf8"));
  const reviewer = stack.config["pi-typesafe-router-repository:deploymentReviewer"];

  const releaseAppIntegrationId =
    stack.config["pi-typesafe-router-repository:releaseAppIntegrationId"];

  const nodeVersion = (await readFile(new URL(".node-version", infraUrl), "utf8")).trim();
  const pulumiVersion = (await readFile(new URL(".pulumi.version", infraUrl), "utf8")).trim();

  assert.equal(packageJson.engines.node, `>=${nodeVersion}`);
  assert.equal(packageJson.dependencies["@pulumi/pulumi"], pulumiVersion);
  assert.equal(releaseAppIntegrationId, 5003746);
  assert.deepEqual(Object.keys(workflow.on), ["push"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.push.paths, ["infra/github/**", "!infra/github/**/*.md"]);
  assert.deepEqual(workflow.permissions, { contents: "read", "id-token": "write" });
  assert.deepEqual(workflow.concurrency, {
    group: "github-infrastructure",
    "cancel-in-progress": false,
  });

  const { preview, deploy } = workflow.jobs;
  assert.equal(preview.environment, undefined);
  assert.equal(deploy.needs, "preview");
  assert.equal(deploy.environment, "github-infrastructure");

  const approvalGate = preview.steps.find(({ name }) => name === "Verify approval gate");
  assert.equal(approvalGate.env.GH_TOKEN, "${{ secrets.GH_ADMIN_READ_TOKEN }}");
  assert.match(approvalGate.run, /can_admins_bypass == false/);
  assert.match(approvalGate.run, /required_reviewers/);
  assert.match(approvalGate.run, /protected_branches == true/);
  assert.match(approvalGate.run, new RegExp(`reviewer\\.login == "${reviewer}"`));

  const staleCheck = deploy.steps.find(({ name }) => name === "Refuse a stale deployment");
  assert.match(staleCheck.run, /test "\$latest_sha" = "\$GITHUB_SHA"/);

  for (const job of [preview, deploy]) {
    const setupNode = job.steps.find(({ uses }) => uses?.startsWith("actions/setup-node@"));
    assert.equal(setupNode.with["node-version-file"], "infra/github/.node-version");
    const auth = job.steps.find(({ name }) => name === "Authenticate to Google Cloud");
    assert.equal(
      auth.with.workload_identity_provider,
      "${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}",
    );
    assert.equal(auth.with.service_account, "${{ vars.GCP_SERVICE_ACCOUNT }}");
  }

  const pulumiAction = "pulumi/actions@8e5e406f4007fca908480587cb9893c07090f58d";
  const previewPulumi = preview.steps.find(({ uses }) => uses === pulumiAction);
  const deployPulumi = deploy.steps.find(({ uses }) => uses === pulumiAction);
  assert.equal(previewPulumi.with["pulumi-version-file"], "infra/github/.pulumi.version");
  assert.equal(deployPulumi.with["pulumi-version-file"], "infra/github/.pulumi.version");
  assert.equal(previewPulumi.with["cloud-url"], project.backend.url);
  assert.equal(deployPulumi.with["cloud-url"], project.backend.url);
  assert.equal(previewPulumi.with.command, "preview");
  assert.equal(previewPulumi.with.refresh, true);
  assert.equal(previewPulumi.env.GITHUB_TOKEN, "${{ secrets.GH_ADMIN_READ_TOKEN }}");
  assert.equal(deployPulumi.with.command, "up");
  assert.equal(deployPulumi.with.refresh, undefined);
  assert.equal(deployPulumi.env.GITHUB_TOKEN, "${{ secrets.GH_ADMIN_TOKEN }}");
  assert.equal(
    previewPulumi.env.PULUMI_CONFIG_PASSPHRASE,
    "${{ secrets.PULUMI_CONFIG_PASSPHRASE }}",
  );
  assert.equal(
    deployPulumi.env.PULUMI_CONFIG_PASSPHRASE,
    "${{ secrets.PULUMI_CONFIG_PASSPHRASE }}",
  );
  assert.doesNotMatch(JSON.stringify(workflow), /PULUMI_ACCESS_TOKEN/);
  assert.equal(previewPulumi.with.plan, "${{ github.workspace }}/pulumi.plan");
  assert.equal(deployPulumi.with.plan, previewPulumi.with.plan);

  for (const step of [...preview.steps, ...deploy.steps]) {
    if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}$/);
  }

  assert.match(
    JSON.stringify(preview),
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/,
  );
  assert.match(
    JSON.stringify(deploy),
    /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/,
  );
  assert.doesNotMatch(JSON.stringify(preview), /GH_ADMIN_TOKEN/);
});

test("lint and formatting run independently from tests", async () => {
  const workflow = parse(await readFile(checksWorkflowPath, "utf8"));
  const qualityJob = workflow.jobs["lint-and-format"];
  const testJob = workflow.jobs.test;

  assert.deepEqual(Object.keys(workflow.on), ["pull_request", "push"]);
  assert.equal(workflow.on.pull_request, null);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(qualityJob.needs, undefined);
  assert.equal(testJob.needs, undefined);
  assert.ok(qualityJob.steps.some(({ run }) => run === "npm run check:quality"));
  assert.ok(testJob.steps.some(({ run }) => run === "npm test"));
  assert.ok(testJob.steps.every(({ run }) => run !== "npm run check"));
});

test("main requires up-to-date CI and release validation", async () => {
  const resources = [];
  pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        resources.push(args);

        return { id: `${args.name}-id`, state: args.inputs };
      },
      call: (args) =>
        args.token === "github:index/getUser:getUser"
          ? { ...args.inputs, id: "175589", login: args.inputs.username }
          : args.inputs,
    },
    "pi-typesafe-router-repository",
    "required-checks",
    false,
  );
  pulumi.runtime.setAllConfig({
    "pi-typesafe-router-repository:deploymentReviewer": "jekozyra",
    "pi-typesafe-router-repository:releaseAppIntegrationId": "123456",
    "pi-typesafe-router-repository:repository": "pi-typesafe-router",
  });

  const program = await import(`../index.ts?checks=${Date.now()}`);
  await program.mainRulesetId.promise();

  const ruleset = resources.find(
    ({ type }) => type === "github:index/repositoryRuleset:RepositoryRuleset",
  );

  assert.ok(ruleset);
  assert.equal(ruleset.inputs.rules.requiredStatusChecks.strictRequiredStatusChecksPolicy, true);
  assert.deepEqual(ruleset.inputs.rules.requiredStatusChecks.requiredChecks, [
    { context: "lint-and-format" },
    { context: "test (22)" },
    { context: "test (24)" },
    { context: "release / changeset", integrationId: 123456 },
  ]);
});

test("deployment environment requires a protected-branch reviewer", async () => {
  const resources = [];
  pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        resources.push(args);

        return { id: `${args.name}-id`, state: args.inputs };
      },
      call: (args) =>
        args.token === "github:index/getUser:getUser"
          ? { ...args.inputs, id: "175589", login: args.inputs.username }
          : args.inputs,
    },
    "pi-typesafe-router-repository",
    "production",
    false,
  );
  pulumi.runtime.setAllConfig({
    "pi-typesafe-router-repository:deploymentReviewer": "jekozyra",
    "pi-typesafe-router-repository:releaseAppIntegrationId": "123456",
    "pi-typesafe-router-repository:repository": "pi-typesafe-router",
  });

  const program = await import(`../index.ts?test=${Date.now()}`);
  await Promise.all([
    program.deploymentEnvironmentName.promise(),
    program.deploymentReviewerLogin.promise(),
  ]);

  const environment = resources.find(
    ({ type }) => type === "github:index/repositoryEnvironment:RepositoryEnvironment",
  );

  const repository = resources.find(({ type }) => type === "github:index/repository:Repository");

  assert.ok(repository);
  assert.equal(repository.inputs.allowUpdateBranch, true);

  const source = await readFile(new URL("index.ts", infraUrl), "utf8");

  assert.doesNotMatch(source, /"allowUpdateBranch"/);
  assert.ok(environment);
  assert.equal(environment.inputs.environment, "github-infrastructure");
  assert.equal(environment.inputs.canAdminsBypass, false);
  assert.equal(environment.inputs.preventSelfReview, false);
  assert.equal(await program.deploymentReviewerLogin.promise(), "jekozyra");
  assert.deepEqual(environment.inputs.reviewers, [{ users: [175589] }]);
  assert.deepEqual(environment.inputs.deploymentBranchPolicy, {
    protectedBranches: true,
    customBranchPolicies: false,
  });
});
