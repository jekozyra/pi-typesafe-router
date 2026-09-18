import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createClassifier, RUBRIC } from "../src/classifier.ts";
import { ClassifierError, type Backend, type ClassificationState } from "../src/types.ts";

const auth = { source: "env", variable: "UNUSED" } as const;

const backends: Backend[] = [
  { type: "typesafe", model: "jev-1.13.0", auth },
  {
    type: "cloudflare",
    model: "typesafe/jev",
    accountId: "account",
    gatewayId: "router-test",
    auth,
  },
  { type: "vercel", model: "typesafe-ai/jev", zeroDataRetention: true, auth },
  { type: "openrouter", model: "typesafe/jev-1.13", auth },
];

const state: ClassificationState = { current_request: "private prompt", recent_conversation: [] };

const options = () => ({ signal: new AbortController().signal, apiKey: "secret-key" });

const answer = () => ({
  type: "choice",
  choice: "standard",
  probabilities: { quick: 0.1, standard: 0.7, deep: 0.1, uncertain: 0.1 },
  confidence: 0.8,
});

const direct = () => ({
  model: "jev-1.13.0",
  answers: { task_class: answer() },
  usage: { input_tokens: 20, output_tokens: 4 },
});

const sdk = () => ({
  answers: { task_class: answer() },
  providerMetadata: { typesafe: { confidence: { task_class: 0.9 } } },
  usage: { inputTokens: 20, outputTokens: 4 },
});

type JsonFixture =
  | null
  | boolean
  | number
  | string
  | JsonFixture[]
  | { [key: string]: JsonFixture | undefined };

const json = (value: JsonFixture) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

const failure = (code: string, status?: number) => (error: Error) => {
  assert.ok(error instanceof ClassifierError);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  assert.ok(!String(error).includes("secret"));
  assert.ok(!String(error).includes("private prompt"));

  return true;
};

for (const backend of backends) {
  test(`${backend.type}: actual transport serialization and normalization`, async () => {
    let calls = 0;
    const opts = options();

    const classify = createClassifier(async (url, init) => {
      calls++;
      assert.equal(init?.redirect, "error");
      assert.equal(init?.signal, opts.signal);
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer secret-key");
      const body = z.json().parse(JSON.parse(String(init?.body)));

      if (backend.type !== "cloudflare") {
        assert.equal(headers.get("cf-aig-gateway-id"), null);
        assert.equal(headers.get("cf-aig-collect-log"), null);
      }

      if (backend.type === "openrouter") {
        assert.equal(String(url), "https://openrouter.ai/api/alpha/decisions");
        assert.deepEqual(body, { model: backend.model, state, questions: { task_class: RUBRIC } });
      } else if (backend.type === "typesafe") {
        assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
        assert.deepEqual(body, { model: backend.model, state, questions: { task_class: RUBRIC } });
      } else if (backend.type === "cloudflare") {
        assert.equal(String(url), "https://api.cloudflare.com/client/v4/accounts/account/ai/run");
        assert.equal(headers.get("cf-aig-gateway-id"), "router-test");
        assert.equal(headers.get("cf-aig-collect-log"), "false");
        assert.equal(headers.get("cf-aig-skip-cache"), "true");
        assert.equal(headers.get("cf-aig-max-attempts"), "1");
        assert.equal(headers.get("cf-aig-authorization"), null);
        assert.deepEqual(body, {
          model: backend.model,
          input: { state, questions: { task_class: RUBRIC } },
        });
      } else {
        assert.equal(String(url), "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
        assert.equal(headers.get("ai-model-id"), backend.model);
        assert.equal(headers.get("ai-gateway-auth-method"), "api-key");
        assert.deepEqual(body, {
          state,
          questions: { task_class: RUBRIC },
          providerOptions: { gateway: { zeroDataRetention: true } },
        });
      }

      return json(
        backend.type === "vercel"
          ? sdk()
          : backend.type === "cloudflare"
            ? { success: true, result: direct() }
            : { ...direct(), model: backend.model },
      );
    });

    const result = await classify(backend, state, opts);
    assert.equal(calls, 1);
    assert.equal(result.choice, "standard");
    assert.equal(result.confidence, backend.type === "vercel" ? 0.9 : 0.8);
    assert.equal(result.requestedModel, backend.model);
    assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 4 });
  });

  for (const status of [401, 422, 429, 529, 302]) {
    test(`${backend.type}: HTTP ${status} is safe and never retried`, async () => {
      let calls = 0;

      const classify = createClassifier(async (_url, init) => {
        calls++;
        assert.equal(init?.redirect, "error");

        return new Response("secret private prompt", {
          status,
          headers: { location: "https://other.invalid" },
        });
      });

      await assert.rejects(classify(backend, state, options()), failure("http", status));
      assert.equal(calls, 1);
    });
  }

  test(`${backend.type}: pre-abort, deadline reason, and missing credentials never call fetch`, async () => {
    const classify = createClassifier(async () => {
      assert.fail("unexpected fetch");
    });

    for (const reason of [
      new Error("secret"),
      new DOMException("private prompt", "TimeoutError"),
    ]) {
      const controller = new AbortController();
      controller.abort(reason);
      await assert.rejects(
        classify(backend, state, { apiKey: "secret", signal: controller.signal }),
        failure("cancelled"),
      );
    }

    await assert.rejects(
      classify(backend, state, { ...options(), apiKey: " " }),
      failure("credentials"),
    );
  });

  test(`${backend.type}: cancellation while reading response body`, async () => {
    const controller = new AbortController();

    const classify = createClassifier(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              queueMicrotask(() => controller.abort(new DOMException("deadline", "TimeoutError")));
            },
          }),
        ),
    );

    await assert.rejects(
      classify(backend, state, { apiKey: "secret", signal: controller.signal }),
      failure("cancelled"),
    );
  });

  test(`${backend.type}: network errors are sanitized`, async () => {
    const classify = createClassifier(async () => {
      throw new Error("secret private prompt");
    });

    await assert.rejects(classify(backend, state, options()), failure("network"));
  });

  for (const body of [
    "not json secret",
    "x".repeat(65537),
    '{"answers":{"task_class":{"type":"choice","choice":"quick","probabilities":{"quick":1e999,"standard":0,"deep":0,"uncertain":0},"confidence":1}}}',
  ]) {
    test(`${backend.type}: rejects invalid or oversized body (${body.length} bytes)`, async () => {
      const classify = createClassifier(async () => new Response(body));
      await assert.rejects(classify(backend, state, options()), failure("invalid-response"));
    });
  }

  for (const bad of [
    {},
    { ...answer(), type: "score" },
    { ...answer(), choice: "unknown" },
    { ...answer(), probabilities: { quick: 1 } },
    { ...answer(), probabilities: { quick: 0, standard: 0.7, deep: 0, uncertain: 0 } },
    { ...answer(), probabilities: { quick: 0.8, standard: 0.1, deep: 0.1, uncertain: 0 } },
    { ...answer(), probabilities: { quick: -0.1, standard: 0.9, deep: 0.1, uncertain: 0.1 } },
    { ...answer(), probabilities: { ...answer().probabilities, extra: 0 } },
  ]) {
    test(`${backend.type}: rejects malformed answer ${JSON.stringify(bad)}`, async () => {
      const classify = createClassifier(async () =>
        json({ ...(backend.type === "vercel" ? sdk() : direct()), answers: { task_class: bad } }),
      );

      await assert.rejects(classify(backend, state, options()), failure("invalid-response"));
    });
  }
}

test("Cloudflare explicitly accepts bare results and rejects failed/malformed envelopes", async () => {
  assert.equal(
    (await createClassifier(async () => json(direct()))(backends[1], state, options())).confidence,
    0.8,
  );

  for (const raw of [
    { success: false, result: direct() },
    { success: true },
    { result: direct() },
    { success: "true", result: direct() },
  ]) {
    await assert.rejects(
      createClassifier(async () => json(raw))(backends[1], state, options()),
      failure("invalid-response"),
    );
  }
});

test("Cloudflare unwraps a Completed run and preserves validated Jev results", async () => {
  const raw = {
    success: true,
    result: { state: "Completed", result: direct(), gatewayMetadata: { keySource: "fixture" } },
    errors: [],
    messages: [],
  };

  const result = await createClassifier(async () => json(raw))(backends[1], state, options());
  assert.equal(result.choice, "standard");
  assert.equal(result.confidence, 0.8);
  assert.equal(result.returnedModel, "jev-1.13.0");
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 4 });
});

test("Cloudflare rejects unsuccessful runs and malformed nested answers", async () => {
  for (const raw of [
    { success: false, result: { state: "Completed", result: direct() } },
    { result: { state: "Completed", result: direct() } },
    { success: true, result: { state: "Failed", result: direct() } },
    { success: true, result: { state: "Running", result: direct() } },
    { success: true, result: { state: "Completed" } },
    { success: true, result: { state: "Completed", result: { answers: {} } } },
    {
      success: true,
      result: {
        state: "Completed",
        result: { ...direct(), answers: { task_class: { ...answer(), confidence: 2 } } },
      },
    },
  ])
    await assert.rejects(
      createClassifier(async () => json(raw))(backends[1], state, options()),
      failure("invalid-response"),
    );
});

test("Cloudflare run markers cannot bypass validation through a legacy answer", async () => {
  for (const runState of ["queued", "running", "failed", "unknown", undefined]) {
    const raw = {
      success: true,
      result: { ...direct(), state: runState, result: direct() },
    };

    await assert.rejects(
      createClassifier(async () => json(raw))(backends[1], state, options()),
      failure("invalid-response"),
    );
  }
});

test("direct requires confidence; SDK only uses per-question metadata, never answer confidence", async () => {
  const noConfidence = {
    ...direct(),
    answers: { task_class: { ...answer(), confidence: undefined } },
  };

  await assert.rejects(
    createClassifier(async () => json(noConfidence))(backends[0], state, options()),
    failure("invalid-response"),
  );

  for (const providerMetadata of [undefined, {}, { typesafe: { confidence: {} } }]) {
    const result = await createClassifier(async () => json({ ...sdk(), providerMetadata }))(
      backends[2],
      state,
      options(),
    );

    assert.equal(result.confidence, undefined);
  }

  for (const confidence of [0.9, { task_class: -1 }, { task_class: "0.9" }, { task_class: null }]) {
    await assert.rejects(
      createClassifier(async () =>
        json({ ...sdk(), providerMetadata: { typesafe: { confidence } } }),
      )(backends[2], state, options()),
      failure("invalid-response"),
    );
  }
});

test("ties accepted; usage omitted rather than invented and unsafe provenance omitted", async () => {
  for (const usage of [
    undefined,
    {},
    { input_tokens: 1 },
    { input_tokens: -1, output_tokens: 0 },
    { input_tokens: 1.5, output_tokens: 0 },
  ]) {
    const raw = {
      ...direct(),
      usage,
      model: "secret\nmessage",
      answers: {
        task_class: {
          ...answer(),
          probabilities: { quick: 0.5, standard: 0.5, deep: 0, uncertain: 0 },
        },
      },
    };

    const result = await createClassifier(async () => json(raw))(backends[0], state, options());
    assert.equal(result.usage, undefined);
    assert.equal(result.returnedModel, undefined);
  }
});

test("size limit is on streamed bytes, not characters or declared length", async () => {
  let cancelled = false;

  const classify = createClassifier(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(33000));
            controller.enqueue(new Uint8Array(33000));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": "1" } },
      ),
  );

  await assert.rejects(classify(backends[0], state, options()), failure("invalid-response"));
  assert.equal(cancelled, true);
});

test("SDK warning text is not logged", async () => {
  const original = console.warn;
  let warnings = 0;
  console.warn = () => {
    warnings++;
  };

  try {
    await createClassifier(async () =>
      json({ ...sdk(), warnings: [{ type: "other", message: "secret private prompt" }] }),
    )(backends[2], state, options());
    assert.equal(warnings, 0);
  } finally {
    console.warn = original;
  }
});

test("schema boundaries reject non-object answers and confidence without coercion", async () => {
  for (const raw of [null, [], "secret", { answers: [] }, { answers: { task_class: [] } }]) {
    for (const backend of backends) {
      await assert.rejects(
        createClassifier(async () => json(raw))(backend, state, options()),
        failure("invalid-response"),
      );
    }
  }

  for (const confidence of [null, "0.8", -1, 1.01]) {
    for (const backend of backends.slice(0, 2)) {
      await assert.rejects(
        createClassifier(async () =>
          json({
            ...direct(),
            answers: { task_class: { ...answer(), confidence } },
          }),
        )(backend, state, options()),
        failure("invalid-response"),
      );
    }
  }
});

test("Cloudflare envelope markers cannot fall through to a valid bare answer", async () => {
  for (const markers of [
    { success: false },
    { success: null },
    { result: null },
    { success: true, result: [] },
  ]) {
    await assert.rejects(
      createClassifier(async () => json({ ...direct(), ...markers }))(
        backends[1],
        state,
        options(),
      ),
      failure("invalid-response"),
    );
  }
});

test("optional metadata is sanitized without rejecting a valid direct answer", async () => {
  for (const usage of [
    null,
    [],
    "secret",
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0 },
  ]) {
    for (const model of [null, [], 42, "x".repeat(201)]) {
      const result = await createClassifier(async () => json({ ...direct(), model, usage }))(
        backends[0],
        state,
        options(),
      );

      assert.equal(result.choice, "standard");
      assert.equal(Object.hasOwn(result, "usage"), false);
      assert.equal(Object.hasOwn(result, "returnedModel"), false);
    }
  }
});

test("gateway missing confidence stays absent and unsafe token counts are omitted", async () => {
  for (const usage of [
    {},
    { inputTokens: 1.5, outputTokens: 0 },
    { inputTokens: -1, outputTokens: 0 },
    { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 },
  ]) {
    const result = await createClassifier(async () =>
      json({
        ...sdk(),
        usage,
        providerMetadata: {},
        model: "upstream-model",
      }),
    )(backends[2], state, options());

    assert.equal(Object.hasOwn(result, "confidence"), false);
    assert.equal(Object.hasOwn(result, "usage"), false);
    assert.equal(Object.hasOwn(result, "returnedModel"), false);
  }
});
