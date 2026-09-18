import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseConfig } from "../../src/config.ts";
import type { RouterConfig } from "../../src/types.ts";

export type BackendName = RouterConfig["backend"]["type"];

export const credentialVariables = {
  typesafe: "TYPESAFE_API_KEY",
  cloudflare: "CLOUDFLARE_API_TOKEN",
  vercel: "AI_GATEWAY_API_KEY",
} as const;

/** Opt-in must precede any credential access or potentially billable work. */
export async function liveConfig(backend: BackendName, env: NodeJS.ProcessEnv) {
  assert.ok(
    env.TYPESAFE_ROUTER_LIVE_E2E === "1",
    "Live tests may incur charges. Set TYPESAFE_ROUTER_LIVE_E2E=1 to opt in.",
  );

  const required = ["OPENROUTER_API_KEY", credentialVariables[backend]];

  if (backend === "cloudflare") required.push("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID");

  for (const name of required)
    assert.ok(env[name]?.trim(), `Missing required environment: ${name}`);

  const stock = JSON.parse(
    await readFile(new URL("./fixtures/router.json", import.meta.url), "utf8"),
  );

  return parseConfig({
    ...stock,
    backend:
      backend === "cloudflare"
        ? {
            type: backend,
            auth: { source: "env", variable: credentialVariables[backend] },
            accountId: env.CLOUDFLARE_ACCOUNT_ID,
            gatewayId: env.CLOUDFLARE_GATEWAY_ID,
          }
        : backend === "vercel"
          ? {
              type: backend,
              auth: { source: "env", variable: credentialVariables[backend] },
              // Explicitly approved for synthetic live tests on Vercel Hobby only.
              zeroDataRetention: false,
            }
          : { type: backend, auth: { source: "env", variable: credentialVariables[backend] } },
  });
}

/** A successful command exit alone does not mean doctor passed. Never echo raw child output. */
export function assertDoctorPassed(output: string, backend: BackendName, model: string) {
  assert.ok(output.includes("pi-typesafe-router: ✅"), `${backend}: doctor did not report success`);
  assert.ok(
    output.includes(`classifier:\n  ${backend} / ${model}\n  ✅ passed in `),
    `${backend}: doctor did not verify authenticated Jev access`,
  );

  for (const route of ["quick", "standard", "deep"])
    assert.ok(
      output.includes(`  ${route}:\n    openrouter/openai/gpt-5.6-luna\n    ✅ passed in `),
      `${backend}: ${route} did not pass the Luna generation probe`,
    );

  assert.ok(!output.includes("not routable:"), `${backend}: a route is locally ineligible`);
  assert.ok(
    /^generation verification: verified at /m.test(output),
    `${backend}: session verification was not granted`,
  );
  assert.ok(/^routing: off(?: .*)?$/m.test(output), `${backend}: doctor did not preserve off mode`);
  assert.ok(!/^routing: (?:auto|shadow)/m.test(output), `${backend}: diagnostics enabled routing`);
}
