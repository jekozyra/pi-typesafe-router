/**
 * Tests for `src/provenance.ts`.
 *
 * A decision's audit trail must be stable (a reformatted config cannot change it),
 * discriminating (a changed candidate order must change it), and free of anything secret.
 * The last property is the one worth testing hardest: provenance is persisted into session
 * files, so a credential value reaching a hash input would be a disclosure.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { baseConfigInput, baseConfigInputV2, installPiStubs } from "./harness.ts";

installPiStubs();

const {
  candidateSnapshotHash,
  canonicalJson,
  configHash,
  policyHash,
  provenanceExpectation,
  sha256Hex,
  verifyProvenance,
} = await import("../src/provenance.ts");

const { parseConfig } = await import("../src/config.ts");

const { POLICY } = await import("../src/policy.ts");

const { ClassifierError } = await import("../src/types.ts");

import type { Backend, Classification } from "../src/types.ts";

const HEX = /^[0-9a-f]{64}$/u;

const TYPESAFE: Backend = {
  type: "typesafe",
  model: "jev-1.13.0",
  auth: { source: "env", variable: "TYPESAFE_API_KEY" },
};

function classification(returnedModel?: string): Classification {
  const result: Classification = {
    choice: "quick",
    probabilities: { quick: 0.7, standard: 0.1, deep: 0.1, uncertain: 0.1 },
    confidence: 0.7,
    requestedModel: "jev-1.13.0",
  };

  if (returnedModel !== undefined) result.returnedModel = returnedModel;

  return result;
}

test("canonical JSON sorts keys, keeps array order, and drops undefined", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, 1] } }), '{"a":{"c":[3,1],"d":2},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalJson([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
  assert.equal(canonicalJson("x"), '"x"');
  assert.equal(canonicalJson(null), "null");
  assert.throws(() => canonicalJson({ a: Number.NaN }), /canonical/u);
  assert.throws(() => canonicalJson(() => {}), /canonical/u);
});

test("a hash ignores key order but not content", () => {
  assert.equal(sha256Hex({ a: 1, b: 2 }), sha256Hex({ b: 2, a: 1 }));
  assert.notEqual(sha256Hex({ a: 1 }), sha256Hex({ a: 2 }));
  assert.match(sha256Hex({ a: 1 }), HEX);
});

test("the policy hash is stable, and it moves when the rubric moves", () => {
  assert.match(policyHash(), HEX);
  assert.equal(policyHash(), policyHash());

  const edited = { ...POLICY, criteria: { ...POLICY.criteria } };

  edited.criteria.deep = `${edited.criteria.deep} changed`;
  assert.notEqual(policyHash(edited), policyHash());
});

test("the config hash separates versions and projections", () => {
  const v1 = parseConfig(baseConfigInput());
  const v2 = parseConfig(baseConfigInputV2());

  assert.match(configHash(v1), HEX);
  assert.notEqual(configHash(v1), configHash(v2), "a projection change is a provenance change");
  assert.notEqual(
    configHash(v2),
    configHash(parseConfig({ ...baseConfigInputV2(), historyRoles: ["user", "assistant"] })),
  );
});

test("the candidate snapshot hash preserves order and thinking level", () => {
  const routes = parseConfig(baseConfigInput()).routes;
  const hash = candidateSnapshotHash(routes);

  assert.match(hash, HEX);
  assert.equal(hash, candidateSnapshotHash(routes));
  assert.equal(
    hash,
    candidateSnapshotHash(parseConfig(baseConfigInput()).routes),
    "an identically rebuilt config hashes the same",
  );

  // Preference and fallback order are the whole point of a chain, so an order change must
  // move the hash even though the same targets are present.
  const pair = [...routes.quick, ...routes.standard];

  assert.notEqual(
    candidateSnapshotHash({ ...routes, quick: pair }),
    candidateSnapshotHash({ ...routes, quick: [...pair].reverse() }),
  );
  assert.notEqual(
    candidateSnapshotHash({ ...routes, quick: pair }),
    candidateSnapshotHash({
      ...routes,
      quick: pair.map((target, index) =>
        index === 0 ? { ...target, thinking: "high" as const } : target,
      ),
    }),
    "the applied effort is part of the snapshot",
  );
});

test("a hash input carries credential references, never credential material", () => {
  process.env.TYPESAFE_API_KEY = "sk-live-must-not-appear";

  try {
    const config = parseConfig(baseConfigInput());
    const canonical = canonicalJson(config);

    assert.ok(!canonical.includes("sk-live-must-not-appear"), canonical);
    assert.ok(!/apikey|password|bearer/iu.test(canonical), canonical);
    assert.match(canonical, /"variable":"TYPESAFE_API_KEY"/u);
    assert.match(configHash(config), HEX);
  } finally {
    delete process.env.TYPESAFE_API_KEY;
  }
});

test("provenance expectations match what each transport can attest", () => {
  assert.deepEqual(provenanceExpectation(TYPESAFE), {
    mode: "exact",
    expected: "jev-1.13.0",
  });
  assert.deepEqual(
    provenanceExpectation({
      type: "openrouter",
      model: "typesafe/jev-1.13",
      auth: { source: "env", variable: "OPENROUTER_API_KEY" },
    }),
    { mode: "exact", expected: "typesafe/jev-1.13" },
  );

  for (const backend of [
    {
      type: "cloudflare",
      model: "typesafe/jev",
      accountId: "a".repeat(32),
      gatewayId: "gateway",
      auth: { source: "env", variable: "CLOUDFLARE_API_TOKEN" },
    },
    {
      type: "vercel",
      model: "typesafe-ai/jev",
      auth: { source: "env", variable: "AI_GATEWAY_API_KEY" },
      zeroDataRetention: true,
    },
  ] as const)
    assert.equal(provenanceExpectation(backend).mode, "unavailable");
});

test("an exact-provenance backend requires the configured model back", () => {
  verifyProvenance(TYPESAFE, classification("jev-1.13.0"));

  for (const returned of [undefined, "jev-1.12.0", "jev-latest"]) {
    assert.throws(
      () => verifyProvenance(TYPESAFE, classification(returned)),
      (error) => error instanceof ClassifierError && error.code === "model-mismatch",
      `returned ${String(returned)} must be refused`,
    );
  }
});

test("a gateway that cannot attest provenance is not failed for it", () => {
  const backend: Backend = {
    type: "cloudflare",
    model: "typesafe/jev",
    accountId: "a".repeat(32),
    gatewayId: "gateway",
    auth: { source: "env", variable: "CLOUDFLARE_API_TOKEN" },
  };

  verifyProvenance(backend, classification());
  verifyProvenance(backend, classification("something-else"));
});
