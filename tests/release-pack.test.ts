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

const block = /- name: Pack once\n\s+id: pack\n\s+run: \|\n([\s\S]*?)(?=      - name:)/.exec(
  workflow,
)?.[1];

assert.ok(block, "publish workflow must define the pack step");

const script = block.replace(/^ {10}/gm, "");

const filename = "pi-typesafe-router-0.2.0.tgz";

for (const fixture of [
  { name: "npm array", output: [{ filename }], create: true, success: true },
  {
    name: "npm keyed object",
    output: { "pi-typesafe-router": { filename } },
    create: true,
    success: true,
  },
  { name: "missing tarball", output: [{ filename }], create: false, success: false },
  { name: "empty array", output: [], create: true, success: false },
  { name: "multiple packages", output: [{ filename }, { filename }], create: true, success: false },
  { name: "wrong package", output: { other: { filename } }, create: true, success: false },
  { name: "missing filename", output: [{}], create: true, success: false },
  {
    name: "unsafe filename",
    output: [{ filename: "../outside.tgz" }],
    create: true,
    success: false,
  },
  { name: "invalid JSON", output: [], invalidJson: true, create: true, success: false },
]) {
  test(`publish pack step: ${fixture.name}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "release-pack-"));

    try {
      await writeFile(
        join(dir, "npm"),
        '#!/bin/sh\nif [ "$CREATE_TARBALL" = true ]; then touch "artifacts/$FILENAME"; fi\nprintf "%s" "$PACK_JSON"\n',
        { mode: 0o700 },
      );
      await writeFile(join(dir, "output"), "");

      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GITHUB_OUTPUT: join(dir, "output"),
          FILENAME: filename,
          CREATE_TARBALL: String(fixture.create),
          PACK_JSON: fixture.invalidJson ? "not JSON" : JSON.stringify(fixture.output),
        },
      });

      assert.equal(result.status === 0, fixture.success, result.stderr);
      assert.equal(
        await readFile(join(dir, "output"), "utf8"),
        fixture.success ? `tarball=${filename}\n` : "",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
