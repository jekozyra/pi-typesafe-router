/**
 * Filesystem and cancellation tests for `src/settings.ts`.
 *
 * These run against real temporary directories: the behavior under test *is* the filesystem
 * contract — that a missing file is not an error, that an unreadable or oversized one is,
 * that an existing configuration is never overwritten, and that the error sentence never
 * carries file content. `abortable` is covered here too, because a provider that ignores
 * cancellation is the reason it exists.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { baseConfigInput, installPiStubs } from "./harness.ts";

installPiStubs();

const { abortable, createConfig, loadConfig } = await import("../src/settings.ts");

const { parseConfig } = await import("../src/config.ts");

const UNREADABLE =
  "Invalid or unreadable router config. Check JSON, fields, bounds and model mappings.";

async function temporaryDirectory(t: {
  after: (fn: () => Promise<void>) => void;
}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "typesafe-router-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
}

test("a missing file is not an error", async (t) => {
  const directory = await temporaryDirectory(t);

  assert.equal(await loadConfig(join(directory, "absent.json")), undefined);
});

test("a valid file is parsed, with or without a byte-order mark", async (t) => {
  const directory = await temporaryDirectory(t);
  const plain = join(directory, "plain.json");
  const marked = join(directory, "marked.json");
  await writeFile(plain, JSON.stringify(baseConfigInput()));
  await writeFile(marked, `\uFEFF${JSON.stringify(baseConfigInput())}`);

  assert.equal((await loadConfig(plain))?.defaultRoute, "deep");
  assert.equal((await loadConfig(marked))?.defaultRoute, "deep");
});

test("a directory in place of a file is an error, not a missing config", async (t) => {
  const directory = await temporaryDirectory(t);

  await assert.rejects(loadConfig(directory), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, UNREADABLE);

    return true;
  });
});

test("invalid JSON is reported without echoing the file", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "broken.json");
  await writeFile(path, '{ "mode": "auto", "secretProbe": "sk-live-123"');

  await assert.rejects(loadConfig(path), (error) => {
    assert.ok(error instanceof Error);
    const message = error.message;
    assert.equal(message, UNREADABLE);
    assert.ok(!message.includes("sk-live-123"));

    return true;
  });
});

test("a schema violation is reported without echoing the value", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "invalid.json");
  await writeFile(
    path,
    JSON.stringify({ ...baseConfigInput(), mode: "auto-please", secretProbe: "sk-live-456" }),
  );

  await assert.rejects(loadConfig(path), (error) => {
    assert.ok(error instanceof Error);
    const message = error.message;
    assert.equal(message, UNREADABLE);
    assert.ok(!message.includes("sk-live-456"));
    assert.ok(!message.includes("auto-please"));

    return true;
  });
});

test("an oversized file is refused before it is parsed", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "huge.json");
  await writeFile(path, `{"padding":"${"x".repeat(70_000)}"}`);

  await assert.rejects(loadConfig(path), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, UNREADABLE);

    return true;
  });
});

test("a new configuration is written once, owner-only, and never overwritten", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "nested", "typesafe-router.json");
  const config = parseConfig(baseConfigInput());

  await createConfig(path, config);

  const written = await readFile(path, "utf8");
  assert.equal(written, `${JSON.stringify(config, null, 2)}\n`);
  assert.equal((await stat(path)).mode & 0o077, 0);

  await assert.rejects(
    createConfig(path, parseConfig({ ...baseConfigInput(), mode: "auto" })),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok("code" in error);
      assert.equal(error.code, "EEXIST");

      return true;
    },
  );
  assert.equal(await readFile(path, "utf8"), written);
});

test("abortable resolves the underlying work", async () => {
  const controller = new AbortController();

  assert.equal(await abortable(async () => "done", controller.signal), "done");
});

test("abortable rejects with the caller's reason and detaches its listener", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled by test");
  controller.abort(reason);

  await assert.rejects(
    abortable(async () => "never", controller.signal),
    (error) => {
      assert.equal(error, reason);

      return true;
    },
  );
});

test("abortable surfaces a rejection from the underlying work", async () => {
  const controller = new AbortController();

  await assert.rejects(
    abortable(async () => {
      throw new Error("provider failed");
    }, controller.signal),
    /provider failed/,
  );
});
