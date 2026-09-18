import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { it } from "node:test";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ModelsApiStreamOptions,
} from "@earendil-works/pi-ai";
import type { RouterContext } from "../src/host.ts";
import { probeGeneration } from "../src/generation-probe.ts";

const target = { provider: "fixture", model: "exact-model" };

const model: Model<Api> = {
  provider: target.provider,
  id: target.model,
  name: "Fixture",
  api: "openai-completions",
  baseUrl: "https://fixture.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 4096,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const response = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  provider: target.provider,
  model: target.model,
  api: model.api,
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
  ...overrides,
});

function facade(work: () => Promise<AssistantMessage>, found: Model<Api> | undefined = model) {
  const calls: Array<{
    model: Model<Api>;
    context: Context;
    options?: ModelsApiStreamOptions<Api>;
  }> = [];

  const lookups: string[][] = [];

  const registry: Pick<RouterContext["modelRegistry"], "find" | "complete"> = {
    find(provider, id) {
      lookups.push([provider, id]);

      return found;
    },
    complete(selected, context, options) {
      calls.push({ model: selected, context, options });

      return work();
    },
  };

  return { registry, calls, lookups };
}

function deferred() {
  let resolve: (message: AssistantMessage) => void = () => {};

  let reject: (error: Error) => void = () => {};

  const promise = new Promise<AssistantMessage>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });

  return { promise, resolve, reject };
}

it("sends exactly one bounded synthetic request through the host facade", async () => {
  const fixture = facade(async () => response());
  const controller = new AbortController();
  const before = Date.now();
  const result = await probeGeneration(fixture.registry, target, controller.signal, 1000);
  assert.equal(result.passed, true);
  assert.equal(result.reason, "ok");
  assert.deepEqual(result.target, target);
  assert.ok(result.milliseconds >= 0);
  assert.deepEqual(fixture.lookups, [[target.provider, target.model]]);
  assert.equal(fixture.calls.length, 1);
  const call = fixture.calls[0]!;
  assert.equal(call.model, model);
  assert.match(call.context.systemPrompt!, /synthetic connectivity/);
  assert.deepEqual(Object.keys(call.context).sort(), ["messages", "systemPrompt", "tools"]);
  assert.deepEqual(call.context.tools, []);
  assert.equal(call.context.messages.length, 1);
  const message = call.context.messages[0]!;
  assert.deepEqual(message, {
    role: "user",
    content: "Reply with OK.",
    timestamp: message.timestamp,
  });
  assert.ok(message.timestamp >= before && message.timestamp <= Date.now());
  assert.ok(call.options?.signal instanceof AbortSignal);
  assert.notEqual(call.options.signal, controller.signal);
  assert.deepEqual(call.options, {
    signal: call.options.signal,
    maxTokens: 128,
    maxRetries: 0,
    transport: "sse",
    onResponse: call.options.onResponse,
    transformHeaders: call.options.transformHeaders,
  });
  assert.ok(call.options.onResponse);
});

it("reports only safe HTTP status for provider rejection", async () => {
  for (const throws of [false, true]) {
    const fixture = facade(async () => response());
    fixture.registry.complete = async (_selected, _context, options) => {
      await options?.onResponse?.({ status: 403, headers: { authorization: "SECRET" } }, model);

      if (throws) throw new Error("SECRET credential error");

      return response({ stopReason: "error", errorMessage: "SECRET credential error" });
    };

    const result = await probeGeneration(
      fixture.registry,
      target,
      new AbortController().signal,
      1000,
    );

    assert.equal(result.passed, false);
    assert.equal(result.reason, "http-403");
    assert.ok(!JSON.stringify(result).includes("SECRET"));
  }
});

it("rejects unknown or inexact lookup without generation", async () => {
  for (const found of [null, { ...model, id: "other" }, { ...model, provider: "other" }]) {
    const fixture = facade(async () => response());
    fixture.registry.find = () => found ?? undefined;

    const result = await probeGeneration(
      fixture.registry,
      target,
      new AbortController().signal,
      1000,
    );

    assert.equal(result.reason, "unknown-model");
    assert.equal(result.passed, false);
    assert.equal(fixture.calls.length, 0);
  }
});

it("accepts arbitrary nonempty text and length stops, not prompt compliance", async () => {
  const fixture = facade(async () =>
    response({ stopReason: "length", content: [{ type: "text", text: "I refuse. SECRET" }] }),
  );

  const result = await probeGeneration(
    fixture.registry,
    target,
    new AbortController().signal,
    1000,
  );

  assert.equal(result.passed, true);
  assert.ok(!JSON.stringify(result).includes("SECRET"));
});

it("requires exact identity, valid stop, and visible text without tool calls", async () => {
  const cases: Array<[Partial<AssistantMessage>, string]> = [
    [{ provider: "other" }, "identity-mismatch"],
    [{ model: "other" }, "identity-mismatch"],
    [{ stopReason: "error", errorMessage: "SECRET" }, "invalid-stop-reason"],
    [{ stopReason: "aborted" }, "invalid-stop-reason"],
    [{ stopReason: "toolUse" }, "invalid-stop-reason"],
    [{ content: [] }, "empty-text"],
    [{ content: [{ type: "text", text: "  \n" }] }, "empty-text"],
    [{ content: [{ type: "thinking", thinking: "SECRET" }] }, "empty-text"],
    [
      {
        content: [
          { type: "text", text: "OK" },
          { type: "toolCall", id: "1", name: "SECRET", arguments: {} },
        ],
      },
      "tool-call",
    ],
  ];

  for (const [overrides, reason] of cases) {
    const fixture = facade(async () => response(overrides));

    const result = await probeGeneration(
      fixture.registry,
      target,
      new AbortController().signal,
      1000,
    );

    assert.equal(result.passed, false);
    assert.equal(result.reason, reason);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
  }
});

it("rejects non-assistant role at the provider boundary", async () => {
  const invalid = response();
  // Simulate a broken runtime adapter while keeping the facade's real public signature.
  Object.assign(invalid, { role: "user" });
  const fixture = facade(async () => invalid);

  const result = await probeGeneration(
    fixture.registry,
    target,
    new AbortController().signal,
    1000,
  );

  assert.equal(result.reason, "invalid-role");
});

it("sanitizes thrown errors and never retries", async () => {
  const fixture = facade(async () => {
    throw new Error("HTTP 401 SECRET key and raw body");
  });

  const result = await probeGeneration(
    fixture.registry,
    target,
    new AbortController().signal,
    1000,
  );

  assert.equal(result.reason, "request-failed");
  assert.equal(result.passed, false);
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.equal(fixture.calls.length, 1);
});

it("times out authentication/request work even when cancellation is ignored", async () => {
  const pending = deferred();
  const fixture = facade(() => pending.promise);
  const result = await probeGeneration(fixture.registry, target, new AbortController().signal, 5);
  assert.equal(result.reason, "timeout");
  assert.equal(result.passed, false);
  assert.equal(fixture.calls[0]!.options!.signal!.aborted, true);
  pending.resolve(response());
  await nextTurn();
  assert.equal(result.reason, "timeout");
  assert.equal(fixture.calls.length, 1);
});

it("caller abort cancels in-flight work and safely handles late rejection", async () => {
  const pending = deferred();
  const fixture = facade(() => pending.promise);
  const controller = new AbortController();
  const work = probeGeneration(fixture.registry, target, controller.signal, 1000);
  controller.abort(new Error("SECRET"));
  await assert.rejects(work, { name: "AbortError", message: "Generation probe cancelled" });
  assert.equal(fixture.calls[0]!.options!.signal!.aborted, true);
  pending.reject(new Error("late SECRET"));
  await nextTurn();
  assert.equal(fixture.calls.length, 1);
});

it("already cancelled probes never look up or request a model", async () => {
  const fixture = facade(async () => response());
  await assert.rejects(probeGeneration(fixture.registry, target, AbortSignal.abort(), 1000), {
    name: "AbortError",
  });
  assert.equal(fixture.lookups.length, 0);
  assert.equal(fixture.calls.length, 0);
});
