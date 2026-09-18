import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runDoctor } from "./doctor.ts";
import { classify } from "../../src/classifier.ts";
import { ClassifierError, TASK_CLASSES } from "../../src/types.ts";
import { assertDoctorPassed, credentialVariables, liveConfig } from "./support.ts";

describe("live backend authentication → doctor", { concurrency: false }, () => {
  for (const backend of ["typesafe", "cloudflare", "vercel", "openrouter"] as const)
    it(
      `${backend}: authenticates to Jev and passes doctor with Luna in all tiers`,
      { timeout: 150_000 },
      async (t) => {
        const config = await liveConfig(backend, process.env);
        const keyVariable = credentialVariables[backend];
        const apiKey = process.env[keyVariable]!;
        const root = await mkdtemp(join(tmpdir(), "pi-typesafe-router-e2e-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const agentDir = join(root, "agent");
        await mkdir(agentDir);
        await writeFile(join(agentDir, "typesafe-router.json"), JSON.stringify(config), {
          mode: 0o600,
        });
        await writeFile(
          join(agentDir, "settings.json"),
          JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }),
        );
        // Pin a minimal test catalogue so an older Pi snapshot cannot silently substitute a model.
        // Pi's default metadata is enough for these tiny, text-only probes, not a capacity benchmark.
        await copyFile(
          new URL("./fixtures/models.json", import.meta.url),
          join(agentDir, "models.json"),
        );

        // Auth success requires a real, validated Jev answer, not merely a nonempty key or HTTP 200.
        const answer = await classify(
          config.backend,
          {
            current_request: "Explain what a variable is in one sentence.",
            recent_conversation: [],
          },
          { apiKey, signal: AbortSignal.timeout(config.timeoutMs) },
        ).catch((error) => {
          assert.fail(
            error instanceof ClassifierError
              ? `${backend}: Jev authentication/access failed (${error.code}${error.status ? ` HTTP ${error.status}` : ""})`
              : `${backend}: Jev authentication/access failed`,
          );
        });

        assert.ok(
          TASK_CLASSES.includes(answer.choice),
          `${backend}: Jev returned no valid task class`,
        );
        t.diagnostic(`${backend}: authenticated Jev access passed`);

        // This second stage loads the unmodified extension and exercises its credential resolver.
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
          [credentialVariables.openrouter]: process.env[credentialVariables.openrouter],
          [keyVariable]: apiKey,
        });

        assert.ok(
          result.stdout.trim() === "",
          `${backend}: diagnostics unexpectedly generated task output`,
        );
        assert.ok(
          result.stderr.includes(`auth: environment ${keyVariable}`),
          `${backend}: doctor did not use the configured credential source`,
        );
        assertDoctorPassed(result.stderr, backend, config.backend.model);
        assert.ok(
          result.stderr.includes("(2/2 complete)"),
          `${backend}: doctor did not complete its classifier and deduplicated model checks`,
        );
        t.diagnostic(`${backend}: doctor passed; all tiers verified; routing remains off`);
      },
    );
});
