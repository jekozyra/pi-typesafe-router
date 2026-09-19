import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const workflow = await readFile(
  new URL("../.github/workflows/changeset.yml", import.meta.url),
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
  assert.match(
    workflow,
    /head\.repo\.id != github\.event\.pull_request\.base\.repo\.id/,
  );
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.doesNotMatch(workflow, /pull_request\.head\.sha/);
  assert.match(workflow, /permissions: \{\}/);
});

test("workflow uses scoped App and OpenRouter credentials without executing PR code", () => {
  assert.match(
    workflow,
    /actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3\.2\.0/,
  );
  assert.match(workflow, /permission-contents: write/);
  assert.match(workflow, /permission-checks: write/);
  assert.match(workflow, /OPENROUTER_API_KEY: \$\{\{ secrets\.OPENROUTER_API_KEY \}\}/);
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

test("Changesets and repository metadata are configured while automation stays unpublished", () => {
  assert.equal(
    packageJson.repository?.url,
    "git+https://github.com/jekozyra/pi-typesafe-router.git",
  );
  assert.ok(packageJson.devDependencies?.["@changesets/cli"]);
  assert.equal(packageJson.files.includes("scripts"), false);
  assert.equal(packageJson.files.includes(".github"), false);
});
