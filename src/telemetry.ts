/**
 * Privacy-safe routing telemetry: the decision, the generation outcome it produced, and
 * optional user feedback.
 *
 * Pi custom entries never enter model context, so the session JSONL is the whole store. This
 * module is the only place that builds those payloads, because it is also the only place that
 * guarantees what they may contain: counts, narrow enums, hashes, and numbers.
 *
 * Nothing here persists prompt, history, or response text, a raw provider body, an error body,
 * or a credential value. Every payload is checked against a strict schema before it is appended,
 * and a payload that does not match is dropped with a warning instead of written. Adding a text
 * field to a serializer therefore fails loudly rather than leaking into a session file.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  BACKEND_TYPES,
  TASK_CLASSES,
  THINKING_LEVELS,
  type BackendType,
  type Classification,
  type Mode,
  type Route,
  type TaskClass,
  type Target,
  type ThinkingLevel,
} from "./types.ts";

export const DECISION_TYPE = "typesafe-router-decision";

export const OUTCOME_TYPE = "typesafe-router-outcome";

export const FEEDBACK_TYPE = "typesafe-router-feedback";

/**
 * Custom types another copy of this extension may have written, under the upstream package
 * name. They are read for compatibility and never written.
 */
export const LEGACY_DECISION_TYPES = ["pi-typesafe-router-decision"] as const;

/** Sixteen random hex characters; unique per decision within a session and across sessions. */
export function newDecisionId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * A model or provider identifier, matching the configuration's own rule: no whitespace and no
 * control characters, so a pasted phrase cannot become an identifier. Slashes are allowed
 * because a provider's model IDs may contain them.
 */
const identifier = z
  .string()
  .min(1)
  .max(512)
  // oxlint-disable-next-line no-control-regex
  .refine((value) => value.trim() === value && !/\s|[\u0000-\u001f\u007f]/u.test(value));

/** A bounded lowercase token: no spaces, no uppercase, so it cannot carry prose. */
const reason = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/u);

const hash = z.string().regex(/^[0-9a-f]{64}$/u);

const targetSchema = z
  .object({
    provider: identifier,
    model: identifier,
    thinking: z.enum(THINKING_LEVELS),
  })
  .strict();

export const CANDIDATE_STATUSES = [
  "applied",
  "probe-failed",
  "ineligible",
  "selection-failed",
  "not-attempted",
  "proposed",
] as const;

export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

const candidateSchema = z
  .object({
    target: identifier,
    status: z.enum(CANDIDATE_STATUSES),
    reason: reason.optional(),
  })
  .strict();

export interface CandidateOutcome {
  target: string;
  status: CandidateStatus;
  reason?: string;
}

const classificationSchema = z
  .object({
    choice: z.enum(TASK_CLASSES),
    probabilities: z
      .object({
        quick: z.number().min(0).max(1),
        standard: z.number().min(0).max(1),
        deep: z.number().min(0).max(1),
        uncertain: z.number().min(0).max(1),
      })
      .strict(),
    confidence: z.number().min(0).max(1).optional(),
    requestedModel: identifier,
    returnedModel: identifier.optional(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

const provenanceSchema = z
  .object({
    policyId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    policyHash: hash,
    configHash: hash,
    candidateSnapshotHash: hash,
    classifierModel: z
      .object({
        requested: identifier,
        returned: identifier.optional(),
      })
      .strict(),
  })
  .strict();

const projectionSchema = z
  .object({
    characters: z.number().int().nonnegative(),
    historyMessages: z.number().int().nonnegative(),
  })
  .strict();

const decisionSchema = z
  .object({
    schemaVersion: z.literal(2),
    decisionId: z.string().regex(/^[0-9a-f]{16}$/u),
    mode: z.enum(["off", "auto", "shadow"]),
    shadow: z.boolean(),
    applied: z.boolean(),
    route: z.enum(["quick", "standard", "deep"]),
    reason: reason,
    fallback: reason.optional(),
    backend: z.enum(BACKEND_TYPES),
    target: targetSchema.optional(),
    milliseconds: z.number().int().nonnegative(),
    classifierMilliseconds: z.number().int().nonnegative().optional(),
    minConfidence: z.number().min(0).max(1),
    classification: classificationSchema.optional(),
    margin: z.number().min(0).max(1).optional(),
    candidates: z.array(candidateSchema).max(64),
    selectedIndex: z.number().int().nonnegative().optional(),
    projection: projectionSchema,
    provenance: provenanceSchema,
  })
  .strict();

export const OUTCOME_STATUSES = ["settled", "aborted", "error"] as const;

export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  })
  .strict()
  .partial();

export type GenerationUsage = z.infer<typeof usageSchema>;

const outcomeSchema = z
  .object({
    schemaVersion: z.literal(1),
    decisionId: z.string().regex(/^[0-9a-f]{16}$/u),
    provider: identifier,
    model: identifier,
    configuredThinking: z.enum(THINKING_LEVELS).optional(),
    status: z.enum(OUTCOME_STATUSES),
    stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted", "other"]).optional(),
    responses: z.number().int().nonnegative(),
    elapsedSinceRoutingMs: z.number().int().nonnegative().optional(),
    usage: usageSchema.optional(),
  })
  .strict();

export const feedbackSchema = z
  .object({
    schemaVersion: z.literal(1),
    decisionId: z.string().regex(/^[0-9a-f]{16}$/u),
    expectedRoute: z.enum(TASK_CLASSES).optional(),
    skipped: z.boolean(),
  })
  .strict()
  .refine(
    (value) => value.skipped === (value.expectedRoute === undefined),
    "feedback names a route or is skipped, never both and never neither",
  );

export type DecisionEntry = z.infer<typeof decisionSchema>;

export type OutcomeEntry = z.infer<typeof outcomeSchema>;

export type FeedbackEntry = z.infer<typeof feedbackSchema>;

/**
 * The pre-validation shape of each payload. Zod's *input* type is the contract the builders
 * assemble against, so an optional field is added explicitly instead of hidden behind a
 * conditional empty-object spread.
 */
type ClassificationPayload = z.input<typeof classificationSchema>;

type CandidatePayload = z.input<typeof candidateSchema>;

type DecisionPayload = z.input<typeof decisionSchema>;

type OutcomePayload = z.input<typeof outcomeSchema>;

type FeedbackPayload = z.input<typeof feedbackSchema>;

/** The usable gap between the most and second-most likely class, or `undefined`. */
export function probabilityMargin(
  probabilities: Record<TaskClass, number> | undefined,
): number | undefined {
  if (!probabilities) return undefined;

  const ordered = TASK_CLASSES.map((taskClass) => probabilities[taskClass])
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left);

  if (ordered.length < 2) return undefined;
  const margin = ordered[0]! - ordered[1]!;

  return margin >= 0 && margin <= 1 ? Number(margin.toFixed(4)) : undefined;
}

/** Pi's terminal stop reason, narrowed to the values an outcome entry records. */
export function outcomeStopReason(
  value: string | undefined,
): "stop" | "length" | "toolUse" | "error" | "aborted" | "other" | undefined {
  if (value === undefined) return undefined;

  return value === "stop" ||
    value === "length" ||
    value === "toolUse" ||
    value === "error" ||
    value === "aborted"
    ? value
    : "other";
}

/** The operational status of one settled agent run. Never a statement about task quality. */
export function outcomeStatus(stopReason: string | undefined): OutcomeStatus {
  if (stopReason === "aborted") return "aborted";

  return stopReason === "error" ? "error" : "settled";
}

/** Build the classifier block, keeping only its narrow, numeric fields. */
function classificationOf(value: Classification): ClassificationPayload {
  const payload: ClassificationPayload = {
    choice: value.choice,
    probabilities: { ...value.probabilities },
    requestedModel: value.requestedModel,
  };

  if (value.confidence !== undefined) payload.confidence = value.confidence;

  if (value.returnedModel !== undefined) payload.returnedModel = value.returnedModel;

  if (value.usage !== undefined)
    payload.usage = {
      inputTokens: Math.max(0, Math.trunc(value.usage.inputTokens)),
      outputTokens: Math.max(0, Math.trunc(value.usage.outputTokens)),
    };

  return payload;
}

export interface DecisionInput {
  decisionId: string;
  mode: Mode;
  shadow: boolean;
  applied: boolean;
  route: Route;
  reason: string;
  fallback?: string;
  backend: BackendType;
  target?: Target;
  milliseconds: number;
  classifierMilliseconds?: number;
  minConfidence: number;
  classification?: Classification;
  candidates: readonly CandidateOutcome[];
  selectedIndex?: number;
  projection: { characters: number; historyMessages: number };
  provenance: DecisionEntry["provenance"];
}

/** Compose a decision payload. Returns `undefined` when it would not match the schema. */
export function buildDecision(input: DecisionInput): DecisionEntry | undefined {
  const classification = input.classification ? classificationOf(input.classification) : undefined;

  const payload: DecisionPayload = {
    schemaVersion: 2,
    decisionId: input.decisionId,
    mode: input.mode,
    shadow: input.shadow,
    applied: input.applied,
    route: input.route,
    reason: input.reason,
    backend: input.backend,
    milliseconds: Math.max(0, Math.round(input.milliseconds)),
    minConfidence: input.minConfidence,
    candidates: input.candidates.map((candidate): CandidatePayload => {
      const entry: CandidatePayload = {
        target: candidate.target,
        status: candidate.status,
      };

      if (candidate.reason !== undefined) entry.reason = candidate.reason;

      return entry;
    }),
    projection: {
      characters: Math.max(0, Math.trunc(input.projection.characters)),
      historyMessages: Math.max(0, Math.trunc(input.projection.historyMessages)),
    },
    provenance: input.provenance,
  };

  if (input.fallback !== undefined) payload.fallback = input.fallback;

  if (input.target !== undefined) payload.target = input.target;

  if (input.classifierMilliseconds !== undefined)
    payload.classifierMilliseconds = Math.max(0, Math.round(input.classifierMilliseconds));

  if (classification !== undefined) {
    payload.classification = classification;
    payload.margin = probabilityMargin(classification.probabilities);
  }

  if (input.selectedIndex !== undefined) payload.selectedIndex = input.selectedIndex;

  const parsed = decisionSchema.safeParse(payload);

  return parsed.success ? parsed.data : undefined;
}

export interface OutcomeInput {
  decisionId: string;
  provider: string;
  model: string;
  configuredThinking?: ThinkingLevel;
  status: OutcomeStatus;
  stopReason?: string;
  responses: number;
  elapsedSinceRoutingMs?: number;
  usage?: GenerationUsage;
}

/** Compose an outcome payload. Returns `undefined` when it would not match the schema. */
export function buildOutcome(input: OutcomeInput): OutcomeEntry | undefined {
  const stopReason = outcomeStopReason(input.stopReason);

  const payload: OutcomePayload = {
    schemaVersion: 1,
    decisionId: input.decisionId,
    provider: input.provider,
    model: input.model,
    status: input.status,
    responses: Math.max(0, Math.trunc(input.responses)),
  };

  if (input.configuredThinking !== undefined) payload.configuredThinking = input.configuredThinking;

  if (stopReason !== undefined) payload.stopReason = stopReason;

  if (input.elapsedSinceRoutingMs !== undefined)
    payload.elapsedSinceRoutingMs = Math.max(0, Math.round(input.elapsedSinceRoutingMs));

  if (input.usage !== undefined) payload.usage = numericUsage(input.usage);

  const parsed = outcomeSchema.safeParse(payload);

  return parsed.success ? parsed.data : undefined;
}

/** Every numeric field an outcome entry may carry; a closed list, never a dictionary scan. */
const USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
  "costUsd",
] as const satisfies readonly (keyof GenerationUsage)[];

/** Drop non-finite usage numbers rather than letting one corrupt the whole entry. */
function numericUsage(usage: GenerationUsage): GenerationUsage {
  const kept: GenerationUsage = {};

  for (const key of USAGE_KEYS) {
    const value = usage[key];

    if (value !== undefined && Number.isFinite(value) && value >= 0)
      kept[key] = key === "costUsd" ? value : Math.trunc(value);
  }

  return kept;
}

/** Compose a feedback payload. Returns `undefined` when it would not match the schema. */
export function buildFeedback(
  decisionId: string,
  expected: TaskClass | "skip",
): FeedbackEntry | undefined {
  const payload: FeedbackPayload = {
    schemaVersion: 1,
    decisionId,
    skipped: expected === "skip",
  };

  if (expected !== "skip") payload.expectedRoute = expected;

  const parsed = feedbackSchema.safeParse(payload);

  return parsed.success ? parsed.data : undefined;
}

function isDecisionType(customType: string | undefined): boolean {
  return (
    customType === DECISION_TYPE || LEGACY_DECISION_TYPES.some((legacy) => legacy === customType)
  );
}

/** The session-entry fields this reader consults; Pi owns the full record. */
export interface TelemetryEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}

/**
 * The newest decision on the active branch that can still receive feedback.
 *
 * A decision written by another copy under the upstream type name carries no `decisionId`, so
 * it is not feedback-eligible. Reading the branch instead of an in-memory reference keeps this
 * correct after a reload, a resume, or a tree navigation.
 */
export function latestDecisionId(entries: readonly TelemetryEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;

    if (entry.type !== "custom" || !isDecisionType(entry.customType)) continue;

    const parsed = z
      .object({ decisionId: z.string().regex(/^[0-9a-f]{16}$/u) })
      .safeParse(entry.data);

    if (parsed.success) return parsed.data.decisionId;
  }

  return undefined;
}
