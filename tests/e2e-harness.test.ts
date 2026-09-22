import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { runDoctor } from "./e2e/doctor.ts";
import { liveConfig, assertDoctorPassed } from "./e2e/support.ts";

const credentials = {
  TYPESAFE_ROUTER_LIVE_E2E: "1",
  TYPESAFE_API_KEY: "synthetic-typesafe-key",
  CLOUDFLARE_API_TOKEN: "synthetic-cloudflare-key",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_GATEWAY_ID: "synthetic-gateway",
  AI_GATEWAY_API_KEY: "synthetic-vercel-key",
  OPENROUTER_API_KEY: "synthetic-openrouter-key",
};

const passed = `pi-typesafe-router: ✅
generation proofs: 3 of 3 configured target(s) verified for this session
classifier:
  typesafe / jev-1.13.0
  ✅ passed in 50 ms
routes:
  quick:
    openrouter/openai/gpt-5.6-luna (thinking: high)
    ✅ passed in 100 ms
  standard:
    openrouter/openai/gpt-5.6-luna (thinking: high)
    ✅ passed in 100 ms
  deep:
    openrouter/openai/gpt-5.6-luna (thinking: high)
    ✅ passed in 100 ms
pi-typesafe-router: status
routing: off
`;

describe("live E2E harness safeguards (offline)", () => {
  it("requires explicit opt-in and credentials without echoing values", async () => {
    await assert.rejects(liveConfig("typesafe", {}), /TYPESAFE_ROUTER_LIVE_E2E=1/);
    await assert.rejects(
      liveConfig("typesafe", { TYPESAFE_ROUTER_LIVE_E2E: "1" }),
      /OPENROUTER_API_KEY/,
    );
    await assert.rejects(
      liveConfig("typesafe", { ...credentials, TYPESAFE_API_KEY: " " }),
      /TYPESAFE_API_KEY/,
    );
  });

  it("uses the identical Luna routing policy for every backend", async () => {
    const configs = await Promise.all(
      (["typesafe", "cloudflare", "vercel", "openrouter"] as const).map((backend) =>
        liveConfig(backend, credentials),
      ),
    );

    for (const config of configs) {
      for (const chain of Object.values(config.routes))
        assert.deepEqual(chain, [
          { provider: "openrouter", model: "openai/gpt-5.6-luna", thinking: "high" },
        ]);

      const { backend: _backend, ...policy } = config;
      const { backend: _firstBackend, ...firstPolicy } = configs[0];
      assert.deepEqual(policy, firstPolicy);
      assert.equal(config.mode, "off");
    }

    assert.equal(configs[2].backend.type, "vercel");
    assert.ok(configs[2].backend.type === "vercel" && !configs[2].backend.zeroDataRetention);
    assert.deepEqual(configs[3].backend, {
      type: "openrouter",
      model: "typesafe/jev-1.13",
      auth: { source: "env", variable: "OPENROUTER_API_KEY" },
    });
  });

  it("runs the real CLI but rejects missing auth without network calls", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "router-e2e-offline-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    const config = await liveConfig("typesafe", credentials);
    await writeFile(join(agentDir, "typesafe-router.json"), JSON.stringify(config));
    await copyFile(
      new URL("./e2e/fixtures/models.json", import.meta.url),
      join(agentDir, "models.json"),
    );
    const guard = join(root, "forbid-network.mjs");
    await writeFile(
      guard,
      `globalThis.fetch = async () => {
      process.stderr.write("E2E_UNEXPECTED_NETWORK\\n");
      throw new Error("Offline test forbids network");
    };`,
    );

    const result = await runDoctor(root, {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: root,
      USERPROFILE: root,
      TMPDIR: root,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      NO_COLOR: "1",
      NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
    });

    assert.ok(result.stdout.trim() === "");
    assert.ok(!result.stderr.includes("E2E_UNEXPECTED_NETWORK"));
    assert.match(result.stderr, /pi-typesafe-router: ❌/);
    assert.match(result.stderr, /failed in \d+ ms \(credentials\)/);
    assert.match(result.stderr, /generation proofs: 0 of \d+ configured target\(s\) verified/);
    assert.throws(() => assertDoctorPassed(result.stderr, "typesafe", "jev-1.13.0"));
  });

  it("requires classifier success, all route probes, and current verification", () => {
    assertDoctorPassed(passed, "typesafe", "jev-1.13.0");

    for (const broken of [
      passed.replace("pi-typesafe-router: ✅", "pi-typesafe-router: ❌"),
      passed.replace("✅ passed in 50 ms", "❌ failed in 50 ms (HTTP 401)"),
      passed.replace(/^generation proofs: 3 of 3/m, "generation proofs: 0 of 3"),
      passed.replace("  deep:", "  missing:"),
      passed.replaceAll("openai/gpt-5.6-luna", "some-other-model"),
      passed.replace("routing: off", "routing: auto"),
      passed.replace("✅ passed in 100 ms", "❌ failed in 100 ms (timeout)"),
    ])
      assert.throws(() => assertDoctorPassed(broken, "typesafe", "jev-1.13.0"));
  });
});
