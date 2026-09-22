/**
 * Tests for `src/policy.ts`, the single routing-policy artifact.
 *
 * The point of this file is anti-drift. The rubric used to exist twice — once in
 * `src/classifier.ts` and once in a separate measurement script — so changing one could
 * silently invalidate measurements taken with the other. These tests hold the artifact and the
 * runtime's request to one source.
 *
 * The loader is also the boundary where a configuration-supplied path becomes a document, so
 * the filesystem cases below (regular file, symlink, directory, FIFO, device, oversize, abort)
 * are the contract that keeps a bad path from hanging Pi.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { installPiStubs } from "./harness.ts";

installPiStubs();

const { MAX_POLICY_BYTES, POLICY, POLICY_PATH, loadPolicy, parsePolicy, resolvePolicy } =
  await import("../src/policy.ts");

const { RUBRIC } = await import("../src/classifier.ts");

const { policyHash } = await import("../src/provenance.ts");

async function directory(t: { after(callback: () => void): void }): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "router-policy-"));
  t.after(() => rm(path, { recursive: true, force: true }));

  return path;
}

test("the shipped artifact validates and is what the classifier sends", () => {
  assert.equal(POLICY.version, 1);
  assert.equal(POLICY.type, "choice");
  assert.equal(POLICY.question, "task_class");
  assert.deepEqual(Object.keys(POLICY.criteria).sort(), ["deep", "quick", "standard", "uncertain"]);
  assert.deepEqual(RUBRIC, {
    type: POLICY.type,
    instructions: POLICY.instructions,
    criteria: { ...POLICY.criteria },
  });
});

test("the artifact is loaded from beside the extension, so a store copy carries it", async () => {
  assert.equal(POLICY_PATH, fileURLToPath(new URL("../policy.json", import.meta.url)));
  assert.deepEqual(await loadPolicy(POLICY_PATH), POLICY);
  assert.equal(policyHash().length, 64);
});

test("the classifier source no longer inlines the rubric", async () => {
  const source = await readFile(new URL("../src/classifier.ts", import.meta.url), "utf8");

  assert.match(source, /policyQuestion\(POLICY\)/u);
  assert.ok(
    !source.includes("Small, localized, low-risk task"),
    "the rubric text must live only in policy.json",
  );
});

test("a malformed policy fails loudly instead of defaulting", () => {
  assert.throws(() => parsePolicy({}), /Invalid routing policy/u);
  assert.throws(() => parsePolicy({ ...POLICY, version: 2 }), /Invalid routing policy/u);
  assert.throws(() => parsePolicy({ ...POLICY, id: "Bad Id" }), /Invalid routing policy/u);
  assert.throws(
    () => parsePolicy({ ...POLICY, criteria: { ...POLICY.criteria, deep: " padded " } }),
    /Invalid routing policy/u,
  );
  assert.throws(
    () => parsePolicy({ ...POLICY, criteria: { quick: "x", standard: "y", deep: "z" } }),
    /Invalid routing policy/u,
  );
  assert.throws(
    () =>
      parsePolicy({
        ...POLICY,
        criteria: { ...POLICY.criteria, extra: "not a task class" },
      }),
    /Invalid routing policy/u,
  );
});

test("a rejection never echoes the rejected value", () => {
  try {
    parsePolicy({ ...POLICY, id: "sk-live-1234567890" });
    assert.fail("expected a rejection");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(!message.includes("sk-live"), message);
  }
});

test("resolvePolicy selects the bundled artifact only when no path is configured", async () => {
  assert.deepEqual(await resolvePolicy(undefined), POLICY);
});

test("resolvePolicy loads and validates an external artifact without echoing it", async (t) => {
  const path = await directory(t);
  const external = { ...POLICY, id: "external-rubric", question: "external_class" };
  const file = join(path, "policy.json");
  await writeFile(file, JSON.stringify(external));

  assert.deepEqual(await resolvePolicy(file), external);
  assert.equal(policyHash(await resolvePolicy(file)), policyHash(external));

  const missing = join(path, "missing.json");
  await assert.rejects(resolvePolicy(missing), /unreadable/u);

  const invalidJson = join(path, "invalid.json");
  await writeFile(invalidJson, "{ not json");
  await assert.rejects(resolvePolicy(invalidJson), /not valid JSON/u);

  const malformed = join(path, "malformed.json");
  await writeFile(malformed, JSON.stringify({ ...POLICY, version: 2 }));
  await assert.rejects(resolvePolicy(malformed), /Invalid routing policy/u);
  // Neither the path nor a value from the rejected file may appear in the error.
  await assert.rejects(
    resolvePolicy(malformed),
    (error) => error instanceof Error && !error.message.includes("malformed"),
  );
});

test("a symlinked artifact is followed to the regular file it names", async (t) => {
  const path = await directory(t);
  const real = join(path, "policy.json");
  const link = join(path, "linked-policy.json");
  const external = { ...POLICY, id: "linked-rubric" };
  await writeFile(real, JSON.stringify(external));
  await symlink(real, link);

  assert.equal((await loadPolicy(link)).id, "linked-rubric");
});

test("a special file fails instead of blocking the event loop", async (t) => {
  const path = await directory(t);
  const fifo = join(path, "policy.fifo");

  try {
    execFileSync("mkfifo", [fifo]);
  } catch {
    t.skip("mkfifo is unavailable on this platform");

    return;
  }

  // A plain read of a FIFO waits for a writer; the loader opens with O_NONBLOCK and rejects
  // anything that is not a regular file, so this resolves immediately.
  await assert.rejects(loadPolicy(fifo), /unreadable/u);

  const nested = join(path, "nested");
  await mkdir(nested);
  await assert.rejects(loadPolicy(nested), /unreadable/u);
  await assert.rejects(loadPolicy("/dev/null"), /unreadable/u);
});

test("an oversized artifact is refused before it is parsed", async (t) => {
  const path = await directory(t);
  const oversized = join(path, "huge-policy.json");
  await writeFile(oversized, "x".repeat(MAX_POLICY_BYTES + 1));

  await assert.rejects(loadPolicy(oversized), /too large/u);
});

test("an aborted load propagates its own reason instead of a read failure", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled by test");
  controller.abort(reason);

  await assert.rejects(loadPolicy(POLICY_PATH, controller.signal), (error) => error === reason);
});
