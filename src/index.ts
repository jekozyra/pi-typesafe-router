import { join } from "node:path";
import {
  buildSessionContext,
  convertToLlm,
  getAgentDir,
  type ExtensionAPI,
  type InputEvent,
  type SessionBeforeSwitchEvent,
  type SessionBeforeForkEvent,
  type SessionBeforeTreeEvent,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, Usage } from "@earendil-works/pi-ai";
import { z } from "zod";
import { matchesKey } from "@earendil-works/pi-tui";
import type { RouterAPI, RouterContext } from "./host.ts";

export type { RouterAPI, RouterContext, RouterEvents } from "./host.ts";

import { classify as defaultClassify } from "./classifier.ts";
import { parseConfig } from "./config.ts";
import { contextInputTokens, projectState } from "./context.ts";
import { candidateChecks, chooseRoute } from "./routing.ts";
import { probeGeneration as defaultProbeGeneration } from "./generation-probe.ts";
import {
  ProofStore,
  configuredTargets,
  targetFingerprint,
  verificationFingerprint,
} from "./verification.ts";
import { classifierLines, routeLines, runtimeLines, type EvaluationResult } from "./diagnostics.ts";
import { abortable, createConfig, loadConfig } from "./settings.ts";
import { POLICY, resolvePolicy, type RoutingPolicy } from "./policy.ts";
import { candidateSnapshotHash, configHash, policyHash } from "./provenance.ts";
import {
  DECISION_TYPE,
  FEEDBACK_TYPE,
  OUTCOME_TYPE,
  buildDecision,
  buildFeedback,
  buildOutcome,
  latestDecisionId,
  newDecisionId,
  outcomeStatus,
  type CandidateOutcome,
  type DecisionEntry,
  type DecisionInput,
  type OutcomeInput,
  type GenerationUsage,
} from "./telemetry.ts";
import {
  BACKEND_TYPES,
  TASK_CLASSES,
  THINKING_LEVELS,
  ClassifierError,
  historyRoles,
  isBackendType,
  targetKey,
  type Classification,
  type Classify,
  type Eligibility,
  type HistoryRole,
  type Mode,
  type ThinkingLevel,
  type RouterConfig,
  type Target,
  type TaskClass,
} from "./types.ts";

const NAME = "typesafe-router";

const sessionModeSchema = z.object({ mode: z.enum(["off", "auto", "shadow"]) });

/**
 * One persisted generation proof. The target is stored in full so a restore can match it
 * against the applied configuration and recompute its fingerprint before trusting it.
 */
const storedProofSchema = z
  .object({
    provider: z.string().min(1).max(512),
    model: z.string().min(1).max(512),
    thinking: z.enum(THINKING_LEVELS),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    checkedAt: z.iso.datetime(),
  })
  .strict();

/**
 * A session verification entry. `verified: false` is a tombstone: the branch's newest entry
 * wins, so a later failure or a stale fingerprint cannot be shadowed by an earlier success.
 */
const verificationEntrySchema = z.discriminatedUnion("verified", [
  z.object({ verified: z.literal(false) }).strict(),
  z.object({ verified: z.literal(true), proofs: z.array(storedProofSchema).max(24) }).strict(),
]);

const BACKEND_HELP = BACKEND_TYPES.join("|");

/**
 * What leaves the machine, stated from the applied projection so the dialog cannot
 * contradict the configuration it is describing.
 */
function disclosure(cfg: RouterConfig): string {
  const history = historyRoles(cfg).includes("assistant")
    ? "your request and bounded recent user and assistant text"
    : "your request and bounded recent user text only";

  return `Classification sends ${history} to the configured backend. Text can contain private code or secrets. Shadow mode also sends data and may incur charges. No automatic generation replay or classifier-backend failover.`;
}

const HELP = `/typesafe-router setup [${BACKEND_HELP}] | doctor [local|live] | feedback <class> | status | on | shadow | off | help`;

const COMMAND_HELP = `Usage: /typesafe-router <command>

Command                              Description
---------------                      ------------------------------------
setup [${BACKEND_HELP}] Create a config interactively.
doctor [local|live]                  Apply and validate config. Local is offline;
                                     live adds synthetic probes (may incur charges).
feedback ${TASK_CLASSES.join("|")}|skip
                                     Record the class this prompt should have taken.
status                               Show current settings and activity.
on                                   Enable automatic routing.
shadow                               Classify without switching models.
off                                  Disable routing.
help                                 Show this table.`;

/** Which policy, configuration, and candidate order produced a decision. */
type DecisionProvenance = DecisionEntry["provenance"];

/** Why one route's chain yielded no target, in the order preflight discovers it. */
type RouteFailure = "no-eligible-target" | "probe-failed" | "selection-failed";

/** A routed generation that has ended, recorded once when the run settles. */
interface PendingOutcome {
  decisionId: string;
  provider: string;
  model: string;
  configuredThinking?: ThinkingLevel;
  responses: number;
  stopReason?: string;
  usage?: GenerationUsage;
}

interface Operation {
  controller: AbortController;
  epoch: number;
  phase: "classifying" | "selecting" | "loading" | "probing";
  purpose: "routing" | "doctor" | "config";
  done: Promise<void>;
}

export interface Dependencies {
  configPath?: string;
  classify?: Classify;
  probeGeneration?: typeof defaultProbeGeneration;
  load?: (path: string) => Promise<RouterConfig | undefined>;
}

/** Register the extension; dependency overrides are for offline integration tests. */
export function registerRouter(pi: RouterAPI, dependencies: Dependencies = {}): void {
  const path = dependencies.configPath ?? join(getAgentDir(), "typesafe-router.json");
  const classify = dependencies.classify ?? defaultClassify;
  const readConfig = dependencies.load ?? loadConfig;
  const probeGeneration = dependencies.probeGeneration ?? defaultProbeGeneration;
  /** Session-scoped access proofs, each bound to the target and registry facts it was earned against. */
  const proofs = new ProofStore();
  /**
   * The rubric the applied configuration selects. It tracks `config`: the bundled artifact
   * unless a config names its own absolute `policyPath`, and the bundled artifact again when a
   * config is rejected, so provenance can never describe a policy that is not in force.
   */
  let policy: RoutingPolicy = POLICY;
  let config: RouterConfig | undefined;
  let configError = false;
  let configErrorNotified = false;
  let mode: Mode = "off";
  let epoch = 0;
  let active: Operation | undefined;
  let selecting: string | undefined;
  let last: DecisionEntry | undefined;
  /** When the current decision began, for the routed generation's elapsed time. */
  let lastStartedAt: number | undefined;
  /** Set by the first routed assistant message and written once when the run settles. */
  let pendingOutcome: PendingOutcome | undefined;
  /** The decision whose terminal outcome was already written, so a repeated settle is inert. */
  let outcomeDecisionId: string | undefined;
  let generationFailed = false;
  let shuttingDown = false;

  function notify(ctx: RouterContext, text: string, type: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI) ctx.ui.notify(text, type);
    else process.stderr.write(`[${NAME}] ${text}\n`);
  }

  function status(ctx: RouterContext) {
    if (ctx.hasUI)
      ctx.ui.setStatus(
        NAME,
        mode === "off"
          ? undefined
          : `Jev ${mode}${active ? `: ${active.phase}` : last?.target ? `: ${targetKey(last.target)}` : ""}`,
      );
  }

  function cancel() {
    epoch++;
    active?.controller.abort();
  }

  function isCurrent(op: Operation) {
    return op.epoch === epoch && !op.controller.signal.aborted;
  }

  function verificationType() {
    return `${NAME}-verification`;
  }

  /** Clear proofs and leave a tombstone so a stale success cannot shadow this failure. */
  function invalidateProofs() {
    proofs.clear();
    pi.appendEntry(verificationType(), { verified: false });
  }

  /** Record the current proofs, so a reload or tree navigation can restore the ones still true. */
  function persistProofs() {
    pi.appendEntry(verificationType(), {
      verified: true,
      proofs: proofs.entries().map(({ target, fingerprint, checkedAt }) => ({
        provider: target.provider,
        model: target.model,
        thinking: target.thinking,
        fingerprint,
        checkedAt,
      })),
    });
  }

  /**
   * Rebuild proofs from the branch's newest verification entry. A proof is adopted only when
   * the applied configuration still declares its exact target and the target's fingerprint,
   * recomputed against the live registry, still matches. A branch whose newest entry is a
   * tombstone restores nothing, so a later failure is never shadowed by an earlier success.
   */
  function restoreProofs(ctx: RouterContext) {
    proofs.clear();
    let persisted: z.infer<typeof verificationEntrySchema> | undefined;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== verificationType()) continue;
      const parsed = verificationEntrySchema.safeParse(entry.data);
      persisted = parsed.success ? parsed.data : { verified: false };
    }

    if (!persisted?.verified || !config || configError) return;

    const targets = new Map(configuredTargets(config).map((target) => [targetKey(target), target]));
    let restored = 0;

    for (const stored of persisted.proofs) {
      const target = targets.get(`${stored.provider}/${stored.model}`);

      if (!target || target.thinking !== stored.thinking) continue;

      if (targetFingerprint(target, ctx.modelRegistry) !== stored.fingerprint) continue;

      proofs.adopt(target, stored.fingerprint, stored.checkedAt);
      restored++;
    }

    // A verified entry whose proofs are all stale is exactly the case a tombstone records.
    if (restored === 0) invalidateProofs();
    else if (restored < persisted.proofs.length) persistProofs();
  }

  function setMode(next: Mode, ctx: RouterContext) {
    cancel();
    mode = next;
    pi.appendEntry(`${NAME}-mode`, { mode });
    status(ctx);
  }

  async function reload(ctx: RouterContext): Promise<boolean> {
    proofs.clear();
    const { op, cleanup } = begin(ctx, "config");
    op.phase = "loading";
    status(ctx);

    try {
      const loaded = await abortable(() => readConfig(path), op.controller.signal);

      if (!isCurrent(op) || shuttingDown) return false;
      // Resolve the rubric before publishing the config. An unreadable or invalid external
      // policy is a configuration fault, so it takes the same fail-open path as bad JSON
      // rather than silently falling back to the bundled artifact.
      const selected = await resolvePolicy(loaded?.policyPath, op.controller.signal);

      // A cancel during the policy read must not publish a configuration the operator stopped.
      if (!isCurrent(op) || shuttingDown) return false;

      policy = selected;
      config = loaded;
      configError = false;
      configErrorNotified = false;
      mode = loaded?.mode ?? "off";
      last = undefined;
      generationFailed = false;

      return true;
    } catch {
      if (!isCurrent(op) || shuttingDown) return false;
      policy = POLICY;
      config = undefined;
      configError = true;
      configErrorNotified = true;
      mode = "off";
      last = undefined;
      generationFailed = false;
      notify(
        ctx,
        `Invalid router configuration at ${path}. Automatic routing is skipped, so prompts continue on the current model. Repair the file and run /typesafe-router doctor.`,
        "error",
      );

      return true;
    } finally {
      cleanup();
    }
  }

  function contextMessages(ctx: RouterContext) {
    return buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId())
      .messages;
  }

  function eligibility(
    ctx: RouterContext,
    cfg: RouterConfig,
    text = "",
    images: readonly ImageContent[] = [],
  ): Eligibility {
    const messages = contextMessages(ctx);

    const historyHasImages = convertToLlm(messages).some(
      (message) =>
        Array.isArray(message.content) && message.content.some((block) => block.type === "image"),
    );

    return {
      models: ctx.modelRegistry.getAll(),
      available: ctx.modelRegistry.getAvailable(),
      scope: ctx.scopedModels.map(({ model }) => ({
        provider: model.provider,
        model: model.id,
        thinking: "high" as const,
      })),
      hasImages: images.length > 0 || historyHasImages,
      inputTokens: contextInputTokens(
        ctx.getContextUsage(),
        messages,
        text || images.length
          ? { role: "user", content: [{ type: "text", text }, ...images], timestamp: Date.now() }
          : undefined,
      ),
      outputReserveTokens: cfg.outputReserveTokens,
    };
  }

  async function credential(
    ctx: RouterContext,
    cfg: RouterConfig,
    signal: AbortSignal,
  ): Promise<string> {
    const auth = cfg.backend.auth;

    const key =
      auth.source === "env"
        ? process.env[auth.variable]
        : (await abortable(() => ctx.modelRegistry.getProviderAuth(auth.provider), signal))?.auth
            .apiKey;

    if (!key?.trim()) throw new ClassifierError("credentials");

    return key.trim();
  }

  async function evaluate(
    ctx: RouterContext,
    cfg: RouterConfig,
    text: string,
    op: Operation,
    synthetic = false,
  ): Promise<EvaluationResult> {
    const roles = historyRoles(cfg);

    // SAFETY: the guard above narrows the message role to one the config projects; the
    // assertion restates that narrowing for the array element type.
    const history = synthetic
      ? []
      : ctx.sessionManager
          .buildContextEntries()
          .flatMap((entry) =>
            entry.type === "message" && roles.includes(entry.message.role as HistoryRole)
              ? [entry.message]
              : [],
          );

    const state = projectState(text, history, cfg.maxContextChars, cfg.historyMessages, roles);

    if (!state || (!synthetic && text.trimStart().startsWith("/")))
      return { reason: "insufficient-context" };
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), cfg.timeoutMs);
    const signal = AbortSignal.any([timeout.signal, op.controller.signal]);

    try {
      const apiKey = await credential(ctx, cfg, signal);

      const classification = await abortable(
        () => classify(cfg.backend, state, { signal, apiKey, policy }),
        signal,
      );

      return {
        classification,
        projection: {
          characters:
            state.current_request.length +
            state.recent_conversation.reduce((total, message) => total + message.text.length, 0),
          historyMessages: state.recent_conversation.length,
        },
        reason:
          classification.choice === "uncertain" ||
          classification.confidence === undefined ||
          classification.confidence < cfg.minConfidence
            ? "uncertain"
            : "classified",
      };
    } catch (error) {
      if (op.controller.signal.aborted) throw error;

      return {
        failure: timeout.signal.aborted
          ? { code: "timeout" }
          : error instanceof ClassifierError
            ? { code: error.code, status: error.status }
            : { code: "unavailable" },
        reason: timeout.signal.aborted
          ? "timeout"
          : error instanceof ClassifierError
            ? error.code
            : "unavailable",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Walk one route's configured chain in order. A candidate is probed only when its turn
   * comes, and a passed probe is remembered for the session, so an unrelated broken route
   * never blocks this prompt and a working target is not re-probed on every submission.
   *
   * The returned outcomes cover every configured candidate in order, so a later aggregate can
   * see where the chain fell through without reading any other state.
   */
  async function select(
    ctx: RouterContext,
    cfg: RouterConfig,
    targets: readonly Target[],
    checks: Eligibility,
    op: Operation,
  ): Promise<{
    target?: Target;
    outcomes: CandidateOutcome[];
    selectedIndex?: number;
    failure: RouteFailure;
  }> {
    const ordered = candidateChecks(targets, checks);

    const outcomes: CandidateOutcome[] = ordered.map((candidate) =>
      candidate.eligible
        ? { target: targetKey(candidate.target), status: "not-attempted" }
        : {
            target: targetKey(candidate.target),
            status: "ineligible",
            reason: candidate.reason ?? "unreported",
          },
    );

    let probed = 0;
    let probeFailed = 0;
    let attempted = false;

    for (let index = 0; index < ordered.length; index++) {
      if (!isCurrent(op)) break;
      const check = ordered[index]!;
      const key = targetKey(check.target);

      if (!check.eligible) continue;

      if (!proofs.valid(check.target, ctx.modelRegistry)) {
        op.phase = "probing";
        status(ctx);
        probed++;

        const probe = await abortable(
          () =>
            probeGeneration(
              ctx.modelRegistry,
              check.target,
              op.controller.signal,
              cfg.generationProbeTimeoutMs,
            ),
          op.controller.signal,
        );

        if (!isCurrent(op)) break;

        if (!probe.passed) {
          probeFailed++;
          outcomes[index] = { target: key, status: "probe-failed", reason: probe.reason };
          continue;
        }

        proofs.remember(check.target, ctx.modelRegistry);
      }

      const model = ctx.modelRegistry.find(check.target.provider, check.target.model);

      if (!model) {
        outcomes[index] = { target: key, status: "ineligible", reason: "disappeared" };
        continue;
      }

      op.phase = "selecting";
      status(ctx);
      selecting = key;
      attempted = true;

      let selected = false;

      try {
        // Pi's setter is not cancellable. Await it; never race another selection against it.
        selected = await pi.setModel(model);
      } catch {
        outcomes[index] = { target: key, status: "selection-failed", reason: "set-failed" };
        continue;
      } finally {
        selecting = undefined;
      }

      if (!isCurrent(op)) break;

      if (selected) {
        // Model and thinking selection are intentionally separate: Pi's model catalog owns
        // availability, while Jev's route target owns the effort appropriate to the task.
        pi.setThinkingLevel(check.target.thinking);
        outcomes[index] = { target: key, status: "applied" };

        return {
          target: check.target,
          outcomes,
          selectedIndex: index,
          failure: "no-eligible-target",
        };
      }

      outcomes[index] = {
        target: key,
        status: "selection-failed",
        reason: "auth-not-configured",
      };
    }

    const failure: RouteFailure = attempted
      ? "selection-failed"
      : probed > 0 && probeFailed === probed
        ? "probe-failed"
        : "no-eligible-target";

    return { outcomes, failure };
  }

  /** The audit trail for one decision: policy, config, candidate order, and classifier model. */
  function provenanceOf(cfg: RouterConfig, classification?: Classification): DecisionProvenance {
    const returned = classification?.returnedModel;

    return {
      policyId: policy.id,
      policyHash: policyHash(policy),
      configHash: configHash(cfg),
      candidateSnapshotHash: candidateSnapshotHash(cfg.routes),
      classifierModel: classifierModelOf(cfg.backend.model, returned),
    };
  }

  /** The classifier identity a decision records: what was requested, and what answered. */
  function classifierModelOf(
    requested: string,
    returned: string | undefined,
  ): DecisionProvenance["classifierModel"] {
    const identity: DecisionProvenance["classifierModel"] = { requested };

    if (returned !== undefined) identity.returned = returned;

    return identity;
  }

  /**
   * Record one decision. The payload is validated before it is appended, so a future change
   * that added prompt or credential material would fail here instead of entering a session
   * file. Losing a telemetry entry is cheaper than leaking one.
   */
  function persistDecision(ctx: RouterContext, input: DecisionInput, startedAt: number): void {
    const entry = buildDecision(input);

    if (!entry) {
      notify(
        ctx,
        "A routing decision was not recorded: it did not match the telemetry schema.",
        "warning",
      );
      status(ctx);

      return;
    }

    last = entry;
    lastStartedAt = startedAt;
    outcomeDecisionId = undefined;
    pi.appendEntry(DECISION_TYPE, entry);
    status(ctx);
  }

  function begin(ctx: RouterContext, purpose: Operation["purpose"] = "routing") {
    if (active || shuttingDown || !ctx.isIdle())
      throw new Error("Router operation is no longer permitted");
    epoch++;
    let settle!: () => void;

    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const op: Operation = {
      controller: new AbortController(),
      epoch,
      phase: "classifying",
      purpose,
      done,
    };

    active = op;

    const unsubscribe =
      ctx.mode === "tui"
        ? ctx.ui.onTerminalInput((data) => {
            if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
              cancel();

              return { consume: true };
            }

            return undefined;
          })
        : () => {};

    status(ctx);

    return {
      op,
      cleanup: () => {
        try {
          unsubscribe();

          if (active === op) active = undefined;

          if (!shuttingDown) status(ctx);
        } finally {
          settle();
        }
      },
    };
  }

  function currentModelKey(ctx: RouterContext) {
    return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "the current model";
  }

  /**
   * Restore a cancelled submission and suppress generation. Pi's input hook cannot return a
   * replacement prompt, so the text goes back to the editor whenever the interface has one.
   * Attachments have no matching setter; they are reported rather than silently dropped.
   */
  function restoreCancelled(ctx: RouterContext, event: InputEvent, selectingTarget: boolean) {
    // RouterContext types setEditorText as present, so only the UI and the empty text decide.
    const restored = ctx.hasUI && event.text.length > 0;

    if (restored) ctx.ui.setEditorText(event.text);

    const attachments = event.images?.length
      ? " Image attachments are not restored; reattach them before resubmitting."
      : "";

    notify(
      ctx,
      restored
        ? `Routing cancelled; the prompt was restored to the editor.${attachments}`
        : `Routing cancelled; the prompt was not submitted.${attachments}${
            selectingTarget
              ? " Pi may have changed model authentication; check /model before resubmitting."
              : " Submit it again when ready."
          }`,
      "warning",
    );
  }

  /** Pi's usage object, narrowed to the numeric fields an outcome entry may carry. */
  function usageOf(usage: Usage | undefined): GenerationUsage | undefined {
    const count = (value: number | undefined) =>
      value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;

    const narrowed = {
      inputTokens: count(usage?.input),
      outputTokens: count(usage?.output),
      cacheReadTokens: count(usage?.cacheRead),
      cacheWriteTokens: count(usage?.cacheWrite),
      totalTokens: count(usage?.totalTokens),
      costUsd: count(usage?.cost?.total),
    };

    return Object.values(narrowed).some((value) => value !== undefined) ? narrowed : undefined;
  }

  /** Sum known fields across routed responses; one missing component makes that total unknown. */
  function addUsage(
    accumulated: GenerationUsage | undefined,
    next: GenerationUsage | undefined,
  ): GenerationUsage | undefined {
    if (!accumulated || !next) return undefined;

    const sum = (key: keyof GenerationUsage) => {
      const left = accumulated[key];
      const right = next[key];

      return left === undefined || right === undefined ? undefined : left + right;
    };

    const combined = {
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheWriteTokens: sum("cacheWriteTokens"),
      totalTokens: sum("totalTokens"),
      costUsd: sum("costUsd"),
    };

    return Object.values(combined).some((value) => value !== undefined) ? combined : undefined;
  }

  /**
   * Automatic routing for one submission: classify the real prompt once, then probe and
   * select only the chosen route's chain. Every failure leaves the prompt untouched on Pi's
   * current model. Only an explicit cancellation suppresses generation.
   */
  async function routeSubmission(
    ctx: RouterContext,
    cfg: RouterConfig,
    event: InputEvent,
    op: Operation,
    startedAt: number,
    decisionId: string,
  ): Promise<void> {
    // A new submission invalidates any previous generation-failure state.
    generationFailed = false;
    pendingOutcome = undefined;

    const classifierStarted = Date.now();
    const result = await evaluate(ctx, cfg, event.text, op);
    const classifierMilliseconds = Date.now() - classifierStarted;

    if (!isCurrent(op)) return;

    const route =
      result.reason === "insufficient-context"
        ? cfg.uncertainRoute
        : chooseRoute(result.classification, cfg);

    const checks = eligibility(ctx, cfg, event.text, event.images);
    const chain = cfg.routes[route];
    const shadow = mode === "shadow";

    const common = {
      decisionId,
      mode,
      shadow,
      route,
      reason: result.reason,
      backend: cfg.backend.type,
      classifierMilliseconds,
      minConfidence: cfg.minConfidence,
      projection: result.projection ?? { characters: 0, historyMessages: 0 },
      provenance: provenanceOf(cfg, result.classification),
    };

    // A classifier fault fails in every mode, shadow included: shadow records what routing
    // would have done, and without a valid classification it would have done nothing.
    if (result.failure) {
      persistDecision(
        ctx,
        {
          ...common,
          applied: false,
          fallback: "classifier-failure",
          milliseconds: Date.now() - startedAt,
          candidates: [],
        },
        startedAt,
      );
      notify(
        ctx,
        `Jev could not classify this request (${result.reason}); continuing on ${currentModelKey(ctx)} without switching models.`,
        "warning",
      );

      return;
    }

    if (shadow) {
      const candidates = candidateChecks(chain, checks);
      const proposed = candidates.findIndex((candidate) => candidate.eligible);

      const shadowInput: DecisionInput = {
        ...common,
        applied: false,
        milliseconds: Date.now() - startedAt,
        classification: result.classification,
        candidates: candidates.map((candidate) =>
          candidate.eligible
            ? { target: targetKey(candidate.target), status: "proposed" as const }
            : {
                target: targetKey(candidate.target),
                status: "ineligible" as const,
                reason: candidate.reason ?? "unreported",
              },
        ),
      };

      if (proposed >= 0) {
        shadowInput.target = candidates[proposed]!.target;
        shadowInput.selectedIndex = proposed;
      }

      persistDecision(ctx, shadowInput, startedAt);

      return;
    }

    const selected = await select(ctx, cfg, chain, checks, op);

    if (!isCurrent(op)) return;

    const routedInput: DecisionInput = {
      ...common,
      applied: selected.target !== undefined,
      milliseconds: Date.now() - startedAt,
      classification: result.classification,
      candidates: selected.outcomes,
    };

    if (selected.target !== undefined) routedInput.target = selected.target;

    if (selected.selectedIndex !== undefined) routedInput.selectedIndex = selected.selectedIndex;
    else if (selected.target === undefined) routedInput.fallback = selected.failure;

    persistDecision(ctx, routedInput, startedAt);

    if (!selected.target) {
      notify(
        ctx,
        `No usable model in the ${route} route (${selected.failure}); continuing on ${currentModelKey(ctx)}. Run /typesafe-router doctor for an access report.`,
        "warning",
      );

      return;
    }

    if (result.reason !== "classified" || (selected.selectedIndex ?? 0) > 0)
      notify(
        ctx,
        `${route} → ${targetKey(selected.target)} (${result.reason}${(selected.selectedIndex ?? 0) > 0 ? "; fallback within the chain" : ""}).`,
        "warning",
      );
  }

  async function onInput(
    event: InputEvent,
    ctx: RouterContext,
  ): Promise<{ action: "continue" | "handled" }> {
    if (event.source === "extension" || event.streamingBehavior || !ctx.isIdle())
      return { action: "continue" };

    if (active) {
      notify(
        ctx,
        "Routing is already in progress; this submission continues on the current model.",
        "warning",
      );

      return { action: "continue" };
    }

    // An invalid or unreadable configuration disables automatic routing, never input.
    if (configError) {
      if (!configErrorNotified) {
        configErrorNotified = true;
        notify(
          ctx,
          "Router configuration is invalid or unreadable; automatic routing is skipped and the prompt continues on the current model. Repair the file and run /typesafe-router doctor.",
          "error",
        );
      }

      return { action: "continue" };
    }

    if (!config || mode === "off" || (ctx.mode !== "tui" && !config.allowHeadless))
      return { action: "continue" };

    const cfg = config;
    const startedAt = Date.now();
    const decisionId = newDecisionId();
    const { op, cleanup } = begin(ctx);
    let action: "continue" | "handled" = "continue";

    try {
      await routeSubmission(ctx, cfg, event, op, startedAt, decisionId);
    } catch {
      if (isCurrent(op))
        notify(
          ctx,
          `Routing could not complete; continuing on ${currentModelKey(ctx)} without switching models.`,
          "warning",
        );
    } finally {
      const cancelled = !isCurrent(op);
      const selectingTarget = op.phase === "selecting";
      cleanup();

      if (cancelled && !shuttingDown) {
        // A replacement session invalidates ctx. Never touch it after shutdown.
        try {
          restoreCancelled(ctx, event, selectingTarget);
        } catch {
          /* session disposed */
        }

        action = "handled";
      }
    }

    return { action };
  }

  function activity(ctx: RouterContext) {
    return active ? `${active.purpose}: ${active.phase}` : ctx.isIdle() ? "idle" : "Pi is running";
  }

  function currentModel(ctx: RouterContext) {
    return `current model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none selected"}`;
  }

  async function showStatus(ctx: RouterContext) {
    if (shuttingDown) return;
    const snapshotEpoch = epoch;
    let disk = "not compared while an operation is running; showing active configuration";

    if (!active) {
      try {
        const fresh = await readConfig(path);
        disk = !fresh
          ? "missing; run /typesafe-router doctor"
          : JSON.stringify(fresh) === JSON.stringify(config)
            ? "matches active configuration"
            : "unapplied changes; run /typesafe-router doctor";
      } catch {
        disk = "invalid or unreadable; run /typesafe-router doctor";
      }
    }

    if (shuttingDown) return;

    if (snapshotEpoch !== epoch)
      disk = "state changed during this status check; run status again to compare disk";

    const targets = config ? configuredTargets(config) : [];

    const lines = [
      "pi-typesafe-router: status",
      ...runtimeLines(mode, activity(ctx), path, config),
      `config: ${configError ? "invalid; automatic routing is skipped" : config ? "active in memory" : "not loaded"}`,
      `disk config: ${disk}`,
      currentModel(ctx),
      `generation proofs: ${proofs.validKeys(ctx.modelRegistry, targets).size} of ${targets.length} configured target(s) verified for this session; each selected route is probed on first use and a doctor run persists what it proved`,
      ...(config ? [provenanceLine(config)] : []),
    ];

    if (config) {
      for (const [route, targets] of Object.entries(config.routes))
        lines.push(`route ${route}: ${targets.map(targetKey).join(" → ")}`);
    }

    if (last)
      lines.push(
        `last decision (historical): ${last.route} → ${last.target ? targetKey(last.target) : (last.fallback ?? "no eligible model")}; ${last.reason}; ${last.milliseconds}ms${last.shadow ? " (shadow)" : ""}`,
      );
    else lines.push("last decision: none in this session");

    lines.push(HELP);
    notify(ctx, lines.join("\n"));
  }

  /** The audit identifiers a decision would record, shortened for display. */
  function provenanceLine(cfg: RouterConfig): string {
    return [
      `provenance: policy ${policy.id} ${policyHash(policy).slice(0, 12)} (${cfg.policyPath === undefined ? "bundled artifact" : "external policyPath"})`,
      `config ${configHash(cfg).slice(0, 12)}`,
      `candidates ${candidateSnapshotHash(cfg.routes).slice(0, 12)}`,
    ].join("; ");
  }

  async function doctor(ctx: RouterContext, live: boolean) {
    const { op, cleanup } = begin(ctx, "doctor");

    // A local run makes no request, so it must not discard proofs a live run earned. A live
    // run tombstones the branch first, so a failure cannot leave an older success restorable.
    if (live) invalidateProofs();
    op.phase = "loading";

    function progress(message: string) {
      if (!isCurrent(op)) return;

      if (ctx.hasUI && ctx.mode === "tui")
        ctx.ui.setWidget(`${NAME}-doctor-progress`, [message], { placement: "aboveEditor" });
      else notify(ctx, message);
    }

    progress("Checking configuration…");
    notify(
      ctx,
      live
        ? "Checks use synthetic requests and may incur charges; no conversation history or tools."
        : "Local checks only: configuration, catalogue, scope, and provenance. No classifier or generation request is made.",
    );
    let applied = false;

    try {
      let loaded: RouterConfig | undefined;
      let invalidConfig = false;
      let invalidPolicy = false;

      try {
        loaded = await abortable(() => readConfig(path), op.controller.signal);
      } catch {
        if (!isCurrent(op)) return;
        invalidConfig = true;
      }

      if (!isCurrent(op)) return;

      if (loaded && !invalidConfig) {
        try {
          policy = await resolvePolicy(loaded.policyPath, op.controller.signal);
        } catch {
          if (!isCurrent(op)) return;
          invalidPolicy = true;
          invalidConfig = true;
        }
      } else policy = POLICY;

      if (!isCurrent(op)) return;

      config = invalidConfig ? undefined : loaded;
      configError = invalidConfig;
      configErrorNotified = true;
      last = undefined;
      generationFailed = false;

      if (!loaded || invalidConfig) {
        mode = "off";
        pi.appendEntry(`${NAME}-mode`, { mode });

        const reason = invalidPolicy
          ? "invalid or unreadable; the configured policyPath could not be loaded"
          : invalidConfig
            ? "invalid or unreadable; not applied"
            : "missing";

        notify(
          ctx,
          [
            "pi-typesafe-router: ❌",
            ...runtimeLines(mode, "idle", path),
            `config: ${reason}`,
            currentModel(ctx),
            "classifier check: skipped; no valid configuration",
            invalidConfig
              ? "next: fix the configuration JSON, fields, or file permissions, then run /typesafe-router doctor"
              : `next: /typesafe-router setup typesafe (or ${BACKEND_TYPES.slice(1).join("/")}), then /typesafe-router doctor`,
          ].join("\n"),
          "error",
        );

        return;
      }

      applied = true;
      const checks = eligibility(ctx, loaded);

      const checkedRoutes = {
        quick: candidateChecks(loaded.routes.quick, checks),
        standard: candidateChecks(loaded.routes.standard, checks),
        deep: candidateChecks(loaded.routes.deep, checks),
      };

      const blockedRoutes = Object.values(checkedRoutes).some(
        (candidates) => !candidates.some((candidate) => candidate.eligible),
      );

      if (!live) {
        const localReady = !blockedRoutes;

        notify(
          ctx,
          [
            `pi-typesafe-router: ${localReady ? "✅" : "❌"}`,
            ...runtimeLines(mode, "idle", path, loaded),
            currentModel(ctx),
            `context usage: ${checks.inputTokens === null ? "unknown after compaction; size check deferred to Pi" : `${checks.inputTokens} tokens`}`,
            provenanceLine(loaded),
            `checks: local only; no classifier or generation request was made in this run`,
            ...routeLines(checkedRoutes, []),
            ...(localReady
              ? []
              : [
                  "next: fix the model IDs, provider credentials, or scope for the blocked route, then run /typesafe-router doctor local again",
                ]),
          ].join("\n"),
          localReady ? "info" : "warning",
        );

        return;
      }

      op.phase = "probing";
      const fingerprint = verificationFingerprint(loaded, ctx.modelRegistry);
      const targets = configuredTargets(loaded);
      const total = targets.length + 1;
      let completed = 0;
      progress(`Checking model access… (0/${total} complete)`);

      function completedProbe() {
        completed++;
        progress(`Checking model access… (${completed}/${total} complete)`);
      }

      async function checkClassifier(cfg: RouterConfig) {
        const started = Date.now();

        const result = await evaluate(
          ctx,
          cfg,
          "Hello. Explain what a variable is in one sentence.",
          op,
          true,
        );

        const milliseconds = Date.now() - started;
        completedProbe();

        return { result, milliseconds };
      }

      const generationTimeoutMs = loaded.generationProbeTimeoutMs;

      const [classifier, probes] = await Promise.all([
        checkClassifier(loaded),
        Promise.all(
          targets.map(async (target) => {
            const probe = await abortable(
              () =>
                probeGeneration(
                  ctx.modelRegistry,
                  target,
                  op.controller.signal,
                  generationTimeoutMs,
                ),
              op.controller.signal,
            );

            completedProbe();

            return probe;
          }),
        ),
      ]);

      const { result, milliseconds: classifierElapsed } = classifier;

      if (!isCurrent(op)) return;

      const passed = new Set(
        probes.flatMap((probe) => (probe.passed ? [targetKey(probe.target)] : [])),
      );

      const currentChecks = eligibility(ctx, loaded);

      const missingRoutes = Object.entries(loaded.routes).flatMap(([route, targets]) =>
        candidateChecks(targets, currentChecks).some(
          (candidate) => candidate.eligible && passed.has(targetKey(candidate.target)),
        )
          ? []
          : [route],
      );

      const latest = await abortable(() => readConfig(path), op.controller.signal);

      if (!isCurrent(op)) return;

      // The applied rubric is file state too: a policy edited during the probes would
      // otherwise let a proof describe a rubric this run did not measure.
      let policyUnchanged = false;

      if (latest) {
        try {
          const latestPolicy = await resolvePolicy(latest.policyPath, op.controller.signal);

          policyUnchanged = policyHash(latestPolicy) === policyHash(policy);
        } catch {
          if (!isCurrent(op)) return;
        }
      }

      const unchanged =
        !!latest &&
        policyUnchanged &&
        JSON.stringify(latest) === JSON.stringify(loaded) &&
        fingerprint === verificationFingerprint(loaded, ctx.modelRegistry);

      const ready = !!result.classification && missingRoutes.length === 0 && unchanged;

      // Publish proofs only after the configuration and registry are revalidated. Until this
      // synchronous point, cancellation or a changed fingerprint leaves the store empty. A
      // partial doctor run keeps its in-memory proofs but persists nothing, so a branch can
      // only restore a session that fully succeeded.
      if (unchanged) {
        for (const probe of probes)
          if (probe.passed) proofs.remember(probe.target, ctx.modelRegistry);

        if (ready) persistProofs();
      }

      const lines = [
        `pi-typesafe-router: ${ready ? "✅" : "❌"}`,
        ...runtimeLines(mode, "idle", path, loaded, []),
        currentModel(ctx),
        `context usage: ${checks.inputTokens === null ? "unknown after compaction; size check deferred to Pi" : `${checks.inputTokens} tokens`}`,
        provenanceLine(loaded),
        `generation proofs: ${proofs.size} of ${targets.length} configured target(s) verified for this session`,
        ...classifierLines(result, classifierElapsed, loaded),
        ...routeLines(checkedRoutes, probes),
      ];

      if (!unchanged)
        lines.push(
          "next: configuration or credential references changed during doctor; run /typesafe-router doctor again",
        );
      else if (missingRoutes.length)
        lines.push(
          `next: no eligible probed model for ${missingRoutes.join(", ")}; fix model IDs, provider credentials, or access and run /typesafe-router doctor`,
        );
      else if (blockedRoutes)
        lines.push(
          "next: fix the blocked route mappings or generation credentials, then run /typesafe-router doctor",
        );
      else if (result.classification && ctx.mode !== "tui" && !loaded.allowHeadless)
        lines.push("routing outside TUI: disabled (allowHeadless is false)");

      progress("Checks complete");
      notify(ctx, lines.join("\n"), ready ? "info" : "warning");
    } catch {
      if (isCurrent(op))
        notify(
          ctx,
          `pi-typesafe-router: ❌\nconfig: ${applied ? "applied" : "not applied"}\nrouting: ${mode}\nchecks: incomplete; no generation proof was recorded\nnext: inspect the configuration and Pi model catalogue, then run /typesafe-router doctor again`,
          "error",
        );
    } finally {
      const cancelled = !isCurrent(op);
      op.controller.abort();

      if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget(`${NAME}-doctor-progress`, undefined);
      cleanup();

      if (cancelled && !shuttingDown)
        notify(
          ctx,
          `pi-typesafe-router: doctor cancelled\nconfig: ${applied ? "applied before cancellation" : "not applied"}\nrouting: ${mode}\nchecks: cancelled; ${live ? "recorded proofs were discarded" : "existing proofs were unchanged"}`,
          "warning",
        );
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;

    if (!(await reload(ctx))) return;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === `${NAME}-mode`) {
        const parsed = sessionModeSchema.safeParse(entry.data);

        if (parsed.success && config && !configError) mode = parsed.data.mode;
      }
    }

    restoreProofs(ctx);
    status(ctx);
  });
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    proofs.clear();
    configErrorNotified = false;
    cancel();
    // A late auth result must settle before Pi tears down this extension runtime.
    await active?.done;
    last = undefined;
    lastStartedAt = undefined;
    pendingOutcome = undefined;
    generationFailed = false;
  });

  const beforeNavigation = (
    _event: SessionBeforeSwitchEvent | SessionBeforeForkEvent | SessionBeforeTreeEvent,
    ctx: RouterContext,
  ) => {
    if (!active) return;
    cancel();
    notify(
      ctx,
      "Operation cancelled. Wait for it to settle, then repeat session navigation.",
      "warning",
    );

    return { cancel: true };
  };

  pi.on("session_before_switch", beforeNavigation);
  pi.on("session_before_fork", beforeNavigation);
  pi.on("session_before_tree", beforeNavigation);
  pi.on("session_tree", (_event, ctx) => {
    setMode("off", ctx);
    // The new leaf may have a different verification history, so re-derive proofs from it.
    restoreProofs(ctx);
    last = undefined;
    lastStartedAt = undefined;
    pendingOutcome = undefined;
    generationFailed = false;
  });
  pi.on("input", async (event, ctx) => {
    try {
      return await onInput(event, ctx);
    } catch {
      // Pi catches thrown hook errors and continues either way. Fail open: a router fault
      // must never consume the user's prompt.
      try {
        notify(ctx, "Router preflight failed; the prompt continues on the current model.", "error");
      } catch {
        /* disposed UI */
      }

      return { action: "continue" };
    }
  });
  pi.on("model_select", (event, ctx) => {
    if (selecting === `${event.model.provider}/${event.model.id}` && event.source === "set") return;
    last = undefined;
    lastStartedAt = undefined;
    pendingOutcome = undefined;
    generationFailed = false;

    if (mode !== "off" || active) {
      setMode("off", ctx);
      notify(ctx, "External model selection: automatic routing is now off.");
    } else cancel(); // Also invalidate pending enable dialogs while already off.
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const message = event.message;

    const routed =
      !last?.shadow &&
      last?.applied === true &&
      last.target !== undefined &&
      last.target.provider === message.provider &&
      last.target.model === message.model;

    // Only the first matching routed response opens an outcome, and later turns in the same
    // run only increment the count. One run therefore records one outcome entry.
    if (routed && last?.target) {
      const nextUsage = usageOf(message.usage);

      if (!pendingOutcome) {
        pendingOutcome = {
          decisionId: last.decisionId,
          provider: last.target.provider,
          model: last.target.model,
          configuredThinking: last.target.thinking,
          responses: 1,
          stopReason: message.stopReason,
          usage: nextUsage,
        };
      } else {
        pendingOutcome.responses += 1;
        pendingOutcome.stopReason = message.stopReason ?? pendingOutcome.stopReason;
        pendingOutcome.usage = addUsage(pendingOutcome.usage, nextUsage);
      }
    }

    generationFailed =
      message.stopReason === "error" &&
      !last?.shadow &&
      last?.target !== undefined &&
      last.target.provider === message.provider &&
      last.target.model === message.model;
  });
  pi.on("agent_settled", (_event, ctx) => {
    const settled = pendingOutcome;
    // An applied route with no recorded response settled before any assistant message was
    // observable, so Pi reports no stop reason for it. It is still one routed generation and
    // is recorded once, as aborted, rather than leaving the decision without an outcome.
    const appliedTarget = !last?.shadow && last?.applied === true ? last.target : undefined;
    const alreadyRecorded = last !== undefined && outcomeDecisionId === last.decisionId;

    if ((settled || appliedTarget) && !alreadyRecorded) {
      const outcomeInput: OutcomeInput = settled
        ? {
            decisionId: settled.decisionId,
            provider: settled.provider,
            model: settled.model,
            configuredThinking: settled.configuredThinking,
            status: outcomeStatus(settled.stopReason),
            stopReason: settled.stopReason,
            responses: settled.responses,
            usage: settled.usage,
          }
        : {
            decisionId: last!.decisionId,
            provider: appliedTarget!.provider,
            model: appliedTarget!.model,
            configuredThinking: appliedTarget!.thinking,
            status: "aborted",
            responses: 0,
          };

      pendingOutcome = undefined;

      if (lastStartedAt !== undefined)
        outcomeInput.elapsedSinceRoutingMs = Date.now() - lastStartedAt;

      const entry = buildOutcome(outcomeInput);

      // Operational completion only: never a statement about whether the work was correct.
      if (entry) {
        pi.appendEntry(OUTCOME_TYPE, entry);
        outcomeDecisionId = outcomeInput.decisionId;
      }
    }

    if (generationFailed && last?.target && !last.shadow)
      notify(
        ctx,
        "Generation failed after Pi's retries. The router did not switch models or replay the task. Use /model to select another model (this turns routing off), inspect completed tool effects, then explicitly continue.",
        "warning",
      );
  });

  pi.registerCommand(NAME, {
    description: "Configure routing, run doctor diagnostics, or view active settings",
    handler: async (args, ctx) => {
      const [command = "status", option, ...extra] = args.trim().split(/\s+/).filter(Boolean);

      const takesOption = command === "setup" || command === "doctor" || command === "feedback";

      const badDoctorOption =
        command === "doctor" && option !== undefined && option !== "local" && option !== "live";

      if (extra.length || (option && !takesOption) || badDoctorOption) {
        notify(ctx, HELP, "warning");

        return;
      }

      if (command === "help") {
        notify(ctx, COMMAND_HELP);

        return;
      }

      if (command === "off") {
        configError = false;
        setMode("off", ctx);
        notify(
          ctx,
          `routing: off${active ? "; cancellation requested; wait for the current operation to settle" : "; no automatic classifier requests will be sent"}`,
        );

        return;
      }

      if (["validate", "check", "reload", "cancel", "recover"].includes(command)) {
        notify(
          ctx,
          command === "recover"
            ? "Recovery command removed. Use /model to select a model, inspect completed tool effects, then explicitly continue. No message was sent."
            : command === "cancel"
              ? "Cancel command removed. Use Escape or /typesafe-router off to stop pending routing."
              : "Command removed. Use /typesafe-router doctor local for offline checks, or /typesafe-router doctor live for synthetic classifier and generation probes (may incur charges).",
          "warning",
        );

        return;
      }

      if (command === "status") {
        await showStatus(ctx);

        return;
      }

      if (active || shuttingDown || !ctx.isIdle()) {
        notify(
          ctx,
          "An operation is still running. Wait for it to finish, or use Escape /typesafe-router off to stop it.",
          "warning",
        );

        return;
      }

      if (command === "doctor") {
        await doctor(ctx, option !== "local");

        return;
      }

      if (command === "feedback") {
        // SAFETY: the `skip` comparison plus TASK_CLASSES membership is the whole domain of
        // this argument, so the narrowing is checked by the guard on the next line.
        const expected =
          option === "skip" || TASK_CLASSES.includes(option as TaskClass)
            ? (option as TaskClass | "skip")
            : undefined;

        if (!expected) {
          notify(ctx, HELP, "warning");

          return;
        }

        const decisionId = latestDecisionId(ctx.sessionManager.getBranch());

        if (!decisionId) {
          notify(
            ctx,
            "No routing decision in this session can receive feedback yet. Feedback binds to the newest decision on the active branch.",
            "warning",
          );

          return;
        }

        const entry = buildFeedback(decisionId, expected);

        if (!entry) {
          notify(
            ctx,
            "Feedback was not recorded: it did not match the telemetry schema.",
            "warning",
          );

          return;
        }

        pi.appendEntry(FEEDBACK_TYPE, entry);
        notify(
          ctx,
          `Feedback recorded for the latest decision (${expected === "skip" ? "skipped" : expected}). Routing behavior is unchanged.`,
        );

        return;
      }

      const commandEpoch = ++epoch;
      const permitted = () => commandEpoch === epoch && !active && !shuttingDown && ctx.isIdle();

      if (command === "setup") {
        if (!ctx.hasUI) {
          notify(
            ctx,
            `Copy an example to ${path} and configure model IDs. Setup requires UI.`,
            "warning",
          );

          return;
        }

        const backend =
          option ?? (await ctx.ui.select("Classification backend", [...BACKEND_TYPES]));

        if (!backend || !permitted()) return;

        if (!isBackendType(backend)) {
          notify(ctx, HELP, "warning");

          return;
        }

        const accountId =
          backend === "cloudflare"
            ? await ctx.ui.input("Cloudflare account ID (not an API token)")
            : undefined;

        if (!permitted() || (backend === "cloudflare" && !accountId)) return;

        const gatewayId =
          backend === "cloudflare"
            ? await ctx.ui.input("Cloudflare AI Gateway ID (gateway slug, not an API token)")
            : undefined;

        if (!permitted() || (backend === "cloudflare" && !gatewayId)) return;

        const models = ctx.modelRegistry
          .getAvailable()
          .filter((model) => !["auto", "smart-router", "typesafe-router"].includes(model.provider));

        const names = models.map((model) => `${model.provider}/${model.id}`);

        const selected = await ctx.ui.select(
          "Initial model for all routes (edit ordered mappings in the config later)",
          names,
        );

        if (!permitted()) return;
        const model = models[names.indexOf(selected ?? "")];

        if (!model) return;

        try {
          const target = { provider: model.provider, model: model.id, thinking: "high" as const };

          const initial = parseConfig({
            version: 2,
            historyRoles: ["user"],
            backend:
              backend === "cloudflare"
                ? { type: backend, accountId, gatewayId }
                : { type: backend },
            routes: { quick: [target], standard: [target], deep: [target] },
          });

          await createConfig(path, initial);

          if (!permitted() || !(await reload(ctx))) return;
          notify(
            ctx,
            `Created ${path}; routing is off. Set the backend credential environment variable, edit model mappings, then run /typesafe-router doctor and /typesafe-router on. Existing files are never overwritten.`,
          );
        } catch {
          notify(
            ctx,
            "Setup could not create config. It may already exist, the account ID may be invalid, or the directory may not be writable. No existing file was overwritten.",
            "error",
          );
        }

        return;
      }

      if (!config || configError) {
        notify(
          ctx,
          `Run /typesafe-router doctor to load and diagnose ${path}; use setup if no file exists.`,
          "error",
        );

        return;
      }

      if (command === "on" || command === "shadow") {
        if (ctx.mode !== "tui" && !config.allowHeadless) {
          notify(
            ctx,
            "Automatic routing is disabled in this interface. Set allowHeadless: true in config and run /typesafe-router doctor before enabling it.",
            "warning",
          );

          return;
        }

        if (
          ctx.hasUI &&
          !(await ctx.ui.confirm(
            `Enable ${command === "on" ? "automatic" : "shadow"} routing?`,
            disclosure(config),
          ))
        )
          return;

        if (!permitted()) return;

        setMode(command === "on" ? "auto" : "shadow", ctx);
        notify(ctx, `${mode} routing enabled for this session. ${disclosure(config)}`);

        return;
      }

      notify(ctx, HELP, "warning");
    },
  });
}

export default function typesafeRouter(pi: ExtensionAPI): void {
  registerRouter(pi);
}
