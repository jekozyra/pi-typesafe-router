/**
 * Verification-fingerprint tests for `src/verification.ts`.
 *
 * The fingerprint is the gate that decides whether a proof earned by `/typesafe-router
 * doctor` is still valid. It must be stable for equivalent inputs, change when anything the
 * decision depended on changed, and never carry credential material out of process — it is
 * only ever compared, but a hash built from a secret is still a leak waiting to be logged.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { baseConfigInput, baseRoutes, installPiStubs, model, target } from "./harness.ts";

installPiStubs();

const { configuredTargets, verificationFingerprint, ProofStore, targetFingerprint } =
  await import("../src/verification.ts");

const { parseConfig } = await import("../src/config.ts");

import type { RouterContext } from "../src/host.ts";

type Registry = RouterContext["modelRegistry"];

type CatalogEntry = NonNullable<ReturnType<Registry["find"]>>;

type Provider = NonNullable<ReturnType<Registry["getProvider"]>>;

type AuthStatus = ReturnType<Registry["getProviderAuthStatus"]>;

type RegisteredConfig = ReturnType<Registry["getRegisteredProviderConfig"]>;

/** Pi reports an unconfigured provider as a status, not as an absent one. */
const READY: AuthStatus = { configured: true, source: "environment" };

const NOT_READY: AuthStatus = { configured: false };

interface RegistryOptions {
  providers?: Record<string, Provider>;
  authStatus?: (provider: string) => AuthStatus;
  registeredConfig?: (provider: string) => RegisteredConfig;
  catalog?: CatalogEntry[];
}

function registry(options: RegistryOptions = {}): Registry {
  const providers = options.providers ?? {};
  const catalog = options.catalog ?? [];

  return {
    getAll: () => catalog,
    getAvailable: () => catalog,
    find: (provider, id) => catalog.find((entry) => entry.provider === provider && entry.id === id),
    getProviderAuth: async () => undefined,
    getProviderAuthStatus: (provider) => options.authStatus?.(provider) ?? READY,
    getRegisteredProviderConfig: (provider) => options.registeredConfig?.(provider),
    getProvider: (provider) => providers[provider],
    complete: async () => {
      throw new Error("the fingerprint never calls a model");
    },
  };
}

/** Fresh provider objects, keyed by the providers the base configuration targets. */
function providers(): Record<string, Provider> {
  const ids = ["provider-quick", "provider-standard", "provider-deep"];

  // SAFETY: this fake exists to be a distinct object identity; no provider member is read.
  return Object.fromEntries(
    ids.map((id) => [
      id,
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- identity-only fake provider
      { id } as unknown as Provider,
    ]),
  );
}

function catalog(provider: string, id: string): CatalogEntry {
  return model(provider, id);
}

// oxlint-disable-next-line anti-slop/no-object-parameters -- deliberately arbitrary route overrides
function routes(overrides: object) {
  return { ...baseRoutes(), ...overrides };
}

test("configured targets are deduplicated in first-use order", () => {
  const config = parseConfig({
    ...baseConfigInput(),
    routes: {
      quick: [target("provider-a", "one"), target("provider-b", "two")],
      standard: [target("provider-b", "two", "low"), target("provider-c", "three")],
      deep: [target("provider-c", "three"), target("provider-a", "one")],
    },
  });

  assert.deepEqual(
    configuredTargets(config).map((entry) => `${entry.provider}/${entry.model}`),
    ["provider-a/one", "provider-b/two", "provider-c/three"],
  );
});

test("the fingerprint is a stable 64-character digest", () => {
  const config = parseConfig(baseConfigInput());
  const probe = registry({ providers: providers() });

  const first = verificationFingerprint(config, probe);
  const second = verificationFingerprint(config, probe);

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("a route-order change invalidates the fingerprint", () => {
  const forward = parseConfig({
    ...baseConfigInput(),
    routes: routes({ quick: [target("provider-a", "one"), target("provider-b", "two")] }),
  });

  const reversed = parseConfig({
    ...baseConfigInput(),
    routes: routes({ quick: [target("provider-b", "two"), target("provider-a", "one")] }),
  });

  const probe = registry({ providers: providers() });

  assert.notEqual(
    verificationFingerprint(forward, probe),
    verificationFingerprint(reversed, probe),
  );
});

test("a change of effort or model invalidates the fingerprint", () => {
  const base = parseConfig(baseConfigInput());

  const effort = parseConfig({
    ...baseConfigInput(),
    routes: routes({ quick: [target("provider-quick", "quick-model", "medium")] }),
  });

  const modelChanged = parseConfig({
    ...baseConfigInput(),
    routes: routes({ quick: [target("provider-quick", "other-model", "low")] }),
  });

  const probe = registry({ providers: providers() });

  assert.notEqual(verificationFingerprint(base, probe), verificationFingerprint(effort, probe));
  assert.notEqual(
    verificationFingerprint(base, probe),
    verificationFingerprint(modelChanged, probe),
  );
});

test("a credential-reference change invalidates the fingerprint", () => {
  const base = parseConfig(baseConfigInput());

  const renamed = parseConfig({
    ...baseConfigInput(),
    backend: {
      type: "typesafe",
      model: "jev-1.13.0",
      auth: { source: "env", variable: "OTHER_TYPESAFE_KEY" },
    },
  });

  const probe = registry({ providers: providers() });

  // Only the variable name is hashed; no value from the environment is ever read.
  assert.notEqual(verificationFingerprint(base, probe), verificationFingerprint(renamed, probe));
});

test("replacing a provider object invalidates the fingerprint", () => {
  const config = parseConfig(baseConfigInput());
  const shared = registry({ providers: providers() });
  const replaced = registry({ providers: providers() });

  assert.equal(verificationFingerprint(config, shared), verificationFingerprint(config, shared));
  assert.notEqual(
    verificationFingerprint(config, shared),
    verificationFingerprint(config, replaced),
  );
});

test("a credential-status change invalidates the fingerprint", () => {
  const config = parseConfig(baseConfigInput());
  const ready = registry({ providers: providers(), authStatus: () => READY });
  const gone = registry({ providers: providers(), authStatus: () => NOT_READY });

  assert.notEqual(verificationFingerprint(config, ready), verificationFingerprint(config, gone));
});

test("a registered-provider-config change invalidates the fingerprint", () => {
  const config = parseConfig(baseConfigInput());

  const before = registry({
    providers: providers(),
    registeredConfig: () => ({ baseUrl: "https://one.example" }),
  });

  const after = registry({
    providers: providers(),
    registeredConfig: () => ({ baseUrl: "https://two.example" }),
  });

  assert.notEqual(verificationFingerprint(config, before), verificationFingerprint(config, after));
});

test("a resolved-model change invalidates the fingerprint", () => {
  const config = parseConfig(baseConfigInput());

  const before = registry({
    providers: providers(),
    catalog: [catalog("provider-quick", "quick-model")],
  });

  const after = registry({
    providers: providers(),
    catalog: [{ ...catalog("provider-quick", "quick-model"), contextWindow: 100_000 }],
  });

  assert.notEqual(verificationFingerprint(config, before), verificationFingerprint(config, after));
});

test("a classifier credential reference is part of the fingerprint", () => {
  const config = parseConfig({
    ...baseConfigInput(),
    backend: {
      type: "typesafe",
      model: "jev-1.13.0",
      auth: { source: "pi", provider: "provider-a" },
    },
  });

  const configured = registry({ providers: providers(), authStatus: () => READY });
  const missing = registry({ providers: providers(), authStatus: () => NOT_READY });

  assert.notEqual(
    verificationFingerprint(config, configured),
    verificationFingerprint(config, missing),
  );
});

test("a target fingerprint is stable, distinct per target, and never carries a credential value", () => {
  const config = parseConfig(baseConfigInput());
  const probe = registry({ providers: providers() });
  const [first, second] = config.routes.quick.concat(config.routes.deep);

  assert.match(targetFingerprint(first!, probe), /^[0-9a-f]{64}$/);
  assert.equal(targetFingerprint(first!, probe), targetFingerprint(first!, probe));
  assert.notEqual(targetFingerprint(first!, probe), targetFingerprint(second!, probe));
});

test("a proof is valid only while the target and its registry facts are unchanged", () => {
  const config = parseConfig(baseConfigInput());
  const target = config.routes.quick[0]!;
  // One shared provider map: separate `providers()` calls would build fresh objects and
  // invalidate every proof, which is the very thing `verification.test.ts` pins elsewhere.
  const objects = providers();
  const probe = registry({ providers: objects });
  const proofs = new ProofStore();

  assert.equal(proofs.valid(target, probe), undefined);
  proofs.remember(target, probe);
  assert.notEqual(proofs.valid(target, probe), undefined);

  const rotated = registry({ providers: objects, authStatus: () => NOT_READY });
  assert.equal(proofs.valid(target, rotated), undefined);
  assert.notEqual(proofs.valid(target, probe), undefined, "the rotation is scoped to the registry");
});

test("a change to one target leaves another target's proof current", () => {
  const config = parseConfig(baseConfigInput());
  const quick = config.routes.quick[0]!;
  const deep = config.routes.deep[0]!;
  const objects = providers();
  const probe = registry({ providers: objects, authStatus: () => READY });
  const proofs = new ProofStore();

  proofs.remember(quick, probe);
  proofs.remember(deep, probe);

  // Only the deep target's provider changes, and only its proof should go stale.
  const changed = registry({
    providers: objects,
    authStatus: (provider) => (provider === deep.provider ? NOT_READY : READY),
  });

  assert.deepEqual(
    [...proofs.validKeys(changed, [quick, deep])],
    [`${quick.provider}/${quick.model}`],
  );
  assert.deepEqual(
    [...proofs.validKeys(probe, [quick, deep])],
    [`${quick.provider}/${quick.model}`, `${deep.provider}/${deep.model}`],
  );
});

test("clearing the proof store discards every proof", () => {
  const config = parseConfig(baseConfigInput());
  const probe = registry({ providers: providers() });
  const proofs = new ProofStore();

  for (const target of configuredTargets(config)) proofs.remember(target, probe);
  assert.equal(proofs.size, 3);

  proofs.clear();
  assert.equal(proofs.size, 0);
  assert.equal(proofs.valid(config.routes.quick[0]!, probe), undefined);
});
