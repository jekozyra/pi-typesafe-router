/**
 * Policy tests for `src/routing.ts`.
 *
 * Two pure functions live here and both are the kind of code that fails silently in
 * production: `chooseRoute` decides which model a prompt reaches, and `candidateChecks`
 * decides whether a configured target is usable right now. Neither touches Pi, so every
 * boundary is reachable offline.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { baseConfigInput, installPiStubs, model, target } from "./harness.ts";

installPiStubs();

const { candidateChecks, chooseRoute } = await import("../src/routing.ts");

const { parseConfig } = await import("../src/config.ts");

import type { Classification, Eligibility, TaskClass } from "../src/types.ts";

const config = parseConfig(baseConfigInput());

function classification(choice: TaskClass, confidence?: number): Classification {
  const probabilities: Record<TaskClass, number> = {
    quick: 0.4,
    standard: 0.3,
    deep: 0.2,
    uncertain: 0.1,
  };

  const result: Classification = {
    choice,
    probabilities,
    requestedModel: "jev-1.13.0",
  };

  if (confidence !== undefined) result.confidence = confidence;

  return result;
}

interface EligibilityOptions {
  models?: Eligibility["models"];
  available?: Eligibility["available"];
  scope?: Eligibility["scope"];
  hasImages?: boolean;
  inputTokens?: number | null;
  outputReserveTokens?: number;
}

function eligibility(options: EligibilityOptions = {}): Eligibility {
  return {
    models: options.models ?? [],
    available: options.available ?? [],
    scope: options.scope ?? [],
    hasImages: options.hasImages ?? false,
    inputTokens: options.inputTokens === undefined ? 1000 : options.inputTokens,
    outputReserveTokens: options.outputReserveTokens ?? 8192,
  };
}

test("a missing classification uses the default route", () => {
  assert.equal(chooseRoute(undefined, config), "deep");
});

test("a confident label selects its own route", () => {
  assert.equal(chooseRoute(classification("quick", 0.9), config), "quick");
  assert.equal(chooseRoute(classification("standard", 0.9), config), "standard");
  assert.equal(chooseRoute(classification("deep", 0.9), config), "deep");
});

test("the confidence floor is inclusive", () => {
  assert.equal(chooseRoute(classification("quick", 0.8), config), "quick");
  assert.equal(chooseRoute(classification("quick", 0.7999), config), "deep");
});

test("an uncertain label always takes the uncertain route", () => {
  assert.equal(chooseRoute(classification("uncertain", 1), config), "deep");
  assert.equal(chooseRoute(classification("uncertain", 0.1), config), "deep");
});

test("missing or out-of-range confidence is treated as certain failure", () => {
  for (const confidence of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.5, 2])
    assert.equal(chooseRoute(classification("quick", confidence), config), "deep");
});

test("an unrecognized label falls back rather than passing through", () => {
  // SAFETY: the value is deliberately outside TaskClass to prove the router rejects it.
  const bogus = { ...classification("quick", 0.99), choice: "medium" as TaskClass };

  assert.equal(chooseRoute(bogus, config), "deep");
});

test("configured default and uncertain routes are honored", () => {
  const custom = parseConfig({
    ...baseConfigInput(),
    defaultRoute: "quick",
    uncertainRoute: "standard",
  });

  assert.equal(chooseRoute(undefined, custom), "quick");
  assert.equal(chooseRoute(classification("uncertain", 1), custom), "standard");
  assert.equal(chooseRoute(classification("deep", 0.1), custom), "standard");
  assert.equal(chooseRoute(classification("deep", 0.9), custom), "deep");
});

test("an eligible target passes every check", () => {
  const entry = model("provider-a", "model-a");

  const checks = candidateChecks(
    [target("provider-a", "model-a")],
    eligibility({ models: [entry], available: [entry] }),
  );

  assert.deepEqual(checks, [{ target: target("provider-a", "model-a"), eligible: true }]);
});

test("check order and count follow the configured chain", () => {
  const first = target("provider-a", "one");
  const second = target("provider-b", "two");
  const entry = model("provider-a", "one");

  const checks = candidateChecks(
    [first, second],
    eligibility({ models: [entry], available: [entry] }),
  );

  assert.equal(checks.length, 2);
  assert.equal(checks[0]?.target.model, "one");
  assert.equal(checks[0]?.eligible, true);
  assert.equal(checks[1]?.target.model, "two");
  assert.equal(checks[1]?.reason, "unknown-model");
});

test("a virtual provider is never a generation target", () => {
  const checks = candidateChecks([target("auto", "model-a")], eligibility());
  assert.equal(checks[0]?.reason, "virtual-provider");
});

test("an unknown model is rejected before anything else is inspected", () => {
  const checks = candidateChecks(
    [target("provider-a", "missing")],
    eligibility({ hasImages: true }),
  );

  assert.equal(checks[0]?.reason, "unknown-model");
});

test("an unavailable model is rejected", () => {
  const entry = model("provider-a", "model-a");

  const checks = candidateChecks(
    [target("provider-a", "model-a")],
    eligibility({ models: [entry], available: [] }),
  );

  assert.equal(checks[0]?.reason, "unavailable");
});

test("model scope excludes a target only when a scope exists", () => {
  const entry = model("provider-a", "model-a");

  const outside = candidateChecks(
    [target("provider-a", "model-a")],
    eligibility({ models: [entry], available: [entry], scope: [target("provider-b", "other")] }),
  );

  const unscoped = candidateChecks(
    [target("provider-a", "model-a")],
    eligibility({ models: [entry], available: [entry] }),
  );

  assert.equal(outside[0]?.reason, "out-of-scope");
  assert.equal(unscoped[0]?.eligible, true);
});

test("an image-bearing turn rejects a text-only model", () => {
  const textOnly = model("provider-a", "model-a");
  const multimodal = model("provider-a", "model-a", { input: ["text", "image"] });

  const rejected = candidateChecks(
    [target("provider-a", "model-a")],
    eligibility({ models: [textOnly], available: [textOnly], hasImages: true }),
  );

  const accepted = candidateChecks(
    [target("provider-a", "model-a")],
    eligibility({ models: [multimodal], available: [multimodal], hasImages: true }),
  );

  assert.equal(rejected[0]?.reason, "image-unsupported");
  assert.equal(accepted[0]?.eligible, true);
});

test("invalid model limits are rejected", () => {
  for (const entry of [
    model("provider-a", "model-a", { contextWindow: 0 }),
    model("provider-a", "model-a", { maxTokens: 0 }),
    model("provider-a", "model-a", { contextWindow: Number.NaN }),
    model("provider-a", "model-a", { maxTokens: Number.POSITIVE_INFINITY }),
  ]) {
    const checks = candidateChecks(
      [target("provider-a", "model-a")],
      eligibility({ models: [entry], available: [entry] }),
    );

    assert.equal(checks[0]?.reason, "invalid-model-limits");
  }
});

test("an unusable token budget is rejected", () => {
  const entry = model("provider-a", "model-a");

  const negative = candidateChecks(
    [target("provider-a", "model-a")],
    eligibility({ models: [entry], available: [entry], inputTokens: -1 }),
  );

  const notANumber = candidateChecks(
    [target("provider-a", "model-a")],
    eligibility({ models: [entry], available: [entry], inputTokens: Number.NaN }),
  );

  const noReserve = candidateChecks(
    [target("provider-a", "model-a")],
    eligibility({ models: [entry], available: [entry], outputReserveTokens: 0 }),
  );

  assert.equal(negative[0]?.reason, "invalid-token-budget");
  assert.equal(notANumber[0]?.reason, "invalid-token-budget");
  assert.equal(noReserve[0]?.reason, "invalid-token-budget");
});

test("an unknown input size defers the context check to Pi", () => {
  const entry = model("provider-a", "model-a", { contextWindow: 10, maxTokens: 4 });

  const checks = candidateChecks(
    [target("provider-a", "model-a")],
    eligibility({
      models: [entry],
      available: [entry],
      inputTokens: null,
      outputReserveTokens: 8192,
    }),
  );

  assert.equal(checks[0]?.eligible, true);
});

test("the context check is inclusive at the boundary", () => {
  const entry = model("provider-a", "model-a", { contextWindow: 1000, maxTokens: 100 });

  const exact = candidateChecks(
    [target("provider-a", "model-a")],
    eligibility({
      models: [entry],
      available: [entry],
      inputTokens: 900,
      outputReserveTokens: 100,
    }),
  );

  const over = candidateChecks(
    [target("provider-a", "model-a")],
    eligibility({
      models: [entry],
      available: [entry],
      inputTokens: 901,
      outputReserveTokens: 100,
    }),
  );

  assert.equal(exact[0]?.eligible, true);
  assert.equal(over[0]?.reason, "context-overflow");
});

test("the output reserve is clamped to the model's own maximum", () => {
  const entry = model("provider-a", "model-a", { contextWindow: 1000, maxTokens: 100 });

  const fits = candidateChecks(
    [target("provider-a", "model-a")],
    eligibility({
      models: [entry],
      available: [entry],
      inputTokens: 900,
      outputReserveTokens: 8192,
    }),
  );

  const overflows = candidateChecks(
    [target("provider-a", "model-a")],
    eligibility({
      models: [entry],
      available: [entry],
      inputTokens: 901,
      outputReserveTokens: 8192,
    }),
  );

  assert.equal(fits[0]?.eligible, true);
  assert.equal(overflows[0]?.reason, "context-overflow");
});
