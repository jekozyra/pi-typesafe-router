/**
 * Transport and validation tests for `src/classifier.ts`.
 *
 * The classifier is the only component that talks to a network, and `createClassifier`
 * takes its fetch implementation as an argument, so the whole protocol path — URL shape,
 * headers, bounded body, envelope variants, probability validation — is reachable with no
 * credentials and no socket. The Vercel path goes through the vendored AI SDK gateway and is
 * therefore not covered here; that is recorded in the report, not pretended away.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { installPiStubs } from "./harness.ts";

installPiStubs();

const { createClassifier, gatewayResponseSchema } = await import("../src/classifier.ts");

const { ClassifierError } = await import("../src/types.ts");

const { POLICY } = await import("../src/policy.ts");

import type { Backend, ClassificationState, ClassifyOptions } from "../src/types.ts";
import type { RoutingPolicy } from "../src/policy.ts";

const STATE: ClassificationState = {
  current_request: "Explain this function",
  recent_conversation: [],
};

const TYPESAFE: Backend = {
  type: "typesafe",
  model: "jev-1.13.0",
  auth: { source: "env", variable: "TYPESAFE_API_KEY" },
};

/** One TypeSafe answer envelope, matching what the classifier's schema must accept. */
interface DirectAnswer {
  type: "choice";
  choice: string;
  probabilities: { quick: number; standard: number; deep: number; uncertain: number };
  confidence: number;
}

interface DirectBody {
  // A response is keyed by whichever question the request named, not by a literal.
  answers: Record<string, DirectAnswer>;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

/** The Cloudflare AI Gateway wrapper some tests return instead of a bare answer. */
interface CloudflareEnvelope {
  success: boolean;
  result: DirectBody;
}

/** The Cloudflare run envelope, which nests the answer under a `state` marker. */
interface CloudflareResultEnvelope {
  success: boolean;
  result: { state: string; result: DirectBody };
}

type JsonBody = DirectBody | CloudflareEnvelope | CloudflareResultEnvelope;

function directBody(overrides: Partial<DirectBody> = {}): DirectBody {
  return {
    answers: {
      task_class: {
        type: "choice",
        choice: "quick",
        probabilities: { quick: 0.7, standard: 0.1, deep: 0.1, uncertain: 0.1 },
        confidence: 0.7,
      },
    },
    model: "jev-1.13.0",
    usage: { input_tokens: 42, output_tokens: 3 },
    ...overrides,
  };
}

/** The same envelope, keyed by a policy-selected question rather than `task_class`. */
function externalBody(question: string): DirectBody {
  return {
    answers: {
      [question]: {
        type: "choice",
        choice: "quick",
        probabilities: { quick: 0.7, standard: 0.1, deep: 0.1, uncertain: 0.1 },
        confidence: 0.7,
      },
    },
    model: "jev-1.13.0",
    usage: { input_tokens: 42, output_tokens: 3 },
  };
}

function jsonResponse(body: JsonBody, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

interface Recorder {
  calls: Array<{ url: string; init: RequestInit }>;
  fetch: typeof fetch;
}

function recorder(next: () => Response): Recorder {
  const calls: Recorder["calls"] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });

    return next();
  };

  return { calls, fetch: fetchImpl };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

/** Every call in this suite sends the bundled rubric; policyPath is covered elsewhere. */
function options(signal: AbortSignal, apiKey: string): ClassifyOptions {
  return { signal, apiKey, policy: POLICY };
}

/** A policy whose question key is not the bundled `task_class`. */
const EXTERNAL: RoutingPolicy = {
  ...POLICY,
  id: "external-rubric",
  question: "external_class",
  instructions: "Classify the request under the external rubric.",
};

function externalOptions(signal: AbortSignal, apiKey: string): ClassifyOptions {
  return { signal, apiKey, policy: EXTERNAL };
}

async function expectClassifierError(
  promise: Promise<unknown>,
  code: string,
  status?: number,
): Promise<void> {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ClassifierError, `expected ClassifierError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);

    return true;
  });
}

test("a classifier failure keeps its name, code, status, and message", () => {
  const unauthorized = new ClassifierError("http", 403);

  assert.ok(unauthorized instanceof Error);
  assert.equal(unauthorized.name, "ClassifierError");
  assert.equal(unauthorized.message, "Classifier http (HTTP 403)");
  assert.equal(unauthorized.code, "http");
  assert.equal(unauthorized.status, 403);

  const bare = new ClassifierError("credentials");

  assert.equal(bare.message, "Classifier credentials");
  assert.equal(bare.status, undefined);
  assert.equal(bare.code, "credentials");
});

test("classifies a request over the direct TypeSafe API", async () => {
  const transport = recorder(() => jsonResponse(directBody()));
  const classify = createClassifier(transport.fetch);
  const result = await classify(TYPESAFE, STATE, options(signal(), "test-key"));

  assert.equal(result.choice, "quick");
  assert.equal(result.confidence, 0.7);
  assert.equal(result.returnedModel, "jev-1.13.0");
  assert.deepEqual(result.probabilities, { quick: 0.7, standard: 0.1, deep: 0.1, uncertain: 0.1 });
  assert.deepEqual(result.usage, { inputTokens: 42, outputTokens: 3 });
  assert.equal(result.requestedModel, "jev-1.13.0");
});

test("sends the pinned model, the projected state, and one frozen rubric", async () => {
  const transport = recorder(() => jsonResponse(directBody()));
  const classify = createClassifier(transport.fetch);
  await classify(TYPESAFE, STATE, options(signal(), "test-key"));

  const call = transport.calls[0];
  assert.equal(call?.url, "https://api.typesafe.ai/v1/systemone");

  // SAFETY: the request body was serialized by this repository's own classifier above.
  const payload = JSON.parse(String(call?.init.body)) as {
    model: string;
    state: unknown;
    questions: {
      task_class: { type: string; instructions: string; criteria: Record<string, string> };
    };
  };

  assert.equal(payload.model, "jev-1.13.0");
  assert.deepEqual(payload.state, STATE);
  assert.equal(payload.questions.task_class.type, "choice");
  assert.deepEqual(Object.keys(payload.questions.task_class.criteria).sort(), [
    "deep",
    "quick",
    "standard",
    "uncertain",
  ]);
  assert.match(payload.questions.task_class.instructions, /untrusted data/);
});

test("keys the request and the answer by the configured policy's question", async () => {
  const transport = recorder(() => jsonResponse(externalBody("external_class")));
  const classify = createClassifier(transport.fetch);
  const result = await classify(TYPESAFE, STATE, externalOptions(signal(), "k"));

  // SAFETY: the request body was serialized by this repository's own classifier above.
  const payload = JSON.parse(String(transport.calls[0]?.init.body)) as {
    questions: Record<string, { instructions: string }>;
  };

  assert.equal(result.choice, "quick");
  assert.deepEqual(Object.keys(payload.questions), ["external_class"]);
  assert.equal(payload.questions.external_class?.instructions, EXTERNAL.instructions);
});

// A hard-coded `task_class` normalizer would read an undefined answer here and fail every
// configured policy that names its question something else.
test("rejects an answer returned under a different question name", async () => {
  const transport = recorder(() => jsonResponse(directBody()));
  const classify = createClassifier(transport.fetch);

  await expectClassifierError(
    classify(TYPESAFE, STATE, externalOptions(signal(), "k")),
    "invalid-response",
  );
});

// A question key is operator-supplied text, so it may collide with an `Object.prototype` name.
test("a prototype-named question key is never satisfied by an inherited value", async () => {
  const hostile: RoutingPolicy = { ...POLICY, id: "hostile-rubric", question: "constructor" };

  const answers: Record<string, DirectAnswer> = {};

  const transport = recorder(() =>
    jsonResponse({ answers, model: "jev-1.13.0", usage: { input_tokens: 0, output_tokens: 0 } }),
  );

  const classify = createClassifier(transport.fetch);

  await expectClassifierError(
    classify(TYPESAFE, STATE, { signal: signal(), apiKey: "k", policy: hostile }),
    "invalid-response",
  );
});

test("keys the Cloudflare envelope by the configured policy's question", async () => {
  const backend: Backend = {
    type: "cloudflare",
    model: "typesafe/jev",
    accountId: "a".repeat(32),
    gatewayId: "gateway",
    auth: { source: "env", variable: "CLOUDFLARE_API_TOKEN" },
  };

  const transport = recorder(() =>
    jsonResponse({
      success: true,
      result: { state: "Completed", result: externalBody("external_class") },
    }),
  );

  const result = await createClassifier(transport.fetch)(
    backend,
    STATE,
    externalOptions(signal(), "k"),
  );

  assert.equal(result.choice, "quick");
});

// The AI SDK gateway path cannot run offline, so its envelope is keyed and checked directly.
test("keys the AI SDK gateway envelope by the configured policy's question", () => {
  const answer = {
    type: "choice" as const,
    choice: "quick" as const,
    probabilities: { quick: 0.7, standard: 0.1, deep: 0.1, uncertain: 0.1 },
  };

  const envelope = {
    answers: { external_class: answer },
    providerMetadata: { typesafe: { confidence: { external_class: 0.9 } } },
    usage: { inputTokens: 5, outputTokens: 1 },
  };

  const parsed = gatewayResponseSchema("external_class").parse(envelope);

  assert.equal(parsed.answers.external_class?.choice, "quick");
  assert.equal(parsed.providerMetadata?.typesafe?.confidence?.external_class, 0.9);
  assert.equal(gatewayResponseSchema("task_class").safeParse(envelope).success, false);
  assert.equal(
    gatewayResponseSchema("task_class").safeParse({ answers: { task_class: answer } }).success,
    true,
  );
});

test("refuses redirects and forwards the caller's signal", async () => {
  const transport = recorder(() => jsonResponse(directBody()));
  const classify = createClassifier(transport.fetch);
  const controller = new AbortController();
  await classify(TYPESAFE, STATE, options(controller.signal, "test-key"));

  assert.equal(transport.calls[0]?.init.redirect, "error");
  assert.equal(transport.calls[0]?.init.signal, controller.signal);
  assert.equal(transport.calls[0]?.init.method, "POST");
});

test("never calls out without a credential", async () => {
  const transport = recorder(() => jsonResponse(directBody()));
  const classify = createClassifier(transport.fetch);

  await expectClassifierError(classify(TYPESAFE, STATE, options(signal(), "   ")), "credentials");
  assert.equal(transport.calls.length, 0);
});

test("reports an HTTP failure with its status", async () => {
  const transport = recorder(() => new Response("denied", { status: 403 }));
  const classify = createClassifier(transport.fetch);

  await expectClassifierError(classify(TYPESAFE, STATE, options(signal(), "k")), "http", 403);
});

test("rejects a declared body larger than the cap", async () => {
  const transport = recorder(
    () => new Response("{}", { status: 200, headers: { "content-length": "70000" } }),
  );

  const classify = createClassifier(transport.fetch);

  await expectClassifierError(
    classify(TYPESAFE, STATE, options(signal(), "k")),
    "invalid-response",
  );
});

test("rejects a streamed body larger than the cap", async () => {
  const oversized = JSON.stringify({ padding: "x".repeat(70_000) });
  const transport = recorder(() => new Response(oversized, { status: 200 }));
  const classify = createClassifier(transport.fetch);

  await expectClassifierError(
    classify(TYPESAFE, STATE, options(signal(), "k")),
    "invalid-response",
  );
});

test("rejects malformed JSON", async () => {
  const transport = recorder(() => new Response("{not json", { status: 200 }));
  const classify = createClassifier(transport.fetch);

  await expectClassifierError(
    classify(TYPESAFE, STATE, options(signal(), "k")),
    "invalid-response",
  );
});

test("rejects an unknown label", async () => {
  const body = directBody();
  const answer = body.answers.task_class;
  answer.choice = "medium";
  const transport = recorder(() => jsonResponse(body));
  const classify = createClassifier(transport.fetch);

  await expectClassifierError(
    classify(TYPESAFE, STATE, options(signal(), "k")),
    "invalid-response",
  );
});

test("rejects probabilities that do not sum to one", async () => {
  const body = directBody();
  const answer = body.answers.task_class;
  answer.probabilities = { quick: 0.4, standard: 0.1, deep: 0.1, uncertain: 0.1 };
  const transport = recorder(() => jsonResponse(body));
  const classify = createClassifier(transport.fetch);

  await expectClassifierError(
    classify(TYPESAFE, STATE, options(signal(), "k")),
    "invalid-response",
  );
});

test("rejects a distribution whose peak is not the reported choice", async () => {
  const body = directBody();
  const answer = body.answers.task_class;
  answer.probabilities = { quick: 0.2, standard: 0.1, deep: 0.6, uncertain: 0.1 };
  const transport = recorder(() => jsonResponse(body));
  const classify = createClassifier(transport.fetch);

  await expectClassifierError(
    classify(TYPESAFE, STATE, options(signal(), "k")),
    "invalid-response",
  );
});

test("rejects an out-of-range confidence", async () => {
  const body = directBody();
  const answer = body.answers.task_class;
  answer.confidence = 1.4;
  const transport = recorder(() => jsonResponse(body));
  const classify = createClassifier(transport.fetch);

  await expectClassifierError(
    classify(TYPESAFE, STATE, options(signal(), "k")),
    "invalid-response",
  );
});

test("drops unusable usage instead of failing the classification", async () => {
  const body = directBody({ usage: { input_tokens: -5, output_tokens: 1 } });
  const transport = recorder(() => jsonResponse(body));
  const classify = createClassifier(transport.fetch);
  const result = await classify(TYPESAFE, STATE, options(signal(), "k"));

  assert.equal(result.usage, undefined);
  assert.equal(result.returnedModel, "jev-1.13.0");
  assert.equal(result.choice, "quick");
});

// The configured model is a pin, not a preference. An answer that cannot name it is a
// protocol failure, and the caller then continues on the current generation model.
test("refuses a response whose model cannot be verified", async () => {
  for (const model of ["not a valid model id!", "jev-1.12.0", "jev-latest"]) {
    const transport = recorder(() => jsonResponse(directBody({ model })));
    const classify = createClassifier(transport.fetch);

    await expectClassifierError(
      classify(TYPESAFE, STATE, options(signal(), "k")),
      "model-mismatch",
    );
  }
});

test("reports cancellation rather than a validation failure", async () => {
  const transport = recorder(() => jsonResponse(directBody()));
  const classify = createClassifier(transport.fetch);
  const controller = new AbortController();
  controller.abort();

  await expectClassifierError(
    classify(TYPESAFE, STATE, options(controller.signal, "k")),
    "cancelled",
  );
});

test("reports a transport rejection as a network failure", async () => {
  const classify = createClassifier(async () => {
    throw new TypeError("fetch failed");
  });

  await expectClassifierError(classify(TYPESAFE, STATE, options(signal(), "k")), "network");
});

test("uses the OpenRouter decisions endpoint", async () => {
  const transport = recorder(() => jsonResponse(directBody({ model: "typesafe/jev-1.13" })));
  const classify = createClassifier(transport.fetch);

  const openrouter: Backend = {
    type: "openrouter",
    model: "typesafe/jev-1.13",
    auth: { source: "env", variable: "OPENROUTER_API_KEY" },
  };

  await classify(openrouter, STATE, options(signal(), "k"));

  assert.equal(transport.calls[0]?.url, "https://openrouter.ai/api/alpha/decisions");
});

test("the AI SDK is loaded only for the backend that needs it", async () => {
  // TypeSafe, OpenRouter, and Cloudflare are plain HTTP. A static import of `ai` would load
  // the gateway, OIDC, and undici closure for every session on those backends.
  const source = await readFile(new URL("../src/classifier.ts", import.meta.url), "utf8");
  const staticImport = /^\s*import[^;]*from\s+"ai";/mu;

  assert.ok(!staticImport.test(source), "`ai` must not be statically imported");
  assert.match(source, /await import\("ai"\)/u);
});

test("uses the Cloudflare gateway endpoint with logging and cache disabled", async () => {
  const transport = recorder(() => jsonResponse(directBody()));
  const classify = createClassifier(transport.fetch);

  const backend: Backend = {
    type: "cloudflare",
    model: "typesafe/jev",
    accountId: "0123456789abcdef0123456789abcdef",
    gatewayId: "my-gateway",
    auth: { source: "env", variable: "CLOUDFLARE_API_TOKEN" },
  };

  await classify(backend, STATE, options(signal(), "k"));

  const call = transport.calls[0];
  assert.ok(call?.url.startsWith("https://api.cloudflare.com/client/v4/accounts/"));
  assert.ok(call?.url.includes("0123456789abcdef0123456789abcdef"));
  // SAFETY: the classifier sets a Headers instance on every request it sends.
  const headers = call?.init.headers as Headers;
  assert.equal(headers.get("cf-aig-gateway-id"), "my-gateway");
  assert.equal(headers.get("cf-aig-collect-log"), "false");
  assert.equal(headers.get("cf-aig-skip-cache"), "true");
  assert.equal(headers.get("cf-aig-max-attempts"), "1");
  assert.match(String(call?.init.body), /"input"/);
});

test("accepts both Cloudflare response envelopes", async () => {
  const wrapped = recorder(() =>
    jsonResponse({ success: true, result: { state: "Completed", result: directBody() } }),
  );

  const bare = recorder(() => jsonResponse(directBody()));

  const backend: Backend = {
    type: "cloudflare",
    model: "typesafe/jev",
    accountId: "a".repeat(32),
    gatewayId: "gateway",
    auth: { source: "env", variable: "CLOUDFLARE_API_TOKEN" },
  };

  assert.equal(
    (await createClassifier(wrapped.fetch)(backend, STATE, options(signal(), "k"))).choice,
    "quick",
  );
  assert.equal(
    (await createClassifier(bare.fetch)(backend, STATE, options(signal(), "k"))).choice,
    "quick",
  );
});

test("rejects a failed Cloudflare envelope", async () => {
  const transport = recorder(() => jsonResponse({ success: false, result: directBody() }));
  const classify = createClassifier(transport.fetch);

  const backend: Backend = {
    type: "cloudflare",
    model: "typesafe/jev",
    accountId: "a".repeat(32),
    gatewayId: "gateway",
    auth: { source: "env", variable: "CLOUDFLARE_API_TOKEN" },
  };

  await expectClassifierError(classify(backend, STATE, options(signal(), "k")), "invalid-response");
});
