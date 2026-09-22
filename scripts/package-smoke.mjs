import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");

const temp = await mkdtemp(join(tmpdir(), "pi-typesafe-router-package-"));

try {
  const suppliedTarball = process.env.PACKAGE_TARBALL;
  let packed;

  if (suppliedTarball) {
    const filename = resolve(suppliedTarball);
    const listing = execFileSync("tar", ["-tzf", filename], { encoding: "utf8" });
    packed = {
      filename,
      files: listing
        .trim()
        .split("\n")
        .filter((path) => path.startsWith("package/"))
        .map((path) => ({ path: path.slice("package/".length) })),
    };
  } else {
    const output = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--pack-destination", temp], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }),
    );

    // npm versions emit either an array or a package-name-keyed object.
    packed = Array.isArray(output) ? output[0] : output["pi-typesafe-router"];
  }

  assert.ok(packed, "npm pack did not return package metadata");
  assert.ok(packed.files.some((file) => file.path === "src/index.ts"));
  assert.ok(
    packed.files.some((file) => file.path === "policy.json"),
    "Missing bundled classifier policy",
  );

  for (const example of ["typesafe", "cloudflare", "vercel", "openrouter"])
    assert.ok(
      packed.files.some((file) => file.path === `examples/${example}.json`),
      `Missing configuration example: ${example}`,
    );

  for (const adr of [
    "docs/0001-route-before-generation.md",
    "docs/0002-verify-routing-with-doctor.md",
    "docs/0004-route-local-verification-and-recovery.md",
    "docs/0005-policy-provenance-and-local-diagnostics.md",
    "docs/0006-routing-telemetry-boundaries.md",
  ]) {
    assert.ok(
      packed.files.some((file) => file.path === adr),
      `Missing ADR: ${adr}`,
    );
  }

  assert.ok(
    packed.files.every((file) =>
      /^(src\/[^/]+\.ts|examples\/[^/]+\.json|docs\/\d{4}-[a-z-]+\.md|README\.md|LICENSE|package\.json|policy\.json)$/.test(
        file.path,
      ),
    ),
    "Unexpected package artifact",
  );
  const archive = suppliedTarball ? packed.filename : join(temp, packed.filename);
  await writeFile(join(temp, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      archive,
      "@earendil-works/pi-coding-agent@0.85.1",
      "@earendil-works/pi-ai@0.85.1",
      "@earendil-works/pi-tui@0.85.1",
    ],
    { cwd: temp, stdio: "inherit" },
  );

  // The bundled rubric ships beside the extension and must still validate as an artifact.
  const installedPolicy = JSON.parse(
    await readFile(join(temp, "node_modules/pi-typesafe-router/policy.json"), "utf8"),
  );

  assert.equal(installedPolicy.version, 1);
  assert.deepEqual(Object.keys(installedPolicy.criteria).sort(), [
    "deep",
    "quick",
    "standard",
    "uncertain",
  ]);

  // The installed TYPESCRIPT, not only the bundled JSON shape: the packed module must resolve an
  // external rubric and refuse a malformed one, offline and without echoing the path. Node
  // refuses type stripping under `node_modules`, so the shipped files are copied out first —
  // which also asserts they are present in the tarball.
  const artifact = join(temp, "artifact");
  await mkdir(join(artifact, "src"), { recursive: true });

  for (const file of ["src/policy.ts", "src/types.ts", "src/bounded-file.ts", "policy.json"]) {
    await copyFile(join(temp, "node_modules/pi-typesafe-router", file), join(artifact, file));
  }

  const policyModule = pathToFileURL(join(artifact, "src/policy.ts")).href;

  const policyProbe = `
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const { loadPolicy, resolvePolicy } = await import(${JSON.stringify(policyModule)});
const bundled = await resolvePolicy(undefined);
assert.equal(bundled.version, 1);
const external = { ...bundled, id: "external-rubric", question: "external_class" };
const valid = join(process.cwd(), "external-policy.json");
await writeFile(valid, JSON.stringify(external));
const loaded = await loadPolicy(valid);
assert.equal(loaded.id, "external-rubric");
assert.equal(loaded.question, "external_class");
const malformed = join(process.cwd(), "malformed-policy.json");
await writeFile(malformed, JSON.stringify({ ...bundled, id: "Bad Id" }));
await assert.rejects(loadPolicy(malformed), /Invalid routing policy/);
await assert.rejects(
  loadPolicy(malformed),
  (error) => !String(error.message).includes("malformed-policy"),
);
console.log("Packed artifact resolves external policies and rejects malformed ones.");
`;

  execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", policyProbe],
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
