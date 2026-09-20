import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/publish.yml", import.meta.url),
  "utf8",
);

function stepScript(name: string): string {
  const section = workflow.split(`- name: ${name}\n`)[1];
  assert.ok(section, `Missing step ${name}`);
  const block = section.split("        run: |\n")[1]?.split(/\n(?:      - |  publish:)/)[0];
  assert.ok(block, `Missing script ${name}`);

  return block.replace(/^ {10}/gm, "");
}

const sha = "a".repeat(40);

const release = {
  number: 21,
  merged_at: "2026-09-20",
  merge_commit_sha: sha,
  base: { ref: "main", repo: { full_name: "owner/repo" } },
  head: { ref: "changeset-release/main", repo: { full_name: "owner/repo" } },
};

for (const fixture of [
  { name: "release merge", prs: [release], expected: "pr=21\n", status: 0 },
  { name: "ordinary push", prs: [], expected: "", status: 0 },
  { name: "unmerged PR", prs: [{ ...release, merged_at: null }], expected: "", status: 0 },
  {
    name: "older release",
    prs: [{ ...release, merge_commit_sha: "b".repeat(40) }],
    expected: "",
    status: 0,
  },
  {
    name: "ordinary PR",
    prs: [{ ...release, head: { ...release.head, ref: "feature" } }],
    expected: "",
    status: 0,
  },
  {
    name: "fork PR",
    prs: [{ ...release, head: { ...release.head, repo: { full_name: "fork/repo" } } }],
    expected: "",
    status: 0,
  },
  {
    name: "ambiguous releases",
    prs: [release, { ...release, number: 22 }],
    expected: "",
    status: 1,
  },
  { name: "API failure", prs: [], expected: "", status: 1, apiFailure: true },
  { name: "manual recovery", prs: [], expected: "pr=21\n", status: 0, manual: "21" },
  { name: "invalid manual input", prs: [], expected: "", status: 1, manual: "21; echo unsafe" },
]) {
  test(`publish trigger: ${fixture.name}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "release-trigger-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(
      join(dir, "gh"),
      '#!/bin/sh\n[ "$API_FAILURE" = true ] && exit 1\nprintf "%s" "$PRS"\n',
      { mode: 0o700 },
    );
    await writeFile(join(dir, "output"), "");

    const result = spawnSync(
      "bash",
      ["-e", "-o", "pipefail", "-c", stepScript("Identify release merge")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          RUNNER_TEMP: dir,
          GITHUB_OUTPUT: join(dir, "output"),
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: sha,
          GITHUB_EVENT_NAME: fixture.manual ? "workflow_dispatch" : "push",
          RELEASE_PR: fixture.manual ?? "",
          PRS: JSON.stringify([fixture.prs]),
          API_FAILURE: String(fixture.apiFailure ?? false),
        },
      },
    );

    assert.equal(result.status, fixture.status, result.stderr);
    assert.equal(await readFile(join(dir, "output"), "utf8"), fixture.expected);
  });
}

for (const { event, targetSha, success } of [
  { event: "push", targetSha: sha, success: true },
  { event: "push", targetSha: "b".repeat(40), success: false },
  { event: "workflow_dispatch", targetSha: "b".repeat(40), success: true },
]) {
  test(`release checkout gate: ${event}, matching SHA=${targetSha === sha}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "release-checkout-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "gh"), '#!/bin/sh\nprintf "%s" "$PR"\n', { mode: 0o700 });
    await writeFile(join(dir, "output"), "");

    const result = spawnSync("bash", ["-e", "-c", stepScript("Resolve merged release PR")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        GITHUB_OUTPUT: join(dir, "output"),
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_SHA: sha,
        GITHUB_EVENT_NAME: event,
        RELEASE_PR: "21",
        PR: JSON.stringify({ ...release, merged: true, merge_commit_sha: targetSha }),
      },
    });

    assert.equal(result.status === 0, success, result.stderr);
    assert.equal(await readFile(join(dir, "output"), "utf8"), success ? `sha=${targetSha}\n` : "");
  });
}

test("OIDC diagnostics print only selected claims, not credentials", () => {
  const script = stepScript("Diagnose publishing identity")
    .split("<<'NODE'\n")[1]
    ?.split("\nNODE")[0];

  assert.ok(script);

  const claims = {
    repository: "owner/repo",
    event_name: "push",
    aud: "npm:registry.npmjs.org",
    private_claim: "SECRET_UNKNOWN_CLAIM",
  };

  const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.SECRET_SIGNATURE`;

  const mock = `globalThis.fetch = async (url, options) => {
    if (url.searchParams.get("audience") !== "npm:registry.npmjs.org") throw new Error("wrong audience");
    if (options.headers.Authorization !== "Bearer SECRET_REQUEST_TOKEN") throw new Error("missing auth");
    return new Response(JSON.stringify({value: ${JSON.stringify(token)}}));
  };\n`;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", mock + script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test/SECRET_URL",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "SECRET_REQUEST_TOKEN",
      NODE_AUTH_TOKEN: "SECRET_NPM_TOKEN",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /owner\/repo/);
  assert.match(result.stdout, /npm:registry.npmjs.org/);
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET_|header\./);
});

test("publish logs are removed even when the diagnostic parser fails", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "release-log-cleanup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "npm"),
    '#!/bin/sh\nmkdir -p "$RUNNER_TEMP/npm-publish-debug"\necho SECRET_RAW_LOG > "$RUNNER_TEMP/npm-publish-debug/log"\necho SECRET_STDOUT\n',
    { mode: 0o700 },
  );
  await writeFile(join(dir, "node"), "#!/bin/sh\nexit 2\n", { mode: 0o700 });

  const result = spawnSync(
    "bash",
    ["-e", "-c", stepScript("Publish exact tarball with npm OIDC")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        RELEASE_TARBALL: "example.tgz",
      },
    },
  );

  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET_/);
  await assert.rejects(readFile(join(dir, "npm-publish.log")), { code: "ENOENT" });
  await assert.rejects(readFile(join(dir, "npm-publish-debug/log")), { code: "ENOENT" });
});

for (const exitCode of [0, 1]) {
  test(`publish diagnostics redact credentials and retain exit status ${exitCode}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "release-diagnostics-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(
      join(dir, "npm"),
      '#!/bin/sh\necho "SECRET_RAW_TOKEN"\necho "npm http fetch GET 200 https://actions.example/SECRET_URL"\necho "npm http fetch POST 404 https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/example"\necho "npm http fetch PUT 404 https://registry.npmjs.org/example"\necho "npm error code E404"\nexit "$MOCK_EXIT"\n',
      { mode: 0o700 },
    );

    const result = spawnSync(
      "bash",
      ["-e", "-c", stepScript("Publish exact tarball with npm OIDC")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          RUNNER_TEMP: dir,
          RELEASE_TARBALL: "example.tgz",
          MOCK_EXIT: String(exitCode),
        },
      },
    );

    assert.equal(result.status, exitCode, result.stderr);
    assert.match(result.stdout, /OIDC token exchange: POST HTTP 404/);
    assert.match(result.stdout, /npm registry: PUT HTTP 404/);
    assert.match(result.stdout, /npm error codes: E404/);
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET_/);
    await assert.rejects(readFile(join(dir, "npm-publish.log")), { code: "ENOENT" });
  });
}
