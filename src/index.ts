import { join } from "node:path";
import {
  buildSessionContext,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type InputEvent,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { classify as defaultClassify } from "./classifier.ts";
import { parseConfig } from "./config.ts";
import { estimateInputTokens, projectState } from "./context.ts";
import { candidateChecks, chooseRoute } from "./routing.ts";
import { abortable, createConfig, loadConfig } from "./settings.ts";
import {
  ClassifierError,
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
const DISCLOSURE =
  "Classification sends your request and bounded recent user/assistant text to the configured backend. Text can contain private code or secrets. Shadow mode also sends data and may incur charges. No automatic generation replay or classifier-backend failover.";
const HELP =
  "/typesafe-router setup [typesafe|cloudflare|vercel] | on | shadow | off | cancel | status | validate | check | recover | reload";
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
  phase: "classifying" | "selecting" | "loading";
  done: Promise<void>;
}
export interface Dependencies {
  configPath?: string;
  classify?: Classify;
  load?: (path: string) => Promise<RouterConfig | undefined>;
}

/** Register the extension; dependency overrides are for offline integration tests. */
export function registerRouter(pi: ExtensionAPI, dependencies: Dependencies = {}): void {
  const path = dependencies.configPath ?? join(getAgentDir(), "typesafe-router.json");
  const classify = dependencies.classify ?? defaultClassify;
  const readConfig = dependencies.load ?? loadConfig;
  let config: RouterConfig | undefined;
  let configError = false;
  let mode: Mode = "off";
  let epoch = 0;
  let active: Operation | undefined;
  let selecting: string | undefined;
  let last: Decision | undefined;
  let generationFailed = false;
  let shuttingDown = false;

  function notify(
    ctx: ExtensionContext,
    text: string,
    type: "info" | "warning" | "error" = "info",
  ) {
    if (ctx.hasUI) ctx.ui.notify(text, type);
    else process.stderr.write(`[${NAME}] ${text}\n`);
  }
  function status(ctx: ExtensionContext) {
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
  function setMode(next: Mode, ctx: ExtensionContext) {
    cancel();
    mode = next;
    pi.appendEntry(`${NAME}-mode`, { mode });
    status(ctx);
  }
  async function reload(ctx: ExtensionContext): Promise<boolean> {
    const { op, cleanup } = begin(ctx);
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
        `Invalid router configuration at ${path}. Routing is blocked until repaired or explicitly disabled.`,
        "error",
      );
      return true;
    } finally {
      cleanup();
    }
  }
  function contextMessages(ctx: ExtensionContext) {
    return buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId())
      .messages;
  }
  function eligibility(
    ctx: ExtensionContext,
    text = "",
    images: readonly unknown[] = [],
  ): Eligibility {
    const messages = contextMessages(ctx);
    const hasImage = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      if (Array.isArray(value)) return value.some(hasImage);
      const obj = value as Record<string, unknown>;
      return obj.type === "image" || Object.values(obj).some(hasImage);
    };
    return {
      models: ctx.modelRegistry.getAll(),
      available: ctx.modelRegistry.getAvailable(),
      scope: ctx.scopedModels.map(({ model }) => ({ provider: model.provider, model: model.id })),
      hasImages: images.length > 0 || hasImage(messages),
      inputTokens: estimateInputTokens(
        ctx.getSystemPrompt(),
        [...messages, { role: "user", content: text }, ...images],
        pi.getAllTools().filter((tool) => pi.getActiveTools().includes(tool.name)),
      ),
      outputReserveTokens: config!.outputReserveTokens,
    };
  }
  async function credential(
    ctx: ExtensionContext,
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
    ctx: ExtensionContext,
    cfg: RouterConfig,
    text: string,
    op: Operation,
    synthetic = false,
  ): Promise<{ classification?: Classification; reason: string }> {
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
        reason: timeout.signal.aborted
          ? "classifier-timeout"
          : error instanceof ClassifierError
            ? error.message
            : "classifier-unavailable",
      };
    } finally {
      clearTimeout(timer);
    }
  }
  async function select(
    ctx: ExtensionContext,
    targets: readonly Target[],
    checks: Eligibility,
    op: Operation,
  ): Promise<{ target?: Target; skipped: string[] }> {
    const skipped: string[] = [];
    for (const check of candidateChecks(targets, checks)) {
      if (!isCurrent(op)) return { skipped };
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
  function persist(ctx: ExtensionContext, decision: Decision) {
    last = decision;
    pi.appendEntry(`${NAME}-decision`, decision);
    status(ctx);
  }
  function begin(ctx: ExtensionContext): { op: Operation; cleanup: () => void } {
    if (active || shuttingDown || !ctx.isIdle())
      throw new Error("Router operation is no longer permitted");
    epoch++;
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const op: Operation = { controller: new AbortController(), epoch, phase: "classifying", done };
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
    ctx: ExtensionContext,
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
        "Router config is invalid. Repair it and reload, or /typesafe-router off to proceed without routing.",
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
      const result = await evaluate(ctx, cfg, event.text, op);
      if (!isCurrent(op)) return { action: "handled" };
      const route =
        result.reason === "insufficient-context"
          ? cfg.uncertainRoute
          : chooseRoute(result.classification, cfg);
      const checks = eligibility(ctx, event.text, event.images);
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
          "No eligible model in the selected route. Prompt was not submitted. Run /typesafe-router validate; select a model manually or repair the mapping.",
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
            "Routing cancelled; prompt was not submitted. Any in-flight Pi authentication may finish selecting a model; verify /model before resubmitting.",
            "warning",
          );
        } catch {
          /* session disposed */
        }
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;
    if (!(await reload(ctx))) return;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === `${NAME}-mode`) {
        const value = (entry.data as { mode?: unknown } | undefined)?.mode;
        if (value === "off" || value === "auto" || value === "shadow") mode = value;
      }
    }
    status(ctx);
  });
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    cancel();
    // A late auth result must settle before Pi tears down this extension runtime.
    await active?.done;
    last = undefined;
    generationFailed = false;
  });
  const beforeNavigation = (_event: unknown, ctx: ExtensionContext) => {
    if (!active) return;
    cancel();
    notify(
      ctx,
      "Routing cancelled. Wait for pending authentication to settle, then repeat session navigation.",
      "warning",
    );
    return { cancel: true };
  };
  pi.on("session_before_switch", beforeNavigation);
  pi.on("session_before_fork", beforeNavigation);
  pi.on("session_before_tree", beforeNavigation);
  pi.on("session_tree", (_event, ctx) => {
    setMode("off", ctx);
    last = undefined;
    generationFailed = false;
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
    } else cancel(); // Also invalidate pending enable/check dialogs while already off.
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant")
      generationFailed =
        event.message.stopReason === "error" &&
        !last?.shadow &&
        last?.target?.provider === event.message.provider &&
        last.target.model === event.message.model;
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (generationFailed && last?.target && !last.shadow)
      notify(
        ctx,
        "Generation failed after Pi recovery. No automatic model replay. /typesafe-router recover selects the next eligible candidate without sending a message; inspect completed tools before continuing.",
        "warning",
      );
  });

  pi.registerCommand(NAME, {
    description:
      "Configure Jev classification, validate model routes, or explicitly select a recovery model",
    handler: async (args, ctx) => {
      const [command = "status", option, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if (extra.length || (option && command !== "setup")) {
        notify(ctx, HELP, "warning");
        return;
      }
      if (command === "cancel" || command === "off") {
        if (command === "off") {
          configError = false;
          setMode("off", ctx);
        } else cancel();
        notify(
          ctx,
          command === "off"
            ? "Routing off. No classifier requests will be sent."
            : "Cancellation requested. No prompt will be submitted by the router.",
        );
        return;
      }
      if (active || shuttingDown || !ctx.isIdle()) {
        notify(ctx, "Wait for routing and Pi to settle first (or use cancel/off).", "warning");
        return;
      }
      const commandEpoch = ++epoch;
      const permitted = () => commandEpoch === epoch && !active && !shuttingDown && ctx.isIdle();
      if (command === "reload") {
        if (await reload(ctx))
          notify(ctx, "Router configuration reloaded. Check status before submitting.");
        return;
      }
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
          option ??
          (await ctx.ui.select("Classification backend", ["typesafe", "cloudflare", "vercel"]));
        if (!backend || !permitted()) return;
        if (!["typesafe", "cloudflare", "vercel"].includes(backend)) {
          notify(ctx, HELP, "warning");
          return;
        }
        const accountId =
          backend === "cloudflare"
            ? await ctx.ui.input("Cloudflare account ID (not an API token)")
            : undefined;
        if (!permitted() || (backend === "cloudflare" && !accountId)) return;
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
            backend: { type: backend, ...(accountId ? { accountId } : {}) },
            routes: { quick: [target], standard: [target], deep: [target] },
          });
          await createConfig(path, initial);
          if (!permitted() || !(await reload(ctx))) return;
          notify(
            ctx,
            `Created ${path}; routing is off. Set the backend credential environment variable, edit model mappings, then validate and enable. Existing files are never overwritten.`,
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
      if (command === "status") {
        notify(
          ctx,
          `Mode: ${mode}\nConfig: ${path}\nBackend: ${config?.backend.type ?? "not configured"}${configError ? " (invalid)" : ""}\n${last ? `Last: ${last.route} → ${last.target ? targetKey(last.target) : "no eligible model"}; ${last.reason}; ${last.milliseconds}ms${last.shadow ? " (shadow)" : ""}\nSkipped: ${last.skipped.join("; ") || "none"}` : "No decision this session."}\n${HELP}`,
        );
        return;
      }
      if (!config || configError) {
        notify(ctx, `Configure ${path} first, then reload.`, "error");
        return;
      }
      if (command === "on" || command === "shadow") {
        if (
          ctx.hasUI &&
          !(await ctx.ui.confirm(
            `Enable ${command === "on" ? "automatic" : "shadow"} routing?`,
            DISCLOSURE,
          ))
        )
          return;
        if (!permitted()) return;
        if (!ctx.hasUI && !config.allowHeadless) {
          notify(
            ctx,
            "Set allowHeadless: true explicitly before enabling headless classification.",
            "warning",
          );
          return;
        }
        setMode(command === "on" ? "auto" : "shadow", ctx);
        notify(ctx, `${mode} routing enabled for this session. ${DISCLOSURE}`);
        return;
      }
      if (command === "validate") {
        try {
          const fresh = await readConfig(path);
          if (!permitted()) return;
          if (!fresh) throw new Error("missing");
          const checks = { ...eligibility(ctx), outputReserveTokens: fresh.outputReserveTokens };
          const report = Object.entries(fresh.routes)
            .map(
              ([route, targets]) =>
                `${route}:\n${candidateChecks(targets, checks)
                  .map(
                    (check) =>
                      `  ${targetKey(check.target)}: ${check.eligible ? "eligible (not live-tested)" : check.reason}`,
                  )
                  .join("\n")}`,
            )
            .join("\n");
          notify(
            ctx,
            `${report}\nAuth presence and catalogue metadata are not remote health. Changes require reload. Classifier auth: ${fresh.backend.auth.source === "env" ? (process.env[fresh.backend.auth.variable]?.trim() ? "environment value present (not verified)" : "environment value missing") : "Pi-managed; resolved only for explicit requests"}.`,
          );
        } catch {
          notify(
            ctx,
            "Config validation failed. Check required fields, types and bounds. No credentials were tested.",
            "error",
          );
        }
        return;
      }
      if (command === "check") {
        if (
          ctx.hasUI &&
          !(await ctx.ui.confirm(
            "Run a paid/networked classifier check?",
            "Sends a synthetic greeting only. Does not test generation models or send session history.",
          ))
        )
          return;
        if (!permitted()) return;
        const { op, cleanup } = begin(ctx);
        try {
          const result = await evaluate(
            ctx,
            config,
            "Hello. Explain what a variable is in one sentence.",
            op,
            true,
          );
          if (isCurrent(op))
            notify(
              ctx,
              result.classification
                ? `Classifier check succeeded: ${result.classification.choice}; confidence ${result.classification.confidence ?? "unavailable"}. This is not a quality benchmark.`
                : `Classifier check failed: ${result.reason}`,
              result.classification ? "info" : "warning",
            );
        } catch {
          /* explicit cancellation */
        } finally {
          cleanup();
        }
        return;
      }
      if (command === "recover") {
        if (!last?.target || last.shadow || !generationFailed) {
          notify(
            ctx,
            "No failed routed generation to recover. Select /model manually if needed.",
            "warning",
          );
          return;
        }
        const chain = config.routes[last.route];
        const at = chain.findIndex((target) => targetKey(target) === targetKey(last!.target!));
        if (at < 0) {
          notify(
            ctx,
            "Previous model is no longer in this route; select /model manually.",
            "warning",
          );
          return;
        }
        const { op, cleanup } = begin(ctx);
        try {
          const selected = await select(ctx, chain.slice(at + 1), eligibility(ctx), op);
          if (!isCurrent(op)) return;
          if (!selected.target) {
            notify(ctx, "No later eligible candidate. No message sent.", "warning");
            return;
          }
          last = { ...last, ...selected, reason: "explicit-recovery" };
          // Prevent the next user continuation from immediately rerouting back to the failed model.
          mode = "off";
          pi.appendEntry(`${NAME}-mode`, { mode });
          persist(ctx, last);
          generationFailed = false;
          notify(
            ctx,
            `Selected ${targetKey(selected.target)}. Routing is off. No message sent. Inspect completed tools and explicitly continue when ready.`,
          );
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
