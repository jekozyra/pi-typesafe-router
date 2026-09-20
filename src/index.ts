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
import type { ImageContent } from "@earendil-works/pi-ai";
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
  configuredTargets,
  verificationFingerprint,
  type VerifiedGeneration,
} from "./verification.ts";
import { classifierLines, routeLines, runtimeLines, type EvaluationResult } from "./diagnostics.ts";
import { abortable, createConfig, loadConfig } from "./settings.ts";
import {
  BACKEND_TYPES,
  ClassifierError,
  isBackendType,
  targetKey,
  type Classification,
  type Classify,
  type Eligibility,
  type Mode,
  type Route,
  type RouterConfig,
  type Target,
} from "./types.ts";

const NAME = "typesafe-router";

const sessionModeSchema = z.object({ mode: z.enum(["off", "auto", "shadow"]) });

const verificationEntrySchema = z.discriminatedUnion("verified", [
  z.object({ verified: z.literal(false) }).strict(),
  z
    .object({
      verified: z.literal(true),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
      passed: z.array(z.string().min(1).max(1025)).max(24),
      checkedAt: z.iso.datetime(),
    })
    .strict(),
]);

const DISCLOSURE =
  "Classification sends your request and bounded recent user/assistant text to the configured backend. Text can contain private code or secrets. Shadow mode also sends data and may incur charges. No automatic generation replay or classifier-backend failover.";

const BACKEND_HELP = BACKEND_TYPES.join("|");

const HELP = `/typesafe-router setup [${BACKEND_HELP}] | doctor | status | on | shadow | off | help`;

const COMMAND_HELP = `Usage: /typesafe-router <command>

Command                              Description
---------------                      ------------------------------------
setup [${BACKEND_HELP}] Create a config interactively.
doctor                               Apply and validate config..
status                               Show current settings and activity.
on                                   Enable automatic routing.
shadow                               Classify without switching models.
off                                  Disable routing.
help                                 Show this table.`;

interface Decision {
  route: Route;
  target?: Target;
  reason: string;
  skipped: string[];
  backend: string;
  milliseconds: number;
  classification?: Classification;
  shadow: boolean;
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
  let verified: VerifiedGeneration | undefined;
  let config: RouterConfig | undefined;
  let configError = false;
  let mode: Mode = "off";
  let epoch = 0;
  let active: Operation | undefined;
  let selecting: string | undefined;
  let last: Decision | undefined;
  let generationFailed = false;
  let shuttingDown = false;

  function notify(ctx: RouterContext, text: string, type: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI) ctx.ui.notify(text, type);
    else process.stderr.write(`[${NAME}] ${text}\n`);
  }

  function status(ctx: RouterContext) {
    if (!ctx.hasUI) return;

    const label = mode === "auto" ? "on" : mode;

    const detail = active
      ? active.phase
      : mode !== "off" && !verified
        ? "doctor required"
        : last
          ? `last: ${last.route} → ${last.target ? targetKey(last.target) : "no eligible model"}`
          : undefined;

    ctx.ui.setStatus(NAME, `router: ${label}${detail ? ` · ${detail}` : ""}`);
  }

  function invalidateVerification() {
    verified = undefined;
    pi.appendEntry(`${NAME}-verification`, { verified: false });
  }

  function persistVerification(next: VerifiedGeneration) {
    verified = next;
    pi.appendEntry(`${NAME}-verification`, {
      verified: true,
      fingerprint: next.fingerprint,
      passed: [...next.passed],
      checkedAt: next.checkedAt,
    });
  }

  function restoreVerification(ctx: RouterContext) {
    verified = undefined;
    let persisted: z.infer<typeof verificationEntrySchema> | undefined;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== `${NAME}-verification`) continue;
      const parsed = verificationEntrySchema.safeParse(entry.data);
      persisted = parsed.success ? parsed.data : { verified: false };
    }

    if (!persisted?.verified || !config || configError) return;
    const fingerprint = verificationFingerprint(config, ctx.modelRegistry);

    if (persisted.fingerprint !== fingerprint) {
      invalidateVerification();

      return;
    }

    verified = {
      fingerprint,
      passed: new Set(persisted.passed),
      checkedAt: persisted.checkedAt,
    };
  }

  function cancel() {
    epoch++;
    active?.controller.abort();
  }

  function isCurrent(op: Operation) {
    return op.epoch === epoch && !op.controller.signal.aborted;
  }

  function setMode(next: Mode, ctx: RouterContext) {
    cancel();
    mode = next;
    pi.appendEntry(`${NAME}-mode`, { mode });
    status(ctx);
  }

  async function reload(ctx: RouterContext): Promise<boolean> {
    verified = undefined;
    const { op, cleanup } = begin(ctx, "config");
    op.phase = "loading";
    status(ctx);

    try {
      const loaded = await abortable(() => readConfig(path), op.controller.signal);

      if (!isCurrent(op) || shuttingDown) return false;
      config = loaded;
      configError = false;
      mode = loaded?.mode ?? "off";
      last = undefined;
      generationFailed = false;

      return true;
    } catch {
      if (!isCurrent(op) || shuttingDown) return false;
      config = undefined;
      configError = true;
      mode = "off";
      last = undefined;
      generationFailed = false;
      notify(
        ctx,
        `Invalid router configuration at ${path}. Routing is blocked. Repair the file and run /typesafe-router doctor, or use /typesafe-router off to proceed without routing.`,
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
      scope: ctx.scopedModels.map(({ model }) => ({ provider: model.provider, model: model.id })),
      hasImages: images.length > 0 || historyHasImages,
      inputTokens: contextInputTokens(
        ctx.getContextUsage(),
        messages,
        text || images.length
          ? { role: "user", content: [{ type: "text", text }, ...images], timestamp: Date.now() }
          : undefined,
      ),
      outputReserveTokens: config!.outputReserveTokens,
    };
  }

  function verificationStatus(ctx: RouterContext) {
    if (!verified || !config) return "not verified; run /typesafe-router doctor before routing";

    if (verified.fingerprint !== verificationFingerprint(config, ctx.modelRegistry))
      return "stale; model or credential references changed; run /typesafe-router doctor";

    return `verified at ${verified.checkedAt}; availability is a snapshot, not a guarantee`;
  }

  async function requireVerification(ctx: RouterContext, cfg: RouterConfig, op: Operation) {
    try {
      if (!verified) {
        notify(
          ctx,
          "Routing blocked: run /typesafe-router doctor successfully before routing. Every route needs a verified generation model.",
          "warning",
        );

        return false;
      }

      const fresh = await abortable(() => readConfig(path), op.controller.signal);

      if (!isCurrent(op)) return false;

      if (
        !fresh ||
        JSON.stringify(fresh) !== JSON.stringify(cfg) ||
        verified.fingerprint !== verificationFingerprint(cfg, ctx.modelRegistry)
      ) {
        invalidateVerification();
        notify(
          ctx,
          "Routing blocked: configuration, model mappings, or credential references changed. Run /typesafe-router doctor again.",
          "warning",
        );

        return false;
      }

      const current = eligibility(ctx);

      const blocked = Object.entries(cfg.routes).flatMap(([route, targets]) =>
        candidateChecks(targets, current).some(
          (candidate) => candidate.eligible && verified?.passed.has(targetKey(candidate.target)),
        )
          ? []
          : [route],
      );

      if (blocked.length) {
        notify(
          ctx,
          `Routing blocked: no currently eligible verified model for ${blocked.join(", ")}. Check model scope, credentials, and context size with /typesafe-router doctor.`,
          "warning",
        );

        return false;
      }

      return true;
    } catch {
      if (isCurrent(op)) {
        invalidateVerification();
        notify(
          ctx,
          "Routing blocked: configuration or verification could not be checked. Run /typesafe-router doctor.",
          "error",
        );
      }

      return false;
    }
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
    const history = synthetic
      ? []
      : ctx.sessionManager
          .buildContextEntries()
          .flatMap((entry) =>
            entry.type === "message" &&
            (entry.message.role === "user" || entry.message.role === "assistant")
              ? [entry.message]
              : [],
          );

    const state = projectState(text, history, cfg.maxContextChars, cfg.historyMessages);

    if (!state || (!synthetic && text.trimStart().startsWith("/")))
      return { reason: "insufficient-context" };
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), cfg.timeoutMs);
    const signal = AbortSignal.any([timeout.signal, op.controller.signal]);

    try {
      const apiKey = await credential(ctx, cfg, signal);

      const classification = await abortable(
        () => classify(cfg.backend, state, { signal, apiKey }),
        signal,
      );

      return {
        classification,
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
          ? "classifier-timeout"
          : error instanceof ClassifierError
            ? new ClassifierError(error.code, error.status).message
            : "classifier-unavailable",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function select(
    ctx: RouterContext,
    targets: readonly Target[],
    checks: Eligibility,
    op: Operation,
  ): Promise<{ target?: Target; skipped: string[] }> {
    const skipped: string[] = [];

    for (const check of candidateChecks(targets, checks)) {
      if (!isCurrent(op)) return { skipped };

      if (!verified?.passed.has(targetKey(check.target))) {
        skipped.push(`${targetKey(check.target)}: generation probe not passed`);
        continue;
      }

      if (!check.eligible) {
        skipped.push(`${targetKey(check.target)}: ${check.reason}`);
        continue;
      }

      const model = ctx.modelRegistry.find(check.target.provider, check.target.model);

      if (!model) {
        skipped.push(`${targetKey(check.target)}: disappeared`);
        continue;
      }

      op.phase = "selecting";
      status(ctx);
      selecting = targetKey(check.target);

      try {
        // Pi's setter is not cancellable. Await it; never race another selection against it.
        const selected = await pi.setModel(model);

        if (!isCurrent(op)) return { skipped };

        if (selected) return { target: check.target, skipped };
        skipped.push(`${targetKey(check.target)}: auth-not-configured`);
      } catch {
        skipped.push(`${targetKey(check.target)}: selection-failed`);
      } finally {
        selecting = undefined;
      }
    }

    return { skipped };
  }

  function persist(ctx: RouterContext, decision: Decision) {
    last = decision;
    pi.appendEntry(`${NAME}-decision`, decision);
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

  async function onInput(
    event: InputEvent,
    ctx: RouterContext,
  ): Promise<{ action: "continue" | "handled" }> {
    if (active) {
      notify(
        ctx,
        "Routing is already in progress. This submission was not queued; submit it again after routing settles.",
        "warning",
      );

      return { action: "handled" };
    }

    if (event.source === "extension" || event.streamingBehavior || !ctx.isIdle())
      return { action: "continue" };

    if (configError) {
      notify(
        ctx,
        "Router config is invalid. Repair it and run /typesafe-router doctor, or /typesafe-router off to proceed without routing.",
        "error",
      );

      return { action: "handled" };
    }

    if (!config || mode === "off" || (ctx.mode !== "tui" && !config.allowHeadless))
      return { action: "continue" };
    const cfg = config;
    const started = Date.now();
    const { op, cleanup } = begin(ctx);

    try {
      if (!(await requireVerification(ctx, cfg, op))) return { action: "handled" };
      const result = await evaluate(ctx, cfg, event.text, op);

      if (!isCurrent(op)) return { action: "handled" };

      const route =
        result.reason === "insufficient-context"
          ? cfg.uncertainRoute
          : chooseRoute(result.classification, cfg);

      const checks = eligibility(ctx, event.text, event.images);
      checks.available = checks.available.filter((model) =>
        verified?.passed.has(`${model.provider}/${model.id}`),
      );

      const selected =
        mode === "shadow"
          ? {
              target: candidateChecks(cfg.routes[route], checks).find((check) => check.eligible)
                ?.target,
              skipped: candidateChecks(cfg.routes[route], checks)
                .filter((check) => !check.eligible)
                .map((check) => `${targetKey(check.target)}: ${check.reason}`),
            }
          : await select(ctx, cfg.routes[route], checks, op);

      if (!isCurrent(op)) return { action: "handled" };

      if (!(await requireVerification(ctx, cfg, op))) return { action: "handled" };
      persist(ctx, {
        ...selected,
        ...result,
        route,
        backend: cfg.backend.type,
        milliseconds: Date.now() - started,
        shadow: mode === "shadow",
      });
      generationFailed = false;

      if (mode === "shadow") return { action: "continue" };

      if (!selected.target) {
        notify(
          ctx,
          "No eligible model in the selected route. Prompt was not submitted. Run /typesafe-router doctor; select a model manually or repair the mapping.",
          "error",
        );

        return { action: "handled" };
      }

      if (result.reason !== "classified" || selected.skipped.length)
        notify(
          ctx,
          `${route} → ${targetKey(selected.target)} (${result.reason}${selected.skipped.length ? "; preflight fallback" : ""}).`,
          "warning",
        );

      return { action: "continue" };
    } catch {
      if (isCurrent(op))
        notify(
          ctx,
          "Routing failed safely; prompt was not submitted. Check configuration or turn routing off.",
          "error",
        );

      return { action: "handled" };
    } finally {
      const cancelled = !isCurrent(op);
      cleanup();

      if (cancelled && !shuttingDown) {
        // A replacement session invalidates ctx. Never touch it after shutdown.
        try {
          status(ctx);
          notify(
            ctx,
            op.phase === "selecting"
              ? "Routing cancelled; prompt was not submitted. Pi authentication finished settling; verify /model before resubmitting."
              : "Routing cancelled; prompt was not submitted. Submit it again when ready.",
            "warning",
          );
        } catch {
          /* session disposed */
        }
      }
    }
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

    const lines = [
      "pi-typesafe-router: status",
      ...runtimeLines(mode, activity(ctx), path, config),
      `config: ${configError ? "invalid; automatic routing blocked" : config ? "active in memory" : "not loaded"}`,
      `disk config: ${disk}`,
      currentModel(ctx),
      `generation verification: ${disk.startsWith("unapplied") || disk.startsWith("invalid") || disk.startsWith("missing") ? "stale; run /typesafe-router doctor" : verificationStatus(ctx)}`,
    ];

    if (config) {
      for (const [route, targets] of Object.entries(config.routes))
        lines.push(`route ${route}: ${targets.map(targetKey).join(" → ")}`);
    }

    if (last)
      lines.push(
        `last decision (historical): ${last.route} → ${last.target ? targetKey(last.target) : "no eligible model"}; ${last.reason}; ${last.milliseconds}ms${last.shadow ? " (shadow)" : ""}`,
      );
    else lines.push("last decision: none in this session");

    lines.push(HELP);
    notify(ctx, lines.join("\n"));
  }

  async function doctor(ctx: RouterContext) {
    const { op, cleanup } = begin(ctx, "doctor");
    invalidateVerification();
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
      "Checks use synthetic requests and may incur charges; no conversation history or tools.",
    );
    let applied = false;

    try {
      let loaded: RouterConfig | undefined;
      let invalidConfig = false;

      try {
        loaded = await abortable(() => readConfig(path), op.controller.signal);
      } catch {
        if (!isCurrent(op)) return;
        invalidConfig = true;
      }

      if (!isCurrent(op)) return;
      config = loaded;
      configError = invalidConfig;
      last = undefined;
      generationFailed = false;

      if (!loaded) {
        mode = "off";
        pi.appendEntry(`${NAME}-mode`, { mode });
        notify(
          ctx,
          [
            "pi-typesafe-router: ❌",
            ...runtimeLines(mode, "idle", path),
            `config: ${invalidConfig ? "invalid or unreadable; not applied" : "missing"}`,
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
      const checks = eligibility(ctx);

      const checkedRoutes = {
        quick: candidateChecks(loaded.routes.quick, checks),
        standard: candidateChecks(loaded.routes.standard, checks),
        deep: candidateChecks(loaded.routes.deep, checks),
      };

      const blockedRoutes = Object.values(checkedRoutes).some(
        (candidates) => !candidates.some((candidate) => candidate.eligible),
      );

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

      const currentChecks = eligibility(ctx);

      const missingRoutes = Object.entries(loaded.routes).flatMap(([route, targets]) =>
        candidateChecks(targets, currentChecks).some(
          (candidate) => candidate.eligible && passed.has(targetKey(candidate.target)),
        )
          ? []
          : [route],
      );

      const latest = await abortable(() => readConfig(path), op.controller.signal);

      if (!isCurrent(op)) return;

      const unchanged =
        !!latest &&
        JSON.stringify(latest) === JSON.stringify(loaded) &&
        fingerprint === verificationFingerprint(loaded, ctx.modelRegistry);

      const ready = !!result.classification && missingRoutes.length === 0 && unchanged;

      if (ready) persistVerification({ fingerprint, passed, checkedAt: new Date().toISOString() });

      const lines = [
        `pi-typesafe-router: ${ready ? "✅" : "❌"}`,
        ...runtimeLines(mode, "idle", path, loaded, []),
        currentModel(ctx),
        `context usage: ${checks.inputTokens === null ? "unknown after compaction; size check deferred to Pi" : `${checks.inputTokens} tokens`}`,
        ...classifierLines(result, classifierElapsed, loaded),
        ...routeLines(checkedRoutes, probes),
      ];

      if (!unchanged)
        lines.push(
          "next: configuration or credential references changed during doctor; run /typesafe-router doctor again",
        );
      else if (missingRoutes.length)
        lines.push(
          `next: no verified eligible model for ${missingRoutes.join(", ")}; fix model IDs, provider credentials, or access and run /typesafe-router doctor`,
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
          `pi-typesafe-router: ❌\nconfig: ${applied ? "applied" : "not applied"}\nrouting: ${mode}\nchecks: incomplete; routing verification was not granted\nnext: inspect the configuration and Pi model catalogue, then run /typesafe-router doctor again`,
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
          `pi-typesafe-router: doctor cancelled\nconfig: ${applied ? "applied before cancellation" : "not applied"}\nrouting: ${mode}\nchecks: cancelled; routing verification was not granted`,
          "warning",
        );
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;

    if (!(await reload(ctx))) return;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== `${NAME}-mode`) continue;
      const parsed = sessionModeSchema.safeParse(entry.data);

      if (parsed.success && config && !configError) mode = parsed.data.mode;
    }

    restoreVerification(ctx);
    status(ctx);
  });
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    verified = undefined;
    cancel();
    // A late auth result must settle before Pi tears down this extension runtime.
    await active?.done;
    last = undefined;
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
    restoreVerification(ctx);
    last = undefined;
    generationFailed = false;
    setMode("off", ctx);
  });
  pi.on("input", async (event, ctx) => {
    try {
      return await onInput(event, ctx);
    } catch {
      // Pi catches thrown hook errors and continues. Return handled, never throw.
      try {
        notify(ctx, "Router preflight failed; prompt was not submitted.", "error");
      } catch {
        /* disposed UI */
      }

      return { action: "handled" };
    }
  });
  pi.on("model_select", (event, ctx) => {
    if (selecting === `${event.model.provider}/${event.model.id}` && event.source === "set") return;
    last = undefined;
    generationFailed = false;

    if (mode !== "off" || active) {
      setMode("off", ctx);
      notify(ctx, "External model selection: automatic routing is now off.");
    } else {
      cancel(); // Also invalidate pending enable dialogs while already off.
      status(ctx);
    }
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant")
      generationFailed =
        event.message.stopReason === "error" &&
        !last?.shadow &&
        last?.target !== undefined &&
        last.target.provider === event.message.provider &&
        last.target.model === event.message.model;
  });
  pi.on("agent_settled", (_event, ctx) => {
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

      if (extra.length || (option && command !== "setup")) {
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
              : "Command removed. Use /typesafe-router doctor to refresh configuration and run local checks plus an automatic synthetic classifier test (may incur charges).",
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
        await doctor(ctx);

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
          const target = { provider: model.provider, model: model.id };

          const initial = parseConfig({
            version: 1,
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
            DISCLOSURE,
          ))
        )
          return;

        if (!permitted()) return;

        const { op, cleanup } = begin(ctx, "config");

        try {
          if (!(await requireVerification(ctx, config, op)) || !isCurrent(op)) return;
          setMode(command === "on" ? "auto" : "shadow", ctx);
          notify(ctx, `${mode} routing enabled for this session. ${DISCLOSURE}`);
        } finally {
          cleanup();
        }

        return;
      }

      notify(ctx, HELP, "warning");
    },
  });
}

export default function typesafeRouter(pi: ExtensionAPI): void {
  registerRouter(pi);
}
