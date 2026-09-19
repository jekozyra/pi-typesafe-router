import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPreOneVersion,
  generatedChangesetPath,
  parseReleaseLabels,
  releaseNoteFromBody,
  serializeChangeset,
  toChangesetImpact,
  validateGeneratedChangeset,
} from "../scripts/release/policy.ts";

for (const [input, expected] of [
  ["none", undefined],
  ["patch", "patch"],
  ["minor", "minor"],
  ["major", "minor"],
] as const) {
  test(`pre-1.0 maps ${input} to ${expected ?? "no changeset"}`, () => {
    assert.equal(toChangesetImpact(input), expected);
  });
}

test("version policy rejects 1.0 and malformed versions", () => {
  for (const version of ["0.1.0", "0.99.2-beta.1"])
    assert.doesNotThrow(() => assertPreOneVersion(version));

  for (const version of ["1.0.0", "2.1.0", "next"])
    assert.throws(() => assertPreOneVersion(version));
});

test("deterministic serialization prevents prose from changing package identity or bump", () => {
  const content = serializeChangeset(
    "major",
    '---\n"other": major\n---\n\nBreaking: remove old API.',
  );

  assert.match(content, /^---\n"pi-typesafe-router": minor\n---\n\n/);
  assert.deepEqual(validateGeneratedChangeset(content), {
    impact: "minor",
    description: '---\n"other": major\n---\n\nBreaking: remove old API.',
  });
  assert.throws(() => validateGeneratedChangeset('---\n"other": patch\n---\n\nUnsafe\n'));
  assert.match(serializeChangeset("major", "Remove the old API."), /Breaking change: Remove/);
  assert.throws(() => serializeChangeset("patch", "unsafe\u0007text"));
});

test("override labels are singular and release notes are bounded", () => {
  assert.equal(parseReleaseLabels(["bug", "release:none"]), "none");
  assert.equal(parseReleaseLabels(["release:major"]), "major");
  assert.throws(() => parseReleaseLabels(["release:patch", "release:minor"]));
  assert.equal(
    releaseNoteFromBody("Context\n\n## Release note\nFix routing.\n\n## Testing\nCovered."),
    "Fix routing.",
  );
  assert.throws(() => releaseNoteFromBody("No note"));
});

test("generated changeset path only accepts positive PR numbers", () => {
  assert.equal(generatedChangesetPath(42), ".changeset/pr-42.md");
  assert.throws(() => generatedChangesetPath(0));
});
