/**
 * Stable provenance hashes for a routing decision.
 *
 * A decision records which policy, which configuration, and which ordered candidate set
 * produced it, so a past route can be audited without storing the prompt or any credential.
 * Every hash here is SHA-256 over canonical JSON: object keys are sorted, so a reformatted
 * config or a reordered policy file still hashes the same.
 *
 * Nothing in this module reads a credential value. Configuration's own credential fields are
 * references (`{source: "env", variable}` or `{source: "pi", provider}`), and those names are
 * part of the provenance on purpose: changing which credential is used changes the hash.
 */

import { createHash } from "node:crypto";
import { POLICY, type RoutingPolicy } from "./policy.ts";
import {
  ClassifierError,
  type Backend,
  type Classification,
  type Route,
  type RouterConfig,
  type Target,
} from "./types.ts";

/**
 * Encode any JSON-representable value. This is the canonical encoder itself, so `unknown` is
 * the correct parameter type: a value that JSON cannot represent throws here rather than being
 * coerced. Per-iteration disables record that, instead of hiding it behind a wider type.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- canonical JSON encodes arbitrary values
function canonical(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a JSON value's runtime type is its decoded domain
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonical JSON does not support this number");

      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      // SAFETY: the `object` case of the typeof switch above left only object values here.
      const container = value as object;

      if (seen.has(container)) throw new Error("canonical JSON does not support cycles");
      seen.add(container);

      try {
        if (Array.isArray(container))
          return `[${container.map((item) => canonical(item, seen)).join(",")}]`;

        // SAFETY: a non-array object is encoded through its own enumerable string keys.
        // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- arbitrary object keys, each re-encoded by canonical
        const record = container as Record<string, unknown>;

        const keys = Object.keys(record)
          .filter((key) => record[key] !== undefined)
          .sort();

        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key], seen)}`).join(",")}}`;
      } finally {
        seen.delete(container);
      }
    }

    default:
      throw new Error("canonical JSON does not support this value");
  }
}

/** Canonical JSON: object keys sorted, arrays preserved in order, `undefined` keys dropped. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the public canonical encoder
export function canonicalJson(value: unknown): string {
  return canonical(value, new Set());
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- hashing an arbitrary canonical value
export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** The classifier rubric that produced a decision. */
export function policyHash(policy: RoutingPolicy = POLICY): string {
  return sha256Hex(policy);
}

/**
 * The applied configuration, including credential *references* and the projection policy.
 * Session mode changes made by `/typesafe-router on|off` are session state, not file state,
 * so they do not enter this hash.
 */
export function configHash(config: RouterConfig): string {
  return sha256Hex(config);
}

/** The ordered route chains, preserving preference and fallback order. */
export function candidateSnapshotHash(routes: Record<Route, readonly Target[]>): string {
  return sha256Hex(routes);
}

export type ProvenanceExpectation =
  | { mode: "exact"; expected: string }
  | { mode: "unavailable"; expected: string };

/**
 * Whether a backend's response can attest which upstream model answered.
 *
 * The direct APIs return a `model` field, so an exact match is required. The OpenRouter
 * adapter uses the same envelope. The two gateways cannot: Cloudflare's envelope carries no
 * model field, and the Vercel gateway reports the ID that was requested rather than upstream
 * provenance. Those backends keep their alias pinned by the config schema instead.
 */
export function provenanceExpectation(backend: Backend): ProvenanceExpectation {
  switch (backend.type) {
    case "typesafe":
    case "openrouter":
      return { mode: "exact", expected: backend.model };
    case "cloudflare":
    case "vercel":
      return { mode: "unavailable", expected: backend.model };
  }
}

/**
 * Reject a classification the configured model cannot claim.
 *
 * A missing or different returned model is a protocol failure, not a routing label: the
 * caller treats it like any other classifier fault and continues on the current model.
 */
export function verifyProvenance(backend: Backend, classification: Classification): void {
  const expectation = provenanceExpectation(backend);

  if (expectation.mode === "unavailable") return;

  if (classification.returnedModel !== expectation.expected)
    throw new ClassifierError("model-mismatch");
}
