import test from "node:test";
import assert from "node:assert/strict";
import {
  isManagedReleasePullRequest,
  RELEASE_BRANCH,
  validatePreparationState,
  validatePriorPublication,
  validateReleaseCandidate,
} from "../scripts/release/candidate.ts";

const identity = (overrides = {}) => ({
  headRepository: "jekozyra/pi-typesafe-router",
  baseRepository: "jekozyra/pi-typesafe-router",
  baseRef: "main",
  headRef: RELEASE_BRANCH,
  author: "release-bot[bot]",
  expectedBot: "release-bot[bot]",
  ...overrides,
});

const candidate = (overrides = {}) => ({
  changed: [
    { filename: "package.json", status: "modified" },
    { filename: "package-lock.json", status: "modified" },
    { filename: "CHANGELOG.md", status: "added" },
    { filename: ".changeset/pr-1.md", status: "removed" },
  ],
  packageJson: '{"name":"pi-typesafe-router","version":"0.2.0"}',
  packageLock: '{"version":"0.2.0","packages":{"":{"version":"0.2.0"}}}',
  changelog: "# pi-typesafe-router\n\n## 0.2.0\n\n- Add routing.\n",
  basePackageJson: '{"name":"pi-typesafe-router","version":"0.1.0"}',
  basePackageLock: '{"version":"0.1.0","packages":{"":{"version":"0.1.0"}}}',
  ...overrides,
});

test("managed release identity requires repository, branch, base, and App author", () => {
  assert.equal(isManagedReleasePullRequest(identity()), true);

  for (const value of [
    { headRepository: "fork/repo" },
    { baseRef: "next" },
    { headRef: "release" },
    { author: "maintainer" },
  ])
    assert.equal(isManagedReleasePullRequest(identity(value)), false);
});

test("release candidate validates exact allowed files, version, lockfile, and changelog", () => {
  assert.equal(validateReleaseCandidate(candidate()), "0.2.0");
  assert.throws(
    () =>
      validateReleaseCandidate(
        candidate({
          changed: [...candidate().changed, { filename: "src/index.ts", status: "modified" }],
        }),
      ),
    /unrelated/,
  );
  assert.throws(() =>
    validateReleaseCandidate(
      candidate({ packageJson: '{"name":"pi-typesafe-router","version":"1.0.0"}' }),
    ),
  );
  assert.throws(
    () =>
      validateReleaseCandidate(
        candidate({ packageLock: '{"version":"0.1.0","packages":{"":{"version":"0.1.0"}}}' }),
      ),
    /lockfile/,
  );
  assert.throws(() => validateReleaseCandidate(candidate({ changelog: "wrong" })), /changelog/);
  assert.throws(
    () =>
      validateReleaseCandidate(
        candidate({
          packageJson:
            '{"name":"pi-typesafe-router","version":"0.2.0","scripts":{"preinstall":"bad"}}',
        }),
      ),
    /non-version/,
  );
  assert.throws(
    () =>
      validateReleaseCandidate(
        candidate({
          packageLock:
            '{"version":"0.2.0","packages":{"":{"version":"0.2.0"},"node_modules/bad":{"version":"1.0.0"}}}',
        }),
      ),
    /non-version/,
  );
});

test("preparation is a no-op without changesets and rejects duplicate managed PRs", () => {
  assert.equal(validatePreparationState(["README.md", "config.json"], 0), false);
  assert.equal(validatePreparationState(["README.md", "pr-1.md"], 1), true);
  assert.throws(() => validatePreparationState(["pr-1.md"], 2), /multiple-managed/);
});

test("preparation accepts complete releases and a fully absent initial release", async () => {
  const urls: string[] = [];
  await validatePriorPublication(
    "owner/repo",
    "token",
    '{"name":"pi-typesafe-router","version":"0.1.0"}',
    async (url) => {
      urls.push(String(url));

      return new Response("{}", { status: 200 });
    },
  );
  assert.equal(urls.length, 3);

  await validatePriorPublication(
    "owner/repo",
    "token",
    '{"name":"pi-typesafe-router","version":"0.1.0"}',
    async () => new Response("", { status: 404 }),
  );
});

test("preparation rejects partially complete or ambiguous prior releases", async () => {
  await assert.rejects(
    validatePriorPublication(
      "owner/repo",
      "token",
      '{"name":"pi-typesafe-router","version":"0.1.0"}',
      async (url) => new Response("", { status: String(url).includes("releases") ? 404 : 200 }),
    ),
    /incomplete/,
  );

  await assert.rejects(
    validatePriorPublication(
      "owner/repo",
      "token",
      '{"name":"pi-typesafe-router","version":"0.1.0"}',
      async () => new Response("", { status: 500 }),
    ),
    /incomplete/,
  );

  await assert.rejects(
    validatePriorPublication(
      "owner/repo",
      "token",
      '{"name":"pi-typesafe-router","version":"0.1.1"}',
      async () => new Response("", { status: 404 }),
    ),
    /incomplete/,
  );
});
