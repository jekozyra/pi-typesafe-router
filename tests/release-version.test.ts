import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { updateLockfileVersion } from "../scripts/release/version.js";

test("release versioning preserves all lockfile dependency metadata", async () => {
  const text = await readFile(new URL("../package-lock.json", import.meta.url), "utf8");
  const expected = JSON.parse(text);
  expected.version = "0.2.0";
  expected.packages[""].version = "0.2.0";

  assert.equal(
    updateLockfileVersion('{"version":"0.2.0"}', text),
    `${JSON.stringify(expected, null, 2)}\n`,
  );
});

test("release versioning retains libc metadata and is idempotent", () => {
  const lock = {
    version: "0.1.0",
    lockfileVersion: 3,
    packages: {
      "": { version: "0.1.0", name: "example", dependencies: { native: "1.0.0" } },
      "node_modules/native": { version: "1.0.0", libc: ["musl"], integrity: "unchanged" },
    },
  };

  const updated = updateLockfileVersion('{"version":"0.2.0"}', JSON.stringify(lock));
  lock.version = "0.2.0";
  lock.packages[""].version = "0.2.0";
  assert.deepEqual(JSON.parse(updated), lock);
  assert.equal(updateLockfileVersion('{"version":"0.2.0"}', updated), updated);
});

test("release command does not regenerate dependency metadata with npm install", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    pkg.scripts["release:version"],
    "changeset version && tsx scripts/release/version.ts",
  );
});
