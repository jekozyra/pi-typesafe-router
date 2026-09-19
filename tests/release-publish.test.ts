import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPublishConflictsAbsent,
  changelogNotes,
  validatePublishIdentity,
} from "../scripts/release/publish.ts";

const identity = (overrides = {}) => ({
  merged: true,
  mergeSha: "abc1234",
  checkedOutSha: "abc1234",
  headRepository: "jekozyra/pi-typesafe-router",
  baseRepository: "jekozyra/pi-typesafe-router",
  baseRef: "main",
  headRef: "changeset-release/main",
  author: "release-bot[bot]",
  expectedBot: "release-bot[bot]",
  ...overrides,
});

test("publication selects only the exact merged managed release revision", () => {
  assert.doesNotThrow(() => validatePublishIdentity(identity()));

  for (const value of [
    { merged: false },
    { checkedOutSha: "newer-main" },
    { headRef: "feature" },
    { author: "maintainer" },
  ])
    assert.throws(() => validatePublishIdentity(identity(value)));
});

test("publication stops on existing versions, ambiguous registry state, tags, and downgrade", async () => {
  const response = (url: string, conflict?: string) => {
    if (url.endsWith("/latest")) return new Response('{"version":"0.1.0"}', { status: 200 });

    return new Response("", { status: conflict && url.includes(conflict) ? 200 : 404 });
  };

  await assertPublishConflictsAbsent("owner/repo", "0.2.0", "token", async (url) =>
    response(String(url)),
  );
  await assert.rejects(
    assertPublishConflictsAbsent("owner/repo", "0.2.0", "token", async (url) =>
      response(String(url), "pi-typesafe-router/0.2.0"),
    ),
    /npm-version/,
  );
  await assert.rejects(
    assertPublishConflictsAbsent("owner/repo", "0.2.0", "token", async (url) =>
      response(String(url), "git/ref/tags"),
    ),
    /github-release-conflict/,
  );
  await assert.rejects(
    assertPublishConflictsAbsent("owner/repo", "0.1.0", "token", async (url) =>
      response(String(url)),
    ),
    /advance-latest/,
  );
});

test("release notes are selected from the matching changelog section", () => {
  const changelog = "# pi-typesafe-router\n\n## 0.2.0\n\nNew route.\n\n## 0.1.0\n\nOld.\n";
  assert.equal(changelogNotes(changelog, "0.2.0"), "New route.\n");
  assert.throws(() => changelogNotes(changelog, "0.3.0"));
});
