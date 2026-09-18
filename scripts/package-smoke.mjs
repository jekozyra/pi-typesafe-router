import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const temp = await mkdtemp(join(tmpdir(), "pi-typesafe-router-package-"));

try {
  const output = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", temp], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );

  // npm versions emit either an array or a package-name-keyed object.
  const packed = Array.isArray(output) ? output[0] : output["pi-typesafe-router"];
  assert.ok(packed, "npm pack did not return package metadata");
  assert.ok(packed.files.some((file) => file.path === "src/index.ts"));

  for (const example of ["typesafe", "cloudflare", "vercel", "openrouter"])
    assert.ok(
      packed.files.some((file) => file.path === `examples/${example}.json`),
      `Missing configuration example: ${example}`,
    );

  for (const adr of [
    "docs/0001-route-before-generation.md",
    "docs/0002-verify-routing-with-doctor.md",
  ]) {
    assert.ok(
      packed.files.some((file) => file.path === adr),
      `Missing ADR: ${adr}`,
    );
  }

  assert.ok(
    packed.files.every((file) =>
      /^(src\/[^/]+\.ts|examples\/[^/]+\.json|docs\/\d{4}-[a-z-]+\.md|README\.md|LICENSE|package\.json)$/.test(
        file.path,
      ),
    ),
    "Unexpected package artifact",
  );
  await writeFile(join(temp, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(temp, packed.filename),
      "@earendil-works/pi-coding-agent@0.85.1",
      "@earendil-works/pi-ai@0.85.1",
      "@earendil-works/pi-tui@0.85.1",
    ],
    { cwd: temp, stdio: "inherit" },
  );
  await mkdir(join(temp, "profile"));
  await writeFile(
    join(temp, "smoke.mjs"),
    `
import assert from 'node:assert/strict';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
globalThis.fetch = async () => { throw new Error('Package smoke forbids network'); };
const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
  settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true,
  noPromptTemplates: true, noThemes: true, noContextFiles: true,
  additionalExtensionPaths: ['./node_modules/pi-typesafe-router/src/index.ts'] });
await loader.reload();
const { extensions, errors } = loader.getExtensions();
assert.deepEqual(errors, []);
assert.equal(extensions.length, 1);
assert.ok(extensions[0].commands.has('typesafe-router'));
console.log('Packed extension loads through Pi with isolated production dependencies.');
`,
  );
  execFileSync(process.execPath, ["smoke.mjs"], {
    cwd: temp,
    stdio: "inherit",
    env: {
      PATH: process.env.PATH,
      HOME: temp,
      TMPDIR: tmpdir(),
      PI_CODING_AGENT_DIR: join(temp, "profile"),
      PI_OFFLINE: "1",
      NO_COLOR: "1",
    },
  });
} finally {
  await rm(temp, { recursive: true, force: true });
}
