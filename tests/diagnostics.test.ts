/**
 * Rendering tests for `src/diagnostics.ts`.
 *
 * This text is the router's whole user interface: `status`, `doctor`, and the warning a
 * preflight fallback prints. It is pure string composition, so it is cheap to pin — and
 * worth pinning, because a diagnostic that stops naming the failed target or the next
 * action turns a recoverable misconfiguration into a support ticket.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { baseConfigInput, installPiStubs, target } from "./harness.ts";

installPiStubs();

const { classifierLines, routeLines, runtimeLines } = await import("../src/diagnostics.ts");

const { parseConfig } = await import("../src/config.ts");

const config = parseConfig(baseConfigInput());

test("runtime lines name the backend, the credential reference, and the policy", () => {
  const lines = runtimeLines("auto", "idle", "/tmp/router.json", config).join("\n");

  assert.match(lines, /routing: auto/);
  assert.match(lines, /classifier: typesafe \/ jev-1\.13\.0/);
  assert.match(lines, /environment TYPESAFE_API_KEY/);
  assert.match(lines, /minimum confidence 0\.8/);
  assert.match(lines, /default deep; uncertain deep/);
});

test("runtime lines say routing is off, and that it cannot be configured", () => {
  assert.match(
    runtimeLines("off", "idle", "/tmp/router.json").join("\n"),
    /automatic routing is disabled/,
  );
  assert.match(runtimeLines("off", "idle", "/tmp/router.json").join("\n"), /not configured/);
});

test("a confident classification reports the label and confidence", () => {
  const lines = classifierLines(
    {
      reason: "classified",
      classification: {
        choice: "quick",
        probabilities: { quick: 0.95, standard: 0.03, deep: 0.01, uncertain: 0.01 },
        confidence: 0.95,
        requestedModel: "jev-1.13.0",
      },
    },
    120,
    config,
  ).join("\n");

  assert.match(lines, /✅ passed in 120 ms \(quick; confidence 0\.95\)/);
  assert.ok(!lines.includes("conservative"));
});

test("a low-confidence classification explains the conservative route", () => {
  const lines = classifierLines(
    {
      reason: "uncertain",
      classification: {
        choice: "quick",
        probabilities: { quick: 0.5, standard: 0.3, deep: 0.1, uncertain: 0.1 },
        confidence: 0.5,
        requestedModel: "jev-1.13.0",
      },
    },
    120,
    config,
  ).join("\n");

  assert.match(lines, /uses the conservative deep route/);
  assert.match(lines, /not generation success probability/);
});

test("a missing classifier credential names the variable to set", () => {
  const lines = classifierLines(
    { reason: "Classifier credentials", failure: { code: "credentials" } },
    30,
    config,
  ).join("\n");

  assert.match(lines, /❌ failed in 30 ms/);
  assert.match(lines, /set TYPESAFE_API_KEY in Pi's launch environment/);
});

test("an auth failure and a rate limit get different next actions", () => {
  const unauthorized = classifierLines(
    { reason: "http", failure: { code: "http", status: 401 } },
    30,
    config,
  ).join("\n");

  const limited = classifierLines(
    { reason: "http", failure: { code: "http", status: 429 } },
    30,
    config,
  ).join("\n");

  assert.match(unauthorized, /check the classifier credential's validity and permissions/);
  assert.match(limited, /check classifier quota or rate limits/);
  assert.notEqual(unauthorized, limited);
});

test("a timeout names the setting that bounds it", () => {
  const lines = classifierLines(
    { reason: "classifier-timeout", failure: { code: "timeout" } },
    1500,
    config,
  ).join("\n");

  assert.match(lines, /increase timeoutMs \(currently 1500\)/);
});

test("route lines report each candidate's probe outcome and restriction", () => {
  const lines = routeLines(
    {
      quick: [
        { target: target("provider-quick", "quick-model", "low"), eligible: true },
        {
          target: target("provider-missing", "gone", "low"),
          eligible: false,
          reason: "unknown-model",
        },
        { target: target("provider-quick", "unchecked", "low"), eligible: true },
      ],
    },
    [
      {
        target: target("provider-quick", "quick-model", "low"),
        passed: true,
        reason: "ok",
        milliseconds: 412,
      },
      {
        target: target("provider-missing", "gone", "low"),
        passed: false,
        reason: "timeout",
        milliseconds: 15_000,
      },
    ],
  ).join("\n");

  assert.match(lines, /✅ passed in 412 ms/);
  assert.match(lines, /❌ failed in 15000 ms \(timeout\)/);
  assert.match(lines, /not routable: model not found in Pi's catalogue/);
  assert.match(lines, /unchecked \(thinking: low\)\n {4}not checked/);
});

test("an unmapped restriction reason is printed rather than swallowed", () => {
  const lines = routeLines(
    {
      deep: [
        {
          target: target("provider-deep", "deep-model", "high"),
          eligible: false,
          reason: "novel-reason",
        },
      ],
    },
    [],
  ).join("\n");

  assert.match(lines, /not routable: novel-reason/);
});

test("an ineligible candidate with no reason is still described", () => {
  const lines = routeLines(
    { deep: [{ target: target("provider-deep", "deep-model", "high"), eligible: false }] },
    [],
  ).join("\n");

  assert.match(lines, /not routable: ineligible; no reason supplied/);
});
