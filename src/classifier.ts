import { z } from "zod";
import { POLICY, policyQuestion } from "./policy.ts";
import { verifyProvenance } from "./provenance.ts";
import { ClassifierError, TASK_CLASSES, type Classification, type Classify } from "./types.ts";

/**
 * The bundled artifact's question, for callers that inspect the default rubric. The actual
 * request is always built from `options.policy`, which the applied configuration selects.
 */
export const RUBRIC = policyQuestion(POLICY);

const MAX_BYTES = 64 * 1024;

const invalid = (): never => {
  throw new ClassifierError("invalid-response");
};

const probabilitySchema = z.number().min(0).max(1);

const tokenCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const probabilitiesSchema = z.strictObject({
  quick: probabilitySchema,
  standard: probabilitySchema,
  deep: probabilitySchema,
  uncertain: probabilitySchema,
});

const answerSchema = z.object({
  type: z.literal("choice"),
  choice: z.enum(TASK_CLASSES),
  probabilities: probabilitiesSchema,
});

const directAnswerSchema = answerSchema.extend({ confidence: probabilitySchema });

type Answer = z.output<typeof answerSchema>;

/**
 * Read the answer a response carries for the *validated policy's* question name.
 *
 * Every TypeSafe-format envelope keys `answers` by the question the request sent, so a policy
 * whose question is not `task_class` still round-trips. `Object.hasOwn` keeps an inherited key
 * such as `constructor` from being mistaken for an answer.
 */
function answerAt<T>(answers: Record<string, T>, question: string): T | undefined {
  return Object.hasOwn(answers, question) ? answers[question] : undefined;
}

/**
 * The direct TypeSafe and OpenRouter envelope. The computed key is not a literal: the answer
 * comes back under whichever question name the policy defines.
 */
function directResponseSchema(question: string) {
  return z.object({
    answers: z.object({ [question]: directAnswerSchema }),
    model: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/)
      .optional()
      .catch(undefined),
    usage: z
      .object({ input_tokens: tokenCountSchema, output_tokens: tokenCountSchema })
      .transform((usage) => ({
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      }))
      .optional()
      .catch(undefined),
  });
}

/**
 * The AI SDK gateway envelope. Exported so the offline suite can cover the question keying
 * without the SDK: a gateway transport cannot be reached without a socket.
 */
export function gatewayResponseSchema(question: string) {
  return z.object({
    answers: z.object({ [question]: answerSchema }),
    providerMetadata: z
      .object({
        typesafe: z
          .object({
            confidence: z.object({ [question]: probabilitySchema.optional() }).optional(),
          })
          .optional(),
      })
      .optional(),
    usage: z
      .object({ inputTokens: tokenCountSchema, outputTokens: tokenCountSchema })
      .optional()
      .catch(undefined),
  });
}

/**
 * The Cloudflare AI Gateway envelope, whose run markers must not fall through to a legacy bare
 * answer when a run is incomplete or malformed. The `state`/`result` guard is a `never`, so an
 * envelope carrying both a marker and an answer is rejected rather than silently accepted.
 */
function cloudflareResponseSchema(question: string) {
  const direct = directResponseSchema(question);

  const cloudflareAnswerSchema = direct.extend({
    state: z.never().optional(),
    result: z.never().optional(),
  });

  const cloudflareResultSchema = z.union([
    z.object({ state: z.literal("Completed"), result: direct }).transform((value) => value.result),
    cloudflareAnswerSchema,
  ]);

  // A malformed envelope must not fall through to the bare-result alternative.
  return z.union([
    z
      .object({ success: z.literal(true), result: cloudflareResultSchema })
      .transform((value) => value.result),
    cloudflareAnswerSchema.extend({ success: z.never().optional() }),
  ]);
}

function normalize(
  answer: Answer,
  requestedModel: string,
  confidence: number | undefined,
  usage: Classification["usage"],
  returnedModel?: string,
): Classification {
  const { choice, probabilities } = answer;

  if (
    Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) > 1e-4 ||
    Object.values(probabilities).some((v) => v > probabilities[choice])
  )
    return invalid();
  const result: Classification = { choice, probabilities, requestedModel };

  if (confidence !== undefined) result.confidence = confidence;

  if (returnedModel !== undefined) result.returnedModel = returnedModel;

  if (usage !== undefined) result.usage = usage;

  return result;
}

/**
 * Turn one direct or Cloudflare envelope into a classification.
 *
 * `unknown` is the input contract on purpose: this function *is* the boundary that decodes an
 * untrusted provider body, and the strict schema below is what establishes the shape.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- decoding an untrusted provider body is this function's contract
function directClassification(question: string, value: unknown, requestedModel: string) {
  const parsed = directResponseSchema(question).safeParse(value);

  if (!parsed.success) return invalid();

  const answer = answerAt(parsed.data.answers, question);

  if (answer === undefined) return invalid();

  return normalize(answer, requestedModel, answer.confidence, parsed.data.usage, parsed.data.model);
}

/** The Cloudflare run envelope, whose failure markers the schema rejects before an answer. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- decoding an untrusted provider body is this function's contract
function cloudflareClassification(question: string, value: unknown, requestedModel: string) {
  const parsed = cloudflareResponseSchema(question).safeParse(value);

  if (!parsed.success) return invalid();

  const answer = answerAt(parsed.data.answers, question);

  if (answer === undefined) return invalid();

  return normalize(answer, requestedModel, answer.confidence, parsed.data.usage, parsed.data.model);
}

async function boundedBody(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();

  if (!reader) return invalid();

  const cancel = () => {
    void reader.cancel().catch(() => {});
  };

  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    signal.throwIfAborted();
    const declared = response.headers.get("content-length");

    if (declared !== null && Number(declared) > MAX_BYTES) return invalid();

    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();

      if (done) break;
      length += value.byteLength;

      if (length > MAX_BYTES) return invalid();
      chunks.push(value);
    }

    const bytes = new Uint8Array(length);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return bytes;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Fetch injection is for offline transport tests, not configurable endpoints. */
export function createClassifier(
  fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
): Classify {
  return async (backend, state, { signal, apiKey, policy }) => {
    let transportError: ClassifierError | undefined;

    const guardedFetch: typeof fetch = async (url, init) => {
      try {
        signal.throwIfAborted();
        const response = await fetchImpl(url, { ...init, signal, redirect: "error" });

        if (!response.ok || response.redirected) {
          void response.body?.cancel().catch(() => {});
          throw new ClassifierError("http", response.status);
        }

        const bytes = await boundedBody(response, signal);

        return new Response(bytes, {
          status: response.status,
          headers: response.headers,
        });
      } catch (error) {
        transportError = error instanceof ClassifierError ? error : new ClassifierError("network");
        throw transportError;
      }
    };

    try {
      signal.throwIfAborted();

      if (!apiKey.trim()) throw new ClassifierError("credentials");
      const question = policy.question;
      const questions = { [question]: policyQuestion(policy) };

      if (backend.type === "vercel") {
        // Load the AI SDK only for the backend that needs it. TypeSafe, OpenRouter, and
        // Cloudflare are plain HTTP, and importing this closure for them was pure cost.
        const { createGateway, experimental_evaluate: evaluate } = await import("ai");
        const gateway = createGateway({ apiKey, fetch: guardedFetch });
        const model = gateway.evaluationModel(backend.model);

        // The SDK logs provider-supplied warnings by default. Never print their text.
        const quietModel = {
          specificationVersion: model.specificationVersion,
          provider: model.provider,
          modelId: model.modelId,
          supportedQuestionTypes: model.supportedQuestionTypes,
          doEvaluate: async (...args: Parameters<typeof model.doEvaluate>) => ({
            ...(await model.doEvaluate(...args)),
            warnings: [],
          }),
        };

        const result = await evaluate({
          model: quietModel,
          state: { ...state },
          questions,
          maxRetries: 0,
          abortSignal: signal,
          providerOptions: { gateway: { zeroDataRetention: backend.zeroDataRetention } },
        });

        const parsed = gatewayResponseSchema(question).parse(result);
        const answer = answerAt(parsed.answers, question);

        if (answer === undefined) return invalid();

        // Gateway reports the requested ID, not upstream model provenance.
        const classification = normalize(
          answer,
          backend.model,
          parsed.providerMetadata?.typesafe?.confidence?.[question],
          parsed.usage,
        );

        verifyProvenance(backend, classification);

        return classification;
      }

      const headers = new Headers({
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      });

      let url: string;
      let body: string;
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a provider body is untrusted until the schema parses it
      let parse: (value: unknown) => Classification;

      switch (backend.type) {
        case "typesafe":
          url = "https://api.typesafe.ai/v1/systemone";
          body = JSON.stringify({ model: backend.model, state, questions });
          parse = (value) => directClassification(question, value, backend.model);
          break;
        case "openrouter":
          url = "https://openrouter.ai/api/alpha/decisions";
          body = JSON.stringify({ model: backend.model, state, questions });
          parse = (value) => directClassification(question, value, backend.model);
          break;
        case "cloudflare":
          url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(backend.accountId)}/ai/run`;
          body = JSON.stringify({ model: backend.model, input: { state, questions } });
          parse = (value) => cloudflareClassification(question, value, backend.model);
          headers.set("cf-aig-gateway-id", backend.gatewayId);
          headers.set("cf-aig-collect-log", "false");
          headers.set("cf-aig-skip-cache", "true");
          headers.set("cf-aig-max-attempts", "1");
          break;
      }

      const response = await guardedFetch(url, {
        method: "POST",
        headers,
        body,
      });

      const classification = parse(await response.json());
      signal.throwIfAborted();

      verifyProvenance(backend, classification);

      return classification;
    } catch (error) {
      // Deadline ownership stays with the caller; it can inspect its signal reason.
      if (signal.aborted) throw new ClassifierError("cancelled");

      if (transportError) throw transportError;

      if (error instanceof ClassifierError) throw error;
      throw new ClassifierError("invalid-response");
    }
  };
}

export const classify: Classify = createClassifier();
