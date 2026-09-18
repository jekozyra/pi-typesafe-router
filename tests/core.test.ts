import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens, type ContextUsage } from "@earendil-works/pi-coding-agent";
import type { UserMessage } from "@earendil-works/pi-ai";
import { loadConfig } from "../src/settings.ts";
import { parseConfig } from "../src/config.ts";
import { contextInputTokens, projectState } from "../src/context.ts";
import { candidateChecks, chooseRoute } from "../src/routing.ts";
import type { Classification, Eligibility, ModelInfo, Target } from "../src/types.ts";

const target: Target = { provider: "example", model: "organization/model-id" };

const minimal = () => ({
  routes: { quick: [{ ...target }], standard: [{ ...target }], deep: [{ ...target }] },
});

test("strict config has safe defaults and preserves slash-containing model IDs", () => {
  const config = parseConfig(minimal());
  assert.deepEqual(config, {
    version: 1,
    mode: "off",
    allowHeadless: false,
    backend: {
      type: "typesafe",
      model: "jev-1.13.0",
      auth: { source: "env", variable: "TYPESAFE_API_KEY" },
    },
    timeoutMs: 1500,
    generationProbeTimeoutMs: 15000,
    minConfidence: 0.8,
    maxContextChars: 12000,
    historyMessages: 4,
    outputReserveTokens: 8192,
    routes: minimal().routes,
    defaultRoute: "deep",
    uncertainRoute: "deep",
  });
});

test("backend defaults, explicit pi credentials, and fixed gateway models", () => {
  const cloudflare = parseConfig({
    ...minimal(),
    backend: { type: "cloudflare", accountId: "aB12".repeat(8) },
  }).backend;

  assert.deepEqual(cloudflare, {
    type: "cloudflare",
    model: "typesafe/jev",
    accountId: "aB12".repeat(8),
    auth: { source: "env", variable: "CLOUDFLARE_API_TOKEN" },
  });
  assert.deepEqual(parseConfig({ ...minimal(), backend: { type: "vercel" } }).backend, {
    type: "vercel",
    model: "typesafe-ai/jev",
    auth: { source: "env", variable: "AI_GATEWAY_API_KEY" },
    zeroDataRetention: true,
  });
  const auth = { source: "pi", provider: "custom-provider" };
  assert.deepEqual(
    parseConfig({ ...minimal(), backend: { type: "typesafe", model: "jev-latest", auth } }).backend
      .auth,
    auth,
  );

  for (const backend of [
    { type: "cloudflare" },
    { type: "cloudflare", accountId: "g".repeat(32) },
    { type: "cloudflare", accountId: "a".repeat(31) },
    { type: "cloudflare", accountId: "a".repeat(32), model: "other" },
    { type: "vercel", model: "other" },
    { type: "unknown" },
  ])
    assert.throws(() => parseConfig({ ...minimal(), backend }));
});

test("malformed env references, implicit pi providers, secrets and unknown keys are rejected safely", () => {
  const secret = "sk-SUPER-SECRET-value";

  const invalid: unknown[] = [
    null,
    {},
    { ...minimal(), [secret]: true },
    { ...minimal(), backend: { type: "typesafe", apiKey: secret } },
    { ...minimal(), backend: { type: "typesafe", auth: { source: "pi" } } },
    { ...minimal(), routes: { ...minimal().routes, other: [target] } },
    { ...minimal(), routes: { ...minimal().routes, quick: [{ ...target, [secret]: secret }] } },
    ...["", "1KEY", "$KEY", "env:KEY", "KEY-NAME", " KEY", "KEY\n", secret].map((variable) => ({
      ...minimal(),
      backend: { type: "typesafe", auth: { source: "env", variable } },
    })),
  ];

  for (const value of invalid) {
    assert.throws(
      () => parseConfig(value),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Invalid router configuration; check the documented schema.");
        assert.ok(!JSON.stringify(error).includes(secret));

        return true;
      },
    );
  }
});

test("numeric constraints do not coerce and reject fractional integer fields", () => {
  for (const [key, values] of Object.entries({
    timeoutMs: [99, 30001, 100.5, "1500"],
    minConfidence: [-0.1, 1.1, NaN, Infinity],
    maxContextChars: [255, 32001, 256.5],
    historyMessages: [-1, 21, 1.5],
    outputReserveTokens: [0, 255, 131073, 256.5],
    version: [2],
    mode: ["enabled"],
    allowHeadless: ["false"],
    defaultRoute: ["uncertain"],
    uncertainRoute: ["other"],
  }))
    for (const value of values)
      assert.throws(() => parseConfig({ ...minimal(), [key]: value }), `${key}: ${value}`);
  assert.equal(
    parseConfig({ ...minimal(), historyMessages: 0, minConfidence: 0 }).historyMessages,
    0,
  );
});

test("route chains are nonempty, bounded, unique by exact identity and nonvirtual", () => {
  for (const quick of [
    [],
    Array.from({ length: 9 }, (_, i) => ({ provider: "p", model: String(i) })),
    [target, target],
  ]) {
    assert.throws(() => parseConfig({ routes: { ...minimal().routes, quick } }));
  }

  for (const provider of ["auto", "smart-router", "typesafe-router", "AUTO", "bad/provider", " "]) {
    assert.throws(() =>
      parseConfig({ routes: { ...minimal().routes, quick: [{ provider, model: "model" }] } }),
    );
  }

  assert.equal(
    parseConfig({
      routes: { ...minimal().routes, quick: [target, { ...target, provider: "other" }] },
    }).routes.quick.length,
    2,
  );
});

test("projection discloses only user/assistant text, retaining current intact", () => {
  const current = "  fix this\n";
  assert.deepEqual(
    projectState(
      current,
      [
        { role: "system", content: "system secret" },
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "image", data: "image secret" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private" },
            { type: "text", text: "second" },
            { type: "toolCall", arguments: { secret: true } },
            { type: "text", text: "third" },
          ],
        },
        { role: "toolResult", content: "tool secret" },
        { role: "custom", content: "custom secret" },
      ],
      256,
      4,
    ),
    {
      current_request: current,
      recent_conversation: [
        { role: "user", text: "first" },
        { role: "assistant", text: "second\nthird" },
      ],
    },
  );
});

test("projection keeps a newest fitting suffix; oversized middle messages stop older history", () => {
  const history = [
    { role: "user", content: "old" },
    { role: "assistant", content: "x".repeat(20) },
    { role: "user", content: "new" },
  ];

  assert.deepEqual(projectState("now", history, 9, 4)?.recent_conversation, [
    { role: "user", text: "new" },
  ]);
  assert.equal(projectState("now", history, 26, 4)?.recent_conversation.length, 2);
  assert.equal(projectState("now", history, 29, 4)?.recent_conversation.length, 3);
  assert.equal(projectState("now", history, 100, 1)?.recent_conversation.length, 1);
  assert.deepEqual(projectState("now", history, 3, 0)?.recent_conversation, []);
  assert.equal(projectState(" \n\t", [], 256, 4), undefined);
  assert.equal(projectState("x".repeat(257), [], 256, 4), undefined);
  assert.equal(projectState("now", [], NaN, 4), undefined);
  assert.deepEqual(
    projectState("now", [{ role: "user", content: [{ type: "image", data: "ignored" }] }], 256, 4)
      ?.recent_conversation,
    [],
  );
});

const contextUsage = (tokens: number | null): ContextUsage => ({
  tokens,
  contextWindow: 272_000,
  percent: tokens === null ? null : (tokens / 272_000) * 100,
});

const pending: UserMessage = { role: "user", content: "Explain é漢字👩🏽‍💻", timestamp: 0 };

const resolvedMessages: Parameters<typeof estimateTokens>[0][] = [
  { role: "user", content: "Plain text", timestamp: 0 },
  pending,
  {
    role: "user",
    content: [{ type: "image", mimeType: "image/png", data: "synthetic-image" }],
    timestamp: 0,
  },
  {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "Tool output 漢字" }],
    isError: false,
    timestamp: 0,
  },
];

test("missing host usage falls back to Pi estimates for text, Unicode, images and tools", () => {
  for (const message of resolvedMessages) {
    assert.equal(contextInputTokens(undefined, [message]), estimateTokens(message));
  }

  const total = resolvedMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
  assert.equal(contextInputTokens(undefined, resolvedMessages), total);
  assert.equal(
    contextInputTokens(undefined, resolvedMessages, pending),
    total + estimateTokens(pending),
  );
  assert.equal(contextInputTokens(undefined, []), 0);
});

test("known host usage, including zero, ignores raw history and adds the pending request once", () => {
  const huge: UserMessage = { role: "user", content: "漢".repeat(300_000), timestamp: 0 };

  for (const tokens of [0, 210_000]) {
    assert.equal(contextInputTokens(contextUsage(tokens), [huge]), tokens);
    assert.equal(
      contextInputTokens(contextUsage(tokens), [huge], pending),
      tokens + estimateTokens(pending),
    );
  }
});

test("post-compaction unknown usage never falls back to stale history", () => {
  assert.equal(contextInputTokens(contextUsage(null), resolvedMessages), null);
  assert.equal(contextInputTokens(contextUsage(null), resolvedMessages, pending), null);
  assert.equal(contextInputTokens(contextUsage(null), [], pending), null);
});

const model: ModelInfo = {
  provider: target.provider,
  id: target.model,
  input: ["text"],
  contextWindow: 10000,
  maxTokens: 4000,
};

const eligibility = (overrides: Partial<Eligibility> = {}): Eligibility => ({
  models: [model],
  available: [model],
  scope: [],
  hasImages: false,
  inputTokens: 5000,
  outputReserveTokens: 8192,
  ...overrides,
});

test("candidate checks preserve order and distinguish unknown from known unavailable", () => {
  const unknown = { provider: "other", model: target.model };
  const checks = candidateChecks([unknown, target], eligibility());
  assert.deepEqual(
    checks.map((check) => check.target),
    [unknown, target],
  );
  assert.equal(checks[0]?.reason, "unknown-model");
  assert.equal(checks[1]?.eligible, true);
  assert.equal(candidateChecks([target], eligibility({ available: [] }))[0]?.reason, "unavailable");
  assert.equal(
    candidateChecks([target], eligibility({ available: [{ ...model, provider: "other" }] }))[0]
      ?.eligible,
    false,
  );
});

test("scope uses qualified identity, images require modality, virtual providers never qualify", () => {
  assert.equal(
    candidateChecks([target], eligibility({ scope: [{ ...target, provider: "other" }] }))[0]
      ?.reason,
    "out-of-scope",
  );
  assert.equal(candidateChecks([target], eligibility({ scope: [target] }))[0]?.eligible, true);
  assert.equal(
    candidateChecks([target], eligibility({ hasImages: true }))[0]?.reason,
    "image-unsupported",
  );
  assert.equal(
    candidateChecks(
      [target],
      eligibility({ hasImages: true, models: [{ ...model, input: ["text", "image"] }] }),
    )[0]?.eligible,
    true,
  );

  for (const provider of ["auto", "smart-router", "typesafe-router"]) {
    const virtual = { ...model, provider };
    assert.equal(
      candidateChecks(
        [{ ...target, provider }],
        eligibility({ models: [virtual], available: [virtual] }),
      )[0]?.reason,
      "virtual-provider",
    );
  }
});

test("context checks reserve min(configured output, model limit) and reject invalid budgets", () => {
  assert.equal(candidateChecks([target], eligibility({ inputTokens: 6000 }))[0]?.eligible, true);
  assert.equal(
    candidateChecks([target], eligibility({ inputTokens: 6001 }))[0]?.reason,
    "context-overflow",
  );
  assert.equal(
    candidateChecks([target], eligibility({ inputTokens: 9000, outputReserveTokens: 1000 }))[0]
      ?.eligible,
    true,
  );

  for (const value of [0, -1, NaN, Infinity]) {
    assert.equal(
      candidateChecks([target], eligibility({ outputReserveTokens: value }))[0]?.eligible,
      false,
    );

    for (const key of ["maxTokens", "contextWindow"]) {
      assert.equal(
        candidateChecks([target], eligibility({ models: [{ ...model, [key]: value }] }))[0]?.reason,
        "invalid-model-limits",
      );
    }
  }

  for (const inputTokens of [-1, NaN, Infinity])
    assert.equal(candidateChecks([target], eligibility({ inputTokens }))[0]?.eligible, false);
});

test("unknown context usage skips only overflow checks", () => {
  const unknownUsage = eligibility({ inputTokens: null });
  assert.equal(candidateChecks([target], unknownUsage)[0]?.eligible, true);
  assert.equal(
    candidateChecks([target], { ...unknownUsage, models: [{ ...model, contextWindow: 1 }] })[0]
      ?.eligible,
    true,
  );

  for (const [overrides, reason] of [
    [{ models: [] }, "unknown-model"],
    [{ available: [] }, "unavailable"],
    [{ scope: [{ ...target, provider: "other" }] }, "out-of-scope"],
    [{ hasImages: true }, "image-unsupported"],
    [{ models: [{ ...model, maxTokens: 0 }] }, "invalid-model-limits"],
    [{ models: [{ ...model, contextWindow: 0 }] }, "invalid-model-limits"],
  ] satisfies [Partial<Eligibility>, string][]) {
    assert.equal(candidateChecks([target], { ...unknownUsage, ...overrides })[0]?.reason, reason);
  }

  for (const outputReserveTokens of [0, -1, NaN, Infinity]) {
    assert.equal(
      candidateChecks([target], { ...unknownUsage, outputReserveTokens })[0]?.eligible,
      false,
    );
  }

  const virtual = { ...model, provider: "auto" };
  assert.equal(
    candidateChecks([{ ...target, provider: "auto" }], {
      ...unknownUsage,
      models: [virtual],
      available: [virtual],
    })[0]?.reason,
    "virtual-provider",
  );
});

test("missing classification uses default; uncertain or missing/low confidence abstains", () => {
  const config = parseConfig({ ...minimal(), defaultRoute: "standard", uncertainRoute: "deep" });

  const classification: Classification = {
    choice: "quick",
    confidence: 0.8,
    probabilities: { quick: 1, standard: 0, deep: 0, uncertain: 0 },
    requestedModel: "jev-1.13.0",
  };

  assert.equal(chooseRoute(undefined, config), "standard");
  assert.equal(chooseRoute(classification, config), "quick");

  for (const confidence of [undefined, 0.799, NaN, Infinity, -1, 1.1]) {
    assert.equal(chooseRoute({ ...classification, confidence }, config), "deep");
  }

  assert.equal(
    chooseRoute({ ...classification, choice: "uncertain", confidence: 1 }, config),
    "deep",
  );
});

test("projection validates malformed blocks without losing valid empty text blocks", () => {
  assert.deepEqual(
    projectState(
      "now",
      [
        {
          role: "user",
          content: [
            null,
            7,
            { type: "text", text: 42 },
            { type: "text", text: "" },
            { type: "image", text: "private" },
            { type: "text", text: "kept" },
          ],
        },
      ],
      256,
      4,
    )?.recent_conversation,
    [{ role: "user", text: "\nkept" }],
  );
});

test("settings recognizes missing files and sanitizes malformed configurations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-router-settings-"));
  const path = join(directory, "config.json");

  try {
    assert.equal(await loadConfig(path), undefined);
    await writeFile(path, JSON.stringify(minimal()));
    assert.deepEqual(await loadConfig(path), parseConfig(minimal()));

    for (const text of ["secret-invalid-json", JSON.stringify({ secret: "private" })]) {
      await writeFile(path, text);
      await assert.rejects(loadConfig(path), {
        name: "Error",
        message:
          "Invalid or unreadable router config. Check JSON, fields, bounds and model mappings.",
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generation probe timeout accepts only integer milliseconds within bounds", () => {
  for (const generationProbeTimeoutMs of [100, 15000, 60000])
    assert.equal(
      parseConfig({ ...minimal(), generationProbeTimeoutMs }).generationProbeTimeoutMs,
      generationProbeTimeoutMs,
    );

  for (const generationProbeTimeoutMs of [99, 60001, 100.5, "15000", null, NaN, Infinity])
    assert.throws(() => parseConfig({ ...minimal(), generationProbeTimeoutMs }));
});
