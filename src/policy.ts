/**
 * The routing rubric is one artifact, not two copies.
 *
 * `policy.json` beside this extension is the default definition of the classifier's
 * instructions and criteria. This module validates it strictly and fails loudly, and
 * `src/classifier.ts` builds its request from the validated value. A configuration may select
 * a different artifact by absolute path with `policyPath`; `resolvePolicy` loads that one with
 * the same schema. The Python benchmark reads the same file the runtime resolved, so the two
 * cannot drift apart.
 *
 * Every failure message here is deliberately generic: a policy path and a policy body can both
 * contain material this extension must never print.
 */

import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ReadError, readBoundedFile, readBoundedFileSync } from "./bounded-file.ts";
import { TASK_CLASSES, type RoutingPolicy } from "./types.ts";

export type { RoutingPolicy } from "./types.ts";

/** Beside the extension directory, so a store-installed copy resolves its own artifact. */
export const POLICY_PATH = fileURLToPath(new URL("../policy.json", import.meta.url));

/** The largest accepted rubric. The bundled artifact is well under 2 KiB. */
export const MAX_POLICY_BYTES = 64 * 1024;

const UNREADABLE = "Routing policy is unreadable";

const TOO_LARGE = "Routing policy is too large to load";

const NOT_JSON = "Routing policy is not valid JSON";

const INVALID = "Invalid routing policy; check the documented schema.";

// No `.trim()` or other transform: the parsed value must equal the file's content so the
// runtime hash and the benchmark's hash of the raw file agree.
const promptLine = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) => value.trim() === value);

const schema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    question: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    type: z.literal("choice"),
    instructions: promptLine,
    criteria: z
      .object({
        quick: promptLine,
        standard: promptLine,
        deep: promptLine,
        uncertain: promptLine,
      })
      .strict(),
  })
  .strict();

/**
 * Never expose Zod issues: a policy path or value detail must not reach the terminal.
 *
 * `unknown` is the input contract on purpose: this function *is* the boundary that turns an
 * untrusted artifact into a `RoutingPolicy`, and the strict schema below is what establishes it.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- decoding untrusted JSON is this function's contract
export function parsePolicy(value: unknown): RoutingPolicy {
  const parsed = schema.safeParse(value);

  if (!parsed.success || Object.keys(parsed.data.criteria).length !== TASK_CLASSES.length)
    throw new Error(INVALID);

  return parsed.data;
}

function parsePolicyText(text: string): RoutingPolicy {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(NOT_JSON);
  }

  return parsePolicy(value);
}

/**
 * Read and validate one rubric. Cancellation propagates its own reason; every other failure is
 * one of the generic sentences above, so a rejected path or body never reaches a terminal.
 */
export async function loadPolicy(path: string, signal?: AbortSignal): Promise<RoutingPolicy> {
  let text: string;

  try {
    text = await readBoundedFile(path, MAX_POLICY_BYTES, signal);
  } catch (error) {
    if (signal?.aborted) throw error;

    if (error instanceof ReadError && error.reason === "too-large") throw new Error(TOO_LARGE);

    throw new Error(UNREADABLE);
  }

  return parsePolicyText(text);
}

/** The bundled artifact is trusted but still stat-gated, so a bad package fails loudly. */
function loadBundledPolicy(): RoutingPolicy {
  let text: string;

  try {
    text = readBoundedFileSync(POLICY_PATH, MAX_POLICY_BYTES);
  } catch (error) {
    if (error instanceof ReadError && error.reason === "too-large") throw new Error(TOO_LARGE);
    throw new Error(UNREADABLE);
  }

  return parsePolicyText(text);
}

/** Validated once at load; a malformed artifact is a startup failure, never a silent default. */
export const POLICY: RoutingPolicy = loadBundledPolicy();

/**
 * The policy a configuration selects: its own `policyPath` when set, otherwise the artifact
 * bundled beside the extension. A rejection here is a configuration fault, and the messages
 * never include the file's contents or the path, so a caller may route them to a warning as-is.
 */
export async function resolvePolicy(
  policyPath: string | undefined,
  signal?: AbortSignal,
): Promise<RoutingPolicy> {
  return policyPath === undefined ? POLICY : loadPolicy(policyPath, signal);
}

/** The classifier's question object, built from the artifact. */
export function policyQuestion(policy: RoutingPolicy = POLICY) {
  return Object.freeze({
    type: policy.type,
    instructions: policy.instructions,
    criteria: Object.freeze({ ...policy.criteria }),
  });
}
