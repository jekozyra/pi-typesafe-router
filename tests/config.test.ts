/**
 * Schema tests for `src/config.ts`.
 *
 * `parseConfig` is the only door into the router, and it deliberately replaces every Zod
 * error with one fixed sentence, because issue paths and unknown-key diagnostics can carry
 * credential-looking values. So these tests pin two things at once: which documents are
 * accepted, and that a rejection never echoes the rejected value.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { baseConfigInput, baseConfigInputV2, baseRoutes, installPiStubs } from "./harness.ts";

installPiStubs();

const { parseConfig } = await import("../src/config.ts");

const { historyRoles } = await import("../src/types.ts");

const REJECTION = "Invalid router configuration; check the documented schema.";

/**
 * Parse and return the thrown message, or `undefined` when the input was accepted.
 *
 * The parameter is untyped on purpose: every case below is deliberately malformed, and the
 * schema boundary under test is what decides whether it is a valid configuration.
 */
// oxlint-disable-next-line anti-slop/no-object-parameters -- arbitrary malformed input is the point
function rejectionMessage(value: object): string | undefined {
  try {
    parseConfig(value);

    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// oxlint-disable-next-line anti-slop/no-object-parameters -- arbitrary malformed input is the point
function rejects(value: object): void {
  assert.equal(rejectionMessage(value), REJECTION);
}

// oxlint-disable-next-line anti-slop/no-object-parameters -- arbitrary input is the point
function accepts(value: object) {
  return parseConfig(value);
}

test("accepts the documented configuration", () => {
  const config = accepts(baseConfigInput());

  assert.equal(config.version, 1);
  assert.equal(config.mode, "off");
  assert.deepEqual(
    config.routes.quick.map((target) => target.thinking),
    ["low"],
  );
  assert.equal(config.backend.type, "typesafe");
});

test("applies documented defaults to a minimal document", () => {
  const config = accepts({
    routes: {
      quick: [{ provider: "provider-a", model: "model-a" }],
      standard: [{ provider: "provider-a", model: "model-b" }],
      deep: [{ provider: "provider-a", model: "model-c" }],
    },
  });

  assert.equal(config.version, 1);
  assert.equal(config.mode, "off");
  assert.equal(config.allowHeadless, false);
  assert.equal(config.timeoutMs, 1500);
  assert.equal(config.generationProbeTimeoutMs, 15_000);
  assert.equal(config.minConfidence, 0.8);
  assert.equal(config.maxContextChars, 12_000);
  assert.equal(config.historyMessages, 4);
  assert.equal(config.outputReserveTokens, 8192);
  assert.equal(config.defaultRoute, "deep");
  assert.equal(config.uncertainRoute, "deep");
  assert.deepEqual(config.backend, {
    type: "typesafe",
    model: "jev-1.13.0",
    auth: { source: "env", variable: "TYPESAFE_API_KEY" },
  });
  // A target's effort defaults to high, so an edited route cannot silently lose its level.
  assert.equal(config.routes.quick[0]?.thinking, "high");
});

test("fills backend defaults for a named backend", () => {
  const cloudflare = accepts({
    ...baseConfigInput(),
    backend: { type: "cloudflare", accountId: "a".repeat(32), gatewayId: "gateway" },
  });

  assert.equal(cloudflare.backend.type, "cloudflare");
  assert.deepEqual(cloudflare.backend, {
    type: "cloudflare",
    model: "typesafe/jev",
    accountId: "a".repeat(32),
    gatewayId: "gateway",
    auth: { source: "env", variable: "CLOUDFLARE_API_TOKEN" },
  });
});

test("rejects unknown keys at every level", () => {
  rejects({ ...baseConfigInput(), extra: true });
  rejects({ ...baseConfigInput(), backend: { type: "typesafe", model: "m", extra: true } });
  rejects({
    ...baseConfigInput(),
    routes: {
      quick: [{ provider: "p", model: "m", authority: "y" }],
      standard: [{ provider: "p", model: "m" }],
      deep: [{ provider: "p", model: "m" }],
    },
  });
});

test("rejects a missing route", () => {
  const base = baseConfigInput();
  rejects({ ...base, routes: { quick: [{ provider: "p", model: "m" }] } });
});

test("rejects a chain with duplicated provider/model pairs", () => {
  rejects({
    ...baseConfigInput(),
    routes: {
      ...baseRoutes(),
      quick: [
        { provider: "p", model: "m" },
        { provider: "p", model: "m", thinking: "low" },
      ],
    },
  });
});

test("bounds chain length to 1..8 targets", () => {
  rejects({ ...baseConfigInput(), routes: { quick: [], standard: [], deep: [] } });

  const nine = Array.from({ length: 9 }, (_value, index) => ({
    provider: "p",
    model: `m-${index}`,
  }));

  rejects({
    ...baseConfigInput(),
    routes: {
      quick: nine,
      standard: [{ provider: "p", model: "s" }],
      deep: [{ provider: "p", model: "d" }],
    },
  });
});

test("rejects virtual providers, which cannot generate", () => {
  for (const provider of ["auto", "smart-router", "typesafe-router", "AUTO"])
    rejects({
      ...baseConfigInput(),
      routes: {
        quick: [{ provider, model: "m" }],
        standard: [{ provider: "p", model: "s" }],
        deep: [{ provider: "p", model: "d" }],
      },
    });
});

test("rejects a provider containing a slash separator", () => {
  rejects({
    ...baseConfigInput(),
    routes: {
      quick: [{ provider: "vendor/model", model: "m" }],
      standard: [{ provider: "p", model: "s" }],
      deep: [{ provider: "p", model: "d" }],
    },
  });
});

test("rejects identifiers with padding or control characters", () => {
  for (const identifier of [
    " padded",
    "padded ",
    "two words",
    "control\u0007bell",
    "newline\nvalue",
  ])
    rejects({
      ...baseConfigInput(),
      routes: {
        quick: [{ provider: "p", model: identifier }],
        standard: [{ provider: "p", model: "s" }],
        deep: [{ provider: "p", model: "d" }],
      },
    });
});

test("validates the Cloudflare account ID and gateway ID", () => {
  rejects({
    ...baseConfigInput(),
    backend: { type: "cloudflare", accountId: "not-hex", gatewayId: "gateway" },
  });
  rejects({
    ...baseConfigInput(),
    backend: { type: "cloudflare", accountId: "a".repeat(31), gatewayId: "gateway" },
  });
  rejects({
    ...baseConfigInput(),
    backend: { type: "cloudflare", accountId: "a".repeat(32), gatewayId: "" },
  });
});

test("validates the credential variable name", () => {
  rejects({
    ...baseConfigInput(),
    backend: { type: "typesafe", model: "m", auth: { source: "env", variable: "1BAD" } },
  });
  rejects({
    ...baseConfigInput(),
    backend: { type: "typesafe", model: "m", auth: { source: "env", variable: "BAD NAME" } },
  });
  rejects({
    ...baseConfigInput(),
    backend: { type: "typesafe", model: "m", auth: { source: "pi", provider: "auto" } },
  });
});

test("bounds numeric fields", () => {
  for (const patch of [
    { timeoutMs: 99 },
    { timeoutMs: 30_001 },
    { timeoutMs: 1.5 },
    { generationProbeTimeoutMs: 99 },
    { minConfidence: 1.5 },
    { minConfidence: -0.1 },
    { maxContextChars: 255 },
    { maxContextChars: 32_001 },
    { historyMessages: 21 },
    { outputReserveTokens: 255 },
    { outputReserveTokens: 131_073 },
  ])
    rejects({ ...baseConfigInput(), ...patch });
});

test("rejects an unknown enum member and an unsupported version", () => {
  rejects({ ...baseConfigInput(), mode: "auto-please" });
  rejects({ ...baseConfigInput(), defaultRoute: "uncertain" });
  rejects({ ...baseConfigInput(), version: 3 });
  rejects({
    ...baseConfigInput(),
    routes: {
      ...baseRoutes(),
      quick: [{ provider: "p", model: "m", thinking: "maximum" }],
    },
  });
});

test("version 1 keeps the historical projection and rejects the v2 field", () => {
  const config = accepts(baseConfigInput());

  assert.equal(config.version, 1);
  assert.deepEqual(historyRoles(config), ["user", "assistant"]);
  rejects({ ...baseConfigInput(), historyRoles: ["user"] });
});

test("version 2 defaults the projection to user-only", () => {
  const explicit = accepts(baseConfigInputV2());
  const implicit = accepts({ ...baseConfigInputV2(), historyRoles: undefined });

  assert.equal(explicit.version, 2);
  assert.deepEqual(historyRoles(explicit), ["user"]);
  assert.deepEqual(historyRoles(implicit), ["user"]);
});

test("version 2 accepts an explicit projection and bounds it", () => {
  const both = accepts({ ...baseConfigInputV2(), historyRoles: ["user", "assistant"] });

  assert.deepEqual(historyRoles(both), ["user", "assistant"]);
  rejects({ ...baseConfigInputV2(), historyRoles: [] });
  rejects({ ...baseConfigInputV2(), historyRoles: ["system"] });
  rejects({ ...baseConfigInputV2(), historyRoles: ["user", "user"] });
});

test("never echoes the rejected value or its field name", () => {
  const message = rejectionMessage({
    ...baseConfigInput(),
    timeoutMs: 1,
    secretProbe: "sk-live-123",
  });

  assert.equal(message, REJECTION);
  assert.ok(!message?.includes("sk-live"));
  assert.ok(!message?.includes("timeoutMs"));
  assert.ok(!message?.includes("secretProbe"));
});

test("accepts auto mode and single-target routes", () => {
  const config = accepts({
    ...baseConfigInput(),
    mode: "auto",
    routes: {
      quick: [{ provider: "p", model: "one", thinking: "low" }],
      standard: [{ provider: "p", model: "one", thinking: "low" }],
      deep: [{ provider: "p", model: "one", thinking: "low" }],
    },
  });

  assert.equal(config.mode, "auto");
  // The same target may appear in several routes; only within one chain must it be unique.
  assert.equal(config.routes.deep[0]?.model, "one");
});

test("policyPath accepts an absolute path in either version and rejects unusable ones", () => {
  const absolute = "/etc/pi-typesafe-router/policy.json";

  assert.equal(accepts({ ...baseConfigInput(), policyPath: absolute }).policyPath, absolute);
  assert.equal(accepts({ ...baseConfigInputV2(), policyPath: absolute }).policyPath, absolute);

  for (const policyPath of [
    "relative/policy.json",
    " /absolute/policy.json",
    "/absolute/policy.json ",
    "",
    "/absolute/\u0000.json",
    7,
  ])
    rejects({ ...baseConfigInput(), policyPath });
});

test("the README's policyPath example is a configuration this schema accepts", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  const blocks = readme
    .split("```json")
    .slice(1)
    .map((part) => part.split("```")[0] ?? "");

  const example = blocks.find((block) => block.includes('"policyPath"'));

  assert.ok(example, "README must document a policyPath example");

  // A documented example that fails the schema teaches every reader a broken document.
  const parsed = parseConfig(JSON.parse(example));

  assert.equal(parsed.policyPath, "/absolute/path/to/policy.json");
  assert.deepEqual(Object.keys(parsed.routes).sort(), ["deep", "quick", "standard"]);
  assert.equal(parsed.routes.quick.length, 2);
});
