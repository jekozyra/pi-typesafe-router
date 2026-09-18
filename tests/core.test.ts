import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/settings.ts";
import { parseConfig } from "../src/config.ts";
import { estimateInputTokens, projectState } from "../src/context.ts";
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

test("token estimate includes system, conversation, tools, unicode and image reserves without base64 expansion", () => {
  const base = estimateInputTokens("", [], []);
  const messages = [{ role: "user", content: "é".repeat(100) }];
  assert.ok(estimateInputTokens("", messages, []) >= base + 200);
  assert.ok(
    estimateInputTokens("system", messages, [
      { name: "tool", schema: { description: "x".repeat(1000) } },
    ]) >
      base + 1200,
  );

  const image = (data: string) =>
    estimateInputTokens(
      "",
      [{ role: "user", content: [{ type: "image", mimeType: "image/png", data }] }],
      [],
    );

  assert.ok(image("small") > base + 16000);
  assert.equal(image("small"), image("x".repeat(100000)));

  interface CircularFixture {
    self?: CircularFixture;
  }

  const circular: CircularFixture = {};
  circular.self = circular;
  assert.equal(estimateInputTokens("", [circular], []), Infinity);
});

test("token estimate preserves own __proto__ payloads and cycles", () => {
  const large = "x".repeat(100_000);
  const payload = { ["__proto__"]: large };

  assert.ok(estimateInputTokens("", [payload], []) >= Buffer.byteLength(JSON.stringify(payload)));

  const circular = {};
  Object.defineProperty(circular, "__proto__", { value: circular, enumerable: true });
  assert.equal(estimateInputTokens("", [circular], []), Infinity);
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

test("token estimates fail closed for unsupported values and preserve ancestor identity", () => {
  for (const value of [() => "secret", Symbol("secret"), 1n, NaN, Infinity, -Infinity]) {
    assert.equal(estimateInputTokens("", [value], []), Infinity);
    assert.equal(estimateInputTokens("", [{ nested: value }], []), Infinity);
  }

  const cycle: unknown[] = [];
  cycle.push({ nested: cycle });
  assert.equal(estimateInputTokens("", cycle, []), Infinity);
  const shared = Object.freeze({ text: "same" });
  assert.equal(
    estimateInputTokens("", [shared, shared], []),
    estimateInputTokens("", [{ text: "same" }, { text: "same" }], []),
  );
  assert.equal(estimateInputTokens("", [undefined], []), estimateInputTokens("", [null], []));
  assert.equal(
    estimateInputTokens(
      "",
      [
        {
          get text() {
            throw new Error("secret");
          },
        },
      ],
      [],
    ),
    Infinity,
  );

  for (const type of ["image", "image_url", "input_image"]) {
    assert.equal(
      estimateInputTokens("", [{ type, source: cycle, data: "long".repeat(10000) }], []),
      estimateInputTokens("", [{ type, source: "small", data: "small" }], []),
    );
  }
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
