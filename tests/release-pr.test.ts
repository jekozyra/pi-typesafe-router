import test from "node:test";
import assert from "node:assert/strict";
import type { PullRequestFile } from "../scripts/release/input.ts";
import type { ReleaseModels } from "../scripts/release/models.ts";
import {
  runPullRequestAutomation,
  type PullRequestPort,
  type PullRequestState,
} from "../scripts/release/pr.ts";
import { serializeChangeset, type ReleaseImpact } from "../scripts/release/policy.ts";

const basePr = (overrides: Partial<PullRequestState> = {}): PullRequestState => ({
  action: "synchronize",
  number: 12,
  title: "Fix routing",
  body: "Details",
  labels: [],
  headRepository: "jekozyra/pi-typesafe-router",
  baseRepository: "jekozyra/pi-typesafe-router",
  headSha: "head-1",
  labelActors: {},
  ...overrides,
});

const changedFile: PullRequestFile = {
  filename: "src/routing.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-old\n+new",
};

class FakePort implements PullRequestPort {
  calls: string[] = [];
  content: string | undefined;
  permissionValue: Awaited<ReturnType<PullRequestPort["permission"]>> = "write";
  files: PullRequestFile[] = [changedFile];
  checks: Parameters<PullRequestPort["check"]>[0][] = [];

  async listFiles() {
    this.calls.push("files");

    return this.files;
  }
  async permission(actor: string) {
    this.calls.push(`permission:${actor}`);

    return this.permissionValue;
  }
  async readFile() {
    this.calls.push("read");

    return this.content;
  }
  async writeGeneratedFile(input: Parameters<PullRequestPort["writeGeneratedFile"]>[0]) {
    this.calls.push(
      `write:${input.expectedHead}:${input.content === undefined ? "delete" : "upsert"}`,
    );
    this.content = input.content;

    return "bot-head";
  }
  async verifiedBotUpdate() {
    this.calls.push("verify-bot");

    return true;
  }
  async assertHead(expectedHead: string) {
    this.calls.push(`head:${expectedHead}`);
  }
  async check(input: Parameters<PullRequestPort["check"]>[0]) {
    this.calls.push(`check:${input.headSha}`);
    this.checks.push(input);
  }
}

const fakeModels = (impact: ReleaseImpact, calls: string[]): ReleaseModels => ({
  async classify() {
    calls.push("classify");

    return impact;
  },
  async describe(_input, value) {
    calls.push(`describe:${value}`);

    return value === "major" ? "Breaking: remove the old route." : "Fix route selection.";
  },
});

const signal = new AbortController().signal;

test("model none skips Luna, removes an obsolete changeset, and checks the final bot head", async () => {
  const port = new FakePort();
  port.content = serializeChangeset("patch", "Old fix.");
  const modelCalls: string[] = [];

  const result = await runPullRequestAutomation(
    basePr(),
    port,
    fakeModels("none", modelCalls),
    "release-bot[bot]",
    signal,
  );

  assert.deepEqual(modelCalls, ["classify"]);
  assert.deepEqual(port.calls, [
    "files",
    "read",
    "write:head-1:delete",
    "head:bot-head",
    "check:bot-head",
  ]);
  assert.equal(result.impact, "none");
  assert.match(port.checks[0].summary, /No release required/);
});

test("unsafe model prose cannot alter deterministic frontmatter", async () => {
  const port = new FakePort();

  const models: ReleaseModels = {
    async classify() {
      return "patch";
    },
    async describe() {
      return '---\n"other": major\n---\n\nFix routing.';
    },
  };

  await runPullRequestAutomation(basePr(), port, models, "release-bot[bot]", signal);
  assert.match(port.content ?? "", /^---\n"pi-typesafe-router": patch\n---/);
});

test("authorized override works without models and major remains breaking prose with a minor bump", async () => {
  const port = new FakePort();
  const models = fakeModels("none", []);

  const result = await runPullRequestAutomation(
    basePr({
      labels: ["release:major"],
      labelActors: { "release:major": "maintainer" },
      body: "## Release note\nBreaking: remove the old route.",
    }),
    port,
    models,
    "release-bot[bot]",
    signal,
  );

  assert.equal(result.source, "override");
  assert.equal(port.calls.includes("files"), false);
  assert.equal(port.content, serializeChangeset("major", "Breaking: remove the old route."));
});

test("conflicting, unauthorized, and textless release overrides fail", async () => {
  await assert.rejects(
    runPullRequestAutomation(
      basePr({ labels: ["release:none", "release:patch"] }),
      new FakePort(),
      fakeModels("none", []),
      "bot",
      signal,
    ),
    /conflicting-release-labels/,
  );
  const unauthorized = new FakePort();
  unauthorized.permissionValue = "read";
  await assert.rejects(
    runPullRequestAutomation(
      basePr({ labels: ["release:patch"], labelActors: { "release:patch": "reader" } }),
      unauthorized,
      fakeModels("none", []),
      "bot",
      signal,
    ),
    /unauthorized-release-override/,
  );
  await assert.rejects(
    runPullRequestAutomation(
      basePr({ labels: ["release:patch"], labelActors: { "release:patch": "maintainer" } }),
      new FakePort(),
      fakeModels("none", []),
      "bot",
      signal,
    ),
    /missing-release-note/,
  );
});

test("forks are rejected before files, permissions, models, or writes", async () => {
  const port = new FakePort();
  const modelCalls: string[] = [];
  await assert.rejects(
    runPullRequestAutomation(
      basePr({ headRepository: "fork/repo", labels: ["release:none"] }),
      port,
      fakeModels("none", modelCalls),
      "bot",
      signal,
    ),
    /fork-pull-requests/,
  );
  assert.deepEqual(port.calls, []);
  assert.deepEqual(modelCalls, []);
});

test("verified bot-only commits do not infer again, while human changes regenerate", async () => {
  const path = ".changeset/pr-12.md";
  const port = new FakePort();
  port.content = serializeChangeset("patch", "Fix route selection.");
  const calls: string[] = [];

  const bot = await runPullRequestAutomation(
    basePr({ latestCommit: { author: "release-bot[bot]", files: [path] } }),
    port,
    fakeModels("major", calls),
    "release-bot[bot]",
    signal,
  );

  assert.equal(bot.source, "verified-bot-update");
  assert.deepEqual(calls, []);
  assert.ok(port.calls.includes("verify-bot"));

  port.calls = [];
  await runPullRequestAutomation(
    basePr({ action: "edited", latestCommit: { author: "release-bot[bot]", files: [path] } }),
    port,
    fakeModels("patch", calls),
    "release-bot[bot]",
    signal,
  );
  assert.deepEqual(calls, ["classify", "describe:patch"]);
});

test("bot attribution without an App-owned success check regenerates", async () => {
  const path = ".changeset/pr-12.md";
  const port = new FakePort();
  port.content = serializeChangeset("patch", "Forged note.");
  port.verifiedBotUpdate = async () => false;
  const calls: string[] = [];

  const result = await runPullRequestAutomation(
    basePr({ latestCommit: { author: "release-bot[bot]", files: [path] } }),
    port,
    fakeModels("patch", calls),
    "release-bot[bot]",
    signal,
  );

  assert.equal(result.source, "model");
  assert.deepEqual(calls, ["classify", "describe:patch"]);
});

test("stale expected-head writes abort before a success check", async () => {
  const port = new FakePort();
  port.writeGeneratedFile = async () => {
    throw new Error("stale-head");
  };

  await assert.rejects(
    runPullRequestAutomation(basePr(), port, fakeModels("patch", []), "bot", signal),
    /stale-head/,
  );
  assert.equal(port.checks.length, 0);
});
