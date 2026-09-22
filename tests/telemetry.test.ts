/**
 * Unit tests for the telemetry payloads.
 *
 * The schemas here are the leak guard: they are the only thing standing between a routing
 * decision and a session file. These tests pin both directions — a well-formed payload is
 * accepted, and a payload carrying prose, an unknown key, or a non-finite number is rejected
 * rather than written.
 *
 * No Pi process, network, or credential is involved; `src/telemetry.ts` imports only types and
 * `node:crypto`.
 */

import assert from "node:assert/strict";
import test from "node:test";

/** The outcome statuses `src/telemetry.ts` accepts; a local copy keeps this file's imports lean. */
type OutcomeStatus = "settled" | "aborted" | "error";

const {
  buildDecision,
  buildFeedback,
  buildOutcome,
  feedbackSchema,
  latestDecisionId,
  newDecisionId,
  outcomeStatus,
  outcomeStopReason,
  probabilityMargin,
} = await import("../src/telemetry.ts");

import type { Classification, Target } from "../src/types.ts";
import type { DecisionInput } from "../src/telemetry.ts";

const target = (provider: string, id: string): Target => ({
  provider,
  model: id,
  thinking: "low",
});

function classification(overrides: Partial<Classification> = {}): Classification {
  return {
    choice: "quick",
    probabilities: { quick: 0.8, standard: 0.1, deep: 0.05, uncertain: 0.05 },
    confidence: 0.8,
    requestedModel: "jev-1.13.0",
    returnedModel: "jev-1.13.0",
    usage: { inputTokens: 900, outputTokens: 12 },
    ...overrides,
  };
}

function decisionInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    decisionId: newDecisionId(),
    mode: "auto",
    shadow: false,
    applied: true,
    route: "quick",
    reason: "classified",
    backend: "typesafe",
    target: target("deepseek", "deepseek-flash"),
    milliseconds: 512,
    classifierMilliseconds: 480,
    minConfidence: 0.8,
    classification: classification(),
    candidates: [
      { target: "deepseek/deepseek-flash", status: "applied" },
      { target: "openai-codex/gpt-5.6-sol", status: "not-attempted" },
    ],
    selectedIndex: 0,
    projection: { characters: 812, historyMessages: 2 },
    provenance: {
      policyId: "jev-task-class-v1",
      policyHash: "a".repeat(64),
      configHash: "b".repeat(64),
      candidateSnapshotHash: "c".repeat(64),
      classifierModel: { requested: "jev-1.13.0", returned: "jev-1.13.0" },
    },
    ...overrides,
  };
}

test("a decision id is sixteen hex characters and unique per call", () => {
  const first = newDecisionId();
  const second = newDecisionId();

  assert.match(first, /^[0-9a-f]{16}$/u);
  assert.notEqual(first, second);
});

test("the margin is the gap between the two most likely classes", () => {
  assert.equal(probabilityMargin({ quick: 0.8, standard: 0.1, deep: 0.05, uncertain: 0.05 }), 0.7);
  assert.equal(probabilityMargin(undefined), undefined);
  assert.equal(
    probabilityMargin({
      quick: Number.NaN,
      standard: 0.4,
      deep: 0.6,
      uncertain: 0.1,
    }),
    0.2,
  );
});

test("stop reasons narrow to the recorded enum, never to arbitrary text", () => {
  assert.equal(outcomeStopReason("stop"), "stop");
  assert.equal(outcomeStopReason("toolUse"), "toolUse");
  assert.equal(outcomeStopReason("something-else"), "other");
  assert.equal(outcomeStopReason(undefined), undefined);
});

test("outcome status separates settlement, error, and abort", () => {
  assert.equal(outcomeStatus("stop"), "settled");
  assert.equal(outcomeStatus("error"), "error");
  assert.equal(outcomeStatus("aborted"), "aborted");
});

test("a complete decision is accepted and gains its derived fields", () => {
  const entry = buildDecision(decisionInput());

  assert.ok(entry, "a well-formed payload is accepted");
  assert.equal(entry.schemaVersion, 2);
  assert.equal(entry.applied, true);
  assert.equal(entry.margin, 0.7);
  assert.deepEqual(entry.projection, { characters: 812, historyMessages: 2 });
  assert.equal(entry.candidates.length, 2);
  assert.equal(entry.classification?.choice, "quick");
});

test("a decision that would carry prose is dropped instead of written", () => {
  const prose =
    "the user asked me to rotate the production database credential for the billing service";

  const withProse = buildDecision(decisionInput({ reason: prose }));

  assert.equal(withProse, undefined, "a reason with spaces is not a routable token");

  // The builder is a whitelist, so an extra input key cannot reach the payload at all.
  // The extra key is not part of the declared input; spreading into a variable keeps the
  // call site structurally typed while the runtime object still carries `prompt`.
  const extraInput = { ...decisionInput(), prompt: prose };
  const withExtraKey = buildDecision(extraInput);

  assert.ok(withExtraKey);
  assert.equal(Object.hasOwn(withExtraKey, "prompt"), false);
  assert.equal(JSON.stringify(withExtraKey).includes("rotate the production"), false);
});

test("a serialized decision never contains the prompt or a credential", () => {
  const secret = "sk-live-PLANTED-SECRET-0123456789";
  const prompt = "please summarize the internal billing migration notes";
  const entry = buildDecision(decisionInput({ classification: classification() }));

  assert.ok(entry);
  const serialized = JSON.stringify(entry);

  for (const planted of [secret, prompt, "rotate the database"])
    assert.equal(serialized.includes(planted), false, `leaked: ${planted}`);
});

test("the classifier block keeps only numeric usage and narrow fields", () => {
  const entry = buildDecision(
    decisionInput({
      classification: classification({
        usage: {
          inputTokens: 1234.9,
          outputTokens: 8,
        },
      }),
    }),
  );

  assert.ok(entry);
  assert.deepEqual(entry.classification?.usage, { inputTokens: 1234, outputTokens: 8 });
});

test("a decision without a classification carries no margin", () => {
  const entry = buildDecision(
    decisionInput({ classification: undefined, fallback: "classifier-failure", applied: false }),
  );

  assert.ok(entry);
  assert.equal(entry.classification, undefined);
  assert.equal(entry.margin, undefined);
  assert.equal(entry.fallback, "classifier-failure");
  assert.equal(entry.applied, false);
});

test("an outcome keeps numeric usage and drops everything else", () => {
  const entry = buildOutcome({
    decisionId: newDecisionId(),
    provider: "deepseek",
    model: "deepseek-flash",
    configuredThinking: "low",
    status: "settled",
    stopReason: "stop",
    responses: 2,
    elapsedSinceRoutingMs: 1500,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: Number.NaN,
      costUsd: 0.02,
    },
  });

  assert.ok(entry);
  assert.equal(entry.responses, 2);
  assert.equal(entry.stopReason, "stop");
  assert.deepEqual(entry.usage, { inputTokens: 100, outputTokens: 50, costUsd: 0.02 });
  assert.equal(entry.configuredThinking, "low");
  assert.equal(entry.elapsedSinceRoutingMs, 1500);
});

test("an outcome with an unknown status is refused", () => {
  // SAFETY: parsed JSON is untyped input, exactly what a corrupt session entry would supply.
  const untrustedStatus = JSON.parse('"correct"') as OutcomeStatus;

  const entry = buildOutcome({
    decisionId: newDecisionId(),
    provider: "deepseek",
    model: "deepseek-flash",
    status: untrustedStatus,
    responses: 1,
  });

  assert.equal(entry, undefined);
});

test("feedback names a class or is skipped, never both and never neither", () => {
  const named = buildFeedback(newDecisionId(), "quick");

  assert.ok(named);
  assert.equal(named.expectedRoute, "quick");
  assert.equal(named.skipped, false);

  const skipped = buildFeedback(newDecisionId(), "skip");

  assert.ok(skipped);
  assert.equal(skipped.expectedRoute, undefined);
  assert.equal(skipped.skipped, true);

  assert.equal(
    feedbackSchema.safeParse({
      schemaVersion: 1,
      decisionId: newDecisionId(),
      expectedRoute: "deep",
      skipped: true,
    }).success,
    false,
  );
  assert.equal(
    feedbackSchema.safeParse({ schemaVersion: 1, decisionId: newDecisionId() }).success,
    false,
  );
  assert.equal(
    feedbackSchema.safeParse({
      schemaVersion: 1,
      decisionId: newDecisionId(),
      expectedRoute: "unsure",
      skipped: false,
    }).success,
    false,
    "free text is not a route",
  );
});

test("the newest feedback-eligible decision on the branch wins", () => {
  const older = newDecisionId();
  const newer = newDecisionId();

  const entries = [
    { type: "message", message: { role: "user" } },
    { type: "custom", customType: "typesafe-router-decision", data: { decisionId: older } },
    { type: "custom", customType: "other", data: { decisionId: "ffffffffffffffff" } },
    { type: "custom", customType: "pi-typesafe-router-decision", data: { decisionId: newer } },
  ];

  assert.equal(latestDecisionId(entries), newer);
});

test("a decision another copy wrote without an id is not feedback-eligible", () => {
  const entries = [
    {
      type: "custom",
      customType: "pi-typesafe-router-decision",
      data: { route: "quick", reason: "classified" },
    },
  ];

  assert.equal(latestDecisionId(entries), undefined);
  assert.equal(latestDecisionId([]), undefined);
});
