import test from "node:test";
import assert from "node:assert/strict";
import { buildModelInput, INPUT_LIMITS, type PullRequestFile } from "../scripts/release/input.ts";

const file = (overrides: Partial<PullRequestFile> = {}): PullRequestFile => ({
  filename: "src/index.ts",
  status: "modified",
  additions: 2,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-old\n+new",
  ...overrides,
});

const input = (files: PullRequestFile[]) =>
  buildModelInput({ number: 7, title: "Fix routing", body: "Details", files });

test("model input is bounded structured data and keeps dependency manifests", () => {
  const parsed = JSON.parse(input([file(), file({ filename: "package.json" })]));
  assert.equal(parsed.title, "Fix routing");
  assert.deepEqual(
    parsed.files.map((value: PullRequestFile) => value.filename),
    ["src/index.ts", "package.json"],
  );
});

test("the controller-owned changeset is excluded from inference", () => {
  const parsed = JSON.parse(input([file({ filename: ".changeset/pr-7.md" }), file()]));
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].filename, "src/index.ts");
});

test("missing patches, binaries, oversized input, and excess pagination fail visibly", () => {
  assert.throws(() => input([file({ patch: undefined })]), /incomplete-diff/);
  assert.throws(
    () => input([file({ filename: "asset.bin", patch: undefined })]),
    /incomplete-diff/,
  );
  assert.throws(
    () =>
      buildModelInput({
        number: 1,
        title: "x",
        body: "x".repeat(INPUT_LIMITS.body + 1),
        files: [],
      }),
    /input-too-large/,
  );
  assert.throws(
    () =>
      input(
        Array.from({ length: INPUT_LIMITS.files + 1 }, (_, index) =>
          file({ filename: `f-${index}` }),
        ),
      ),
    /too-many-files/,
  );
});
