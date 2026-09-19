import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const workflow = await readFile(
  new URL("../.github/workflows/changeset.yml", import.meta.url),
  "utf8",
);

const prepareWorkflow = await readFile(
  new URL("../.github/workflows/prepare-release.yml", import.meta.url),
  "utf8",
);

const publishWorkflow = await readFile(
  new URL("../.github/workflows/publish.yml", import.meta.url),
  "utf8",
);

const packageJson = z
  .object({
    files: z.array(z.string()),
    repository: z.object({ url: z.string() }).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
  })
  .parse(JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")));

test("privileged workflow runs trusted base code and rejects forks before secret-bearing steps", () => {
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /reject-fork:/);
  assert.match(workflow, /head\.repo\.id != github\.event\.pull_request\.base\.repo\.id/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.doesNotMatch(workflow, /pull_request\.head\.sha/);
  assert.match(workflow, /permissions: \{\}/);
});

test("workflow uses scoped App and OpenRouter credentials without executing PR code", () => {
  assert.match(
    workflow,
    /actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3\.2\.0/,
  );
  assert.match(workflow, /client-id: \$\{\{ vars\.RELEASE_APP_CLIENT_ID \}\}/);
  assert.doesNotMatch(workflow, /app-id:/);
  assert.doesNotMatch(workflow, /cache: npm/);
  assert.match(workflow, /permission-contents: write/);
  assert.match(workflow, /permission-checks: write/);
  assert.match(workflow, /OPENROUTER_API_KEY: \$\{\{ secrets\.OPENROUTER_API_KEY \}\}/);
  assert.match(workflow, /RELEASE_CLASSIFIER_MODEL: \$\{\{ vars\.RELEASE_CLASSIFIER_MODEL \}\}/);
  assert.match(workflow, /RELEASE_WRITER_MODEL: \$\{\{ vars\.RELEASE_WRITER_MODEL \}\}/);
  assert.doesNotMatch(workflow, /uses: actions\/[^@]+@v\d/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /\.\/node_modules\/\.bin\/tsx scripts\/release\/pr\.ts/);
  assert.doesNotMatch(workflow, /\bnpx\b/);
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.ref/);
});

test("per-PR reconciliation is serialized without cancelling an active write", () => {
  assert.match(workflow, /group: changeset-\$\{\{ github\.event\.pull_request\.number \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test("release preparation is manual, version-only, serialized, and App-authored", () => {
  assert.match(prepareWorkflow, /workflow_dispatch:/);
  assert.match(prepareWorkflow, /group: release/);
  assert.match(prepareWorkflow, /cancel-in-progress: false/);
  assert.match(prepareWorkflow, /candidate\.ts preflight/);
  assert.match(prepareWorkflow, /client-id: \$\{\{ vars\.RELEASE_APP_CLIENT_ID \}\}/);
  assert.doesNotMatch(prepareWorkflow, /app-id:|cache: npm/);
  assert.match(prepareWorkflow, /steps\.preflight\.outputs\.pending == 'true'/);
  assert.match(prepareWorkflow, /changesets\/action@06245a4e0a36c064a573d4150030f5ec548e4fcc/);
  assert.match(prepareWorkflow, /version: npm run release:version/);
  assert.match(prepareWorkflow, /git config user\.name "\$GITHUB_APP_BOT_LOGIN"/);
  assert.match(
    prepareWorkflow,
    /git config user\.email "\$GITHUB_APP_BOT_LOGIN@users\.noreply\.github\.com"/,
  );
  assert.doesNotMatch(prepareWorkflow, /publish:/);
  assert.doesNotMatch(prepareWorkflow, /id-token: write/);
});

test("publication is merge-gated, OIDC-enabled, exact-revision, and uses one tarball", () => {
  assert.match(publishWorkflow, /types: \[closed\]/);
  assert.match(publishWorkflow, /pull_request\.merged == true/);
  assert.match(publishWorkflow, /merge_commit_sha/);
  assert.match(publishWorkflow, /id-token: write/);
  assert.match(publishWorkflow, /client-id: \$\{\{ vars\.RELEASE_APP_CLIENT_ID \}\}/);
  assert.doesNotMatch(publishWorkflow, /app-id:|cache: npm/);
  assert.match(publishWorkflow, /npm@12\.0\.2/);
  assert.match(publishWorkflow, /npm pack --ignore-scripts/);
  assert.match(publishWorkflow, /PACKAGE_TARBALL:/);
  assert.match(
    publishWorkflow,
    /npm publish .*--ignore-scripts --access public --provenance --tag latest/,
  );
  assert.match(publishWorkflow, /gh release create/);
  assert.match(publishWorkflow, /npm publication succeeded but GitHub finalization failed/);
  assert.match(publishWorkflow, /group: release/);
  assert.match(publishWorkflow, /cancel-in-progress: false/);
});

test("Changesets and repository metadata are configured outside the package artifact", () => {
  assert.equal(
    packageJson.repository?.url,
    "git+https://github.com/jekozyra/pi-typesafe-router.git",
  );
  assert.ok(packageJson.devDependencies?.["@changesets/cli"]);
  assert.equal(packageJson.files.includes("scripts"), false);
  assert.equal(packageJson.files.includes(".github"), false);
});
