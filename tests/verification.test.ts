import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type AuthResult,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "../src/config.ts";
import { probeGeneration } from "../src/generation-probe.ts";
import { verificationFingerprint } from "../src/verification.ts";

const target = { provider: "verification-generation-fixture", model: "fixture-model" };

const classifier = "verification-classifier-fixture";

const firstKey = "fake-literal-credential-first";

const secondKey = "fake-literal-credential-second";

const config = parseConfig({
  backend: { type: "typesafe", auth: { source: "pi", provider: classifier } },
  routes: { quick: [target], standard: [target], deep: [target] },
});

function providerConfig(apiKey = firstKey): ProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: "https://verification.invalid/v1",
    apiKey,
    models: [
      {
        id: target.model,
        name: "Fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 1024,
      },
    ],
  };
}

/** No real profile, credential store, environment key, or network is needed. */
async function fixture(t: TestContext, diskConfig?: ProviderConfig) {
  const root = await mkdtemp(join(tmpdir(), "pi-router-verification-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const http = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Verification tests forbid network access");
  });

  t.after(() => assert.equal(http.mock.callCount(), 0));
  const modelsPath = join(root, "models.json");

  async function writeModels(value: ProviderConfig) {
    await writeFile(modelsPath, JSON.stringify({ providers: { [target.provider]: value } }));
  }

  if (diskConfig) await writeModels(diskConfig);

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: diskConfig ? modelsPath : null,
    modelsStorePath: join(root, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  const registry = new ModelRegistry(runtime);

  return { runtime, registry, writeModels };
}

function assertOpaque(fingerprint: string) {
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);

  for (const secret of [firstKey, secondKey, "fake-header-first", "fake-header-second"])
    assert.equal(fingerprint.includes(secret), false);
}

describe("verification against the actual Pi runtime", { concurrency: false }, () => {
  it("does not invalidate routing proof when only footer visibility changes", async (t) => {
    const { registry } = await fixture(t);
    registry.registerProvider(target.provider, providerConfig());
    registry.registerProvider(classifier, providerConfig());
    const hidden = { ...config, showFooterStatus: false };
    assert.equal(
      verificationFingerprint(hidden, registry),
      verificationFingerprint(config, registry),
    );
  });

  for (const changed of ["credential", "header"] as const) {
    it(`invalidates a models.json ${changed} change with identical model and auth status`, async (t) => {
      const initial = { ...providerConfig(), headers: { "X-Fixture": "fake-header-first" } };
      const { registry, writeModels } = await fixture(t, initial);
      const model = registry.find(target.provider, target.model);
      assert.ok(model);
      const provider = registry.getProvider(target.provider);
      assert.ok(provider);
      const status = registry.getProviderAuthStatus(target.provider);
      assert.equal(status.configured, true);
      assert.equal(registry.getRegisteredProviderConfig(target.provider), undefined);
      const before = verificationFingerprint(config, registry);
      assert.equal(verificationFingerprint(config, registry), before, "unchanged reads are stable");
      await writeModels(
        changed === "credential"
          ? { ...initial, apiKey: secondKey }
          : { ...initial, headers: { "X-Fixture": "fake-header-second" } },
      );
      await registry.refresh({ allowNetwork: false, providers: [target.provider] });
      assert.equal(registry.getError(), undefined);
      assert.deepEqual(registry.find(target.provider, target.model), model);
      assert.deepEqual(registry.getProviderAuthStatus(target.provider), status);
      assert.equal(registry.getRegisteredProviderConfig(target.provider), undefined);
      assert.notEqual(registry.getProvider(target.provider), provider);
      const after = verificationFingerprint(config, registry);
      assert.notEqual(after, before);
      assert.equal(verificationFingerprint(config, registry), after);
      assertOpaque(before);
      assertOpaque(after);
    });
  }

  it("includes classifier-only Pi credentials, not just generation providers", async (t) => {
    const { registry } = await fixture(t);
    registry.registerProvider(target.provider, providerConfig());
    registry.registerProvider(classifier, providerConfig());
    const generation = registry.getProvider(target.provider);
    const model = registry.find(target.provider, target.model);
    const status = registry.getProviderAuthStatus(classifier);
    const before = verificationFingerprint(config, registry);
    registry.registerProvider(classifier, providerConfig(secondKey));
    assert.equal(registry.getProvider(target.provider), generation);
    assert.deepEqual(registry.find(target.provider, target.model), model);
    assert.deepEqual(registry.getProviderAuthStatus(classifier), status);
    const after = verificationFingerprint(config, registry);
    assert.notEqual(after, before);
    assertOpaque(before);
    assertOpaque(after);
  });

  it("invalidates native provider replacement even when visible metadata stays equal", async (t) => {
    const { registry } = await fixture(t);
    registry.registerProvider(target.provider, providerConfig());
    const original = registry.getProvider(target.provider);
    assert.ok(original);
    registry.registerProvider({ ...original });
    const model = registry.find(target.provider, target.model);
    const status = registry.getProviderAuthStatus(target.provider);
    const extension = registry.getRegisteredProviderConfig(target.provider);
    const provider = registry.getProvider(target.provider);
    const before = verificationFingerprint(config, registry);
    registry.registerProvider({ ...original });
    assert.notEqual(registry.getProvider(target.provider), provider);
    assert.deepEqual(registry.find(target.provider, target.model), model);
    assert.deepEqual(registry.getProviderAuthStatus(target.provider), status);
    assert.deepEqual(registry.getRegisteredProviderConfig(target.provider), extension);
    assert.notEqual(verificationFingerprint(config, registry), before);
  });

  for (const cancellation of ["abort", "timeout"] as const) {
    it(`does not start transport after ${cancellation} during actual Pi authentication`, async (t) => {
      const { registry, runtime } = await fixture(t);
      let transports = 0;
      registry.registerProvider(target.provider, {
        ...providerConfig(),
        streamSimple(model) {
          transports++;
          const stream = createAssistantMessageEventStream();

          const message: AssistantMessage = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [{ type: "text", text: "OK" }],
            stopReason: "stop",
            timestamp: 1,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };

          stream.push({ type: "done", reason: "stop", message });
          stream.end();

          return stream;
        },
      });
      // Positive control: raw registry.complete reaches extension streamSimple via
      // Pi's composed provider.stream, rather than a mocked registry implementation.
      assert.equal(
        (await probeGeneration(registry, target, new AbortController().signal, 1000)).passed,
        true,
      );
      assert.equal(transports, 1);
      transports = 0;
      let releaseAuth!: (auth: AuthResult) => void;

      const delayedAuth = new Promise<AuthResult>((resolve) => {
        releaseAuth = resolve;
      });

      let enteredAuth!: () => void;

      const authStarted = new Promise<void>((resolve) => {
        enteredAuth = resolve;
      });

      t.mock.method(runtime, "getAuth", () => {
        enteredAuth();

        return delayedAuth;
      });
      // Observe completion of the real underlying operation, not just the probe's
      // abort race, so a late transport invocation cannot escape the assertion.
      const realComplete = registry.complete.bind(registry);
      let completeSettled!: () => void;

      const settled = new Promise<void>((resolve) => {
        completeSettled = resolve;
      });

      t.mock.method(registry, "complete", (...args: Parameters<typeof registry.complete>) => {
        const request = realComplete(...args);
        void request.then(completeSettled, completeSettled);

        return request;
      });
      const controller = new AbortController();

      const probing = probeGeneration(
        registry,
        target,
        controller.signal,
        cancellation === "timeout" ? 25 : 1000,
      );

      const outcome =
        cancellation === "abort"
          ? assert.rejects(probing, { name: "AbortError" })
          : probing.then((result) => {
              assert.equal(result.passed, false);
              assert.equal(result.reason, "timeout");
            });

      await authStarted;

      if (cancellation === "abort") controller.abort();
      await outcome;
      assert.equal(transports, 0);
      releaseAuth({ auth: { apiKey: firstKey }, source: "synthetic delayed auth" });
      await settled;
      assert.equal(transports, 0, "late auth must not start provider transport");
    });
  }
});
