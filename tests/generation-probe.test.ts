/**
 * Probe-outcome tests for `src/generation-probe.ts`.
 *
 * The probe is the router's only proof that a configured target can actually generate, and
 * it runs on someone's paid account. Every branch answers a different operational question —
 * is the model there, is the response really from it, did it return usable text — so each
 * one gets its own case. The registry is injected, so no environment, credentials, or
 * network are involved.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { installPiStubs, model, target } from "./harness.ts";

installPiStubs();

const { probeGeneration } = await import("../src/generation-probe.ts");

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { RouterContext } from "../src/host.ts";

type Registry = Pick<RouterContext["modelRegistry"], "find" | "complete">;

type CatalogEntry = NonNullable<ReturnType<RouterContext["modelRegistry"]["find"]>>;

type CompletionRequest = Parameters<Registry["complete"]>[1];

type CompletionOptions = Parameters<Registry["complete"]>[2];

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "OK" }],
    api: "test-api",
    provider: "provider-a",
    model: "model-a",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

interface ProbeOptions {
  entry?: CatalogEntry;
  find?: Registry["find"];
  complete?: Registry["complete"];
}

function probeRegistry(options: ProbeOptions = {}): Registry {
  const entry = options.entry ?? model("provider-a", "model-a");

  return {
    find:
      options.find ??
      ((provider, id) => (provider === entry.provider && id === entry.id ? entry : undefined)),
    complete: options.complete ?? (async () => assistant()),
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

const TARGET = target("provider-a", "model-a");

test("an accessible target that returns text passes", async () => {
  const result = await probeGeneration(probeRegistry(), TARGET, signal(), 1000);

  assert.equal(result.passed, true);
  assert.equal(result.reason, "ok");
  assert.equal(result.target, TARGET);
  assert.ok(Number.isInteger(result.milliseconds));
  assert.ok(result.milliseconds >= 0);
});

test("a length-limited answer still proves access", async () => {
  const result = await probeGeneration(
    probeRegistry({ complete: async () => assistant({ stopReason: "length" }) }),
    TARGET,
    signal(),
    1000,
  );

  assert.equal(result.passed, true);
});

test("a target missing from the catalogue is reported before any request", async () => {
  let called = false;

  const result = await probeGeneration(
    probeRegistry({
      find: () => undefined,
      complete: async () => {
        called = true;

        return assistant();
      },
    }),
    TARGET,
    signal(),
    1000,
  );

  assert.equal(result.passed, false);
  assert.equal(result.reason, "unknown-model");
  assert.equal(called, false);
});

test("a catalogue entry with a different identity is refused", async () => {
  const result = await probeGeneration(
    probeRegistry({ find: () => model("provider-other", "other-model") }),
    TARGET,
    signal(),
    1000,
  );

  assert.equal(result.passed, false);
  assert.equal(result.reason, "unknown-model");
});

test("a rejected request is reported without detail", async () => {
  const result = await probeGeneration(
    probeRegistry({
      complete: async () => {
        throw new Error("provider said: secret-token-abc");
      },
    }),
    TARGET,
    signal(),
    1000,
  );

  assert.equal(result.passed, false);
  assert.equal(result.reason, "request-failed");
});

test("a response from a different model is refused", async () => {
  const result = await probeGeneration(
    probeRegistry({ complete: async () => assistant({ model: "other-model" }) }),
    TARGET,
    signal(),
    1000,
  );

  assert.equal(result.reason, "identity-mismatch");
});

test("a tool call instead of text is refused", async () => {
  const result = await probeGeneration(
    probeRegistry({
      complete: async () =>
        assistant({ content: [{ type: "toolCall", id: "1", name: "bash", arguments: {} }] }),
    }),
    TARGET,
    signal(),
    1000,
  );

  assert.equal(result.reason, "tool-call");
});

test("an error stop reason is refused", async () => {
  const result = await probeGeneration(
    probeRegistry({ complete: async () => assistant({ stopReason: "error" }) }),
    TARGET,
    signal(),
    1000,
  );

  assert.equal(result.reason, "invalid-stop-reason");
});

test("empty text is not proof of access", async () => {
  const result = await probeGeneration(
    probeRegistry({
      complete: async () => assistant({ content: [{ type: "text", text: "   " }] }),
    }),
    TARGET,
    signal(),
    1000,
  );

  assert.equal(result.reason, "empty-text");
});

test("an error status is reported as an HTTP failure", async () => {
  const result = await probeGeneration(
    probeRegistry({
      complete: async (model, _request, options) => {
        void options?.onResponse?.({ status: 502, headers: {} }, model);

        return assistant({ stopReason: "error" });
      },
    }),
    TARGET,
    signal(),
    1000,
  );

  assert.equal(result.passed, false);
  assert.equal(result.reason, "http-502");
});

test("a stalled provider times out instead of hanging", async () => {
  const result = await probeGeneration(
    probeRegistry({ complete: () => new Promise<AssistantMessage>(() => {}) }),
    TARGET,
    signal(),
    20,
  );

  assert.equal(result.passed, false);
  assert.equal(result.reason, "timeout");
});

test("a cancelled caller aborts the probe", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    probeGeneration(probeRegistry(), TARGET, controller.signal, 1000),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "AbortError");

      return true;
    },
  );
});

test("the probe request is synthetic, bounded, and retry-free", async () => {
  let seenRequest: CompletionRequest | undefined;
  let seenOptions: CompletionOptions;

  await probeGeneration(
    probeRegistry({
      complete: async (_model, request, options) => {
        seenRequest = request;
        seenOptions = options;
        const headers = { "x-test": "1" };

        assert.deepEqual(options?.transformHeaders?.(headers), headers);

        return assistant();
      },
    }),
    TARGET,
    signal(),
    1000,
  );

  const request = seenRequest!;

  assert.match(request.systemPrompt ?? "", /synthetic connectivity probe/);
  assert.deepEqual(
    request.messages.map((message) => message.role),
    ["user"],
  );
  assert.deepEqual(request.tools, []);
  assert.equal(seenOptions?.maxTokens, 128);
  assert.equal(seenOptions?.maxRetries, 0);
  assert.equal(seenOptions?.transport, "sse");
});
