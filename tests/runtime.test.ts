import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, it } from "node:test";
import {
  estimateTokens,
  type ExtensionAPI,
  type ExtensionContext,
  type InputEvent,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { z } from "zod";

import {
  registerRouter,
  type RouterAPI,
  type RouterContext,
  type RouterEvents,
} from "../src/index.ts";
import type { probeGeneration } from "../src/generation-probe.ts";
import { parseConfig } from "../src/config.ts";
import {
  ClassifierError,
  type Classification,
  type Classify,
  type RouterConfig,
} from "../src/types.ts";

type RouterHookName = keyof RouterEvents;

type RouterResult = Awaited<ReturnType<Parameters<RouterAPI["on"]>[1]>>;

type RouterHook<K extends RouterHookName> = (
  event: RouterEvents[K],
  ctx: RouterContext,
) => RouterResult | Promise<RouterResult>;

type HookLists = { [K in RouterHookName]: RouterHook<K>[] };

const SECRET = "synthetic-auth-marker-not-a-real-key";

const PROMPT = "Private prompt marker: explain the event loop and its scheduling.";

const target = (model: string) => ({ provider: "fixture", model });

const model = (id: string): Model<Api> => ({
  name: id,
  api: "openai-completions",
  baseUrl: "https://fixture.invalid",
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  provider: "fixture",
  id,
  input: ["text", "image"],
  contextWindow: 128_000,
  maxTokens: 16_384,
});

const classification = (overrides: Partial<Classification> = {}): Classification => ({
  choice: "quick",
  confidence: 0.99,
  probabilities: { quick: 0.99, standard: 0.005, deep: 0.005, uncertain: 0 },
  requestedModel: "jev-1.13.0",
  ...overrides,
});

const config = (overrides: Partial<RouterConfig> = {}) =>
  parseConfig({
    mode: "auto",
    backend: { type: "typesafe", auth: { source: "pi", provider: "fixture" } },
    routes: { quick: [target("quick")], standard: [target("standard")], deep: [target("deep")] },
    defaultRoute: "standard",
    uncertainRoute: "deep",
    ...overrides,
  });

function deferred<T>() {
  let resolve!: (value: T) => void;

  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

// Preserve extra persisted fields so privacy assertions also inspect unexpected data.
const entrySchema = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("typesafe-router-mode"),
    data: z.looseObject({ mode: z.enum(["off", "shadow", "auto"]) }),
  }),
  z.looseObject({
    type: z.literal("typesafe-router-decision"),
    data: z.looseObject({
      route: z.enum(["quick", "standard", "deep"]),
      target: z.looseObject({ provider: z.string(), model: z.string() }).optional(),
      reason: z.string(),
      skipped: z.array(z.string()),
      backend: z.string(),
      milliseconds: z.number(),
      shadow: z.boolean(),
    }),
  }),
]);

function unusedHostMethod(): never {
  throw new Error("Unexpected host method used by router");
}

type TerminalHook = Parameters<ExtensionContext["ui"]["onTerminalInput"]>[0];

interface Options {
  unverified?: boolean;
  probeGeneration?: typeof probeGeneration;
  config?: RouterConfig;
  load?: () => Promise<RouterConfig | undefined>;
  classify?: Classify;
  setModel?: RouterAPI["setModel"];
  models?: Model<Api>[];
  available?: Model<Api>[];
  mode?: "tui" | "rpc";
  idle?: boolean;
  confirm?: RouterContext["ui"]["confirm"];
  getContextUsage?: RouterContext["getContextUsage"];
}

/** Only the host boundary is synthetic. Routing, config parsing and cancellation are real. */
async function harness(options: Options = {}) {
  const hooks: HookLists = {
    session_start: [],
    session_shutdown: [],
    session_before_switch: [],
    session_before_fork: [],
    session_before_tree: [],
    session_tree: [],
    input: [],
    model_select: [],
    message_end: [],
    agent_settled: [],
  };

  const commands = new Map<string, (args: string, ctx: RouterContext) => Promise<void>>();
  const terminal = new Set<TerminalHook>();
  const selections: string[] = [];
  const classifications: Parameters<Classify>[] = [];
  const entries: z.infer<typeof entrySchema>[] = [];
  const notifications: string[] = [];
  const sent: Parameters<ExtensionAPI["sendUserMessage"]>[] = [];
  const statuses: Parameters<ExtensionContext["ui"]["setStatus"]>[] = [];

  const models = options.models ?? [
    model("quick"),
    model("standard"),
    model("deep"),
    model("next"),
  ];

  let initialized = false;
  let warming = false;
  let firstConfig: RouterConfig | undefined;
  const probes: Parameters<typeof probeGeneration>[] = [];

  const ctx: RouterContext = {
    mode: options.mode ?? "tui",
    hasUI: true,
    scopedModels: [],
    model: models[0],
    // Pi starts the extension before a run; busy-input scenarios begin afterward.
    isIdle: () => !initialized || (options.idle ?? true),
    getSystemPrompt: () => "Synthetic system prompt",
    getContextUsage:
      options.getContextUsage ?? (() => ({ tokens: 0, contextWindow: 128_000, percent: 0 })),
    sessionManager: {
      getEntries: () => [],
      getLeafId: () => null,
      buildContextEntries: () => [],
      getBranch: () => [],
    },
    modelRegistry: {
      getAll: () => models,
      getAvailable: () => options.available ?? models,
      find: (provider: string, id: string) =>
        models.find((item) => item.provider === provider && item.id === id),
      getProviderAuth: async () => ({ auth: { apiKey: SECRET } }),
      getProviderAuthStatus: () => ({ configured: true, source: "runtime" }),
      getRegisteredProviderConfig: () => ({ apiKey: SECRET }),
      getProvider: () => undefined,
      complete: unusedHostMethod,
    },
    ui: {
      select: unusedHostMethod,
      input: unusedHostMethod,
      notify: (text) => {
        notifications.push(text);
      },
      setStatus: (...args) => {
        statuses.push(args);
      },
      confirm: options.confirm ?? (async () => true),
      onTerminalInput: (handler: TerminalHook) => {
        terminal.add(handler);

        return () => {
          terminal.delete(handler);
        };
      },
    },
  };

  const defaults: RouterEvents = {
    session_start: { type: "session_start", reason: "startup" },
    session_shutdown: { type: "session_shutdown", reason: "quit" },
    session_before_switch: { type: "session_before_switch", reason: "new" },
    session_before_fork: { type: "session_before_fork", entryId: "fixture-entry", position: "at" },
    session_before_tree: {
      type: "session_before_tree",
      preparation: {
        targetId: "fixture-entry",
        oldLeafId: null,
        commonAncestorId: null,
        entriesToSummarize: [],
        userWantsSummary: false,
      },
      signal: new AbortController().signal,
    },
    session_tree: { type: "session_tree", newLeafId: null, oldLeafId: null },
    input: { type: "input", text: PROMPT, source: "interactive", images: [] },
    model_select: {
      type: "model_select",
      model: model("quick"),
      previousModel: undefined,
      source: "set",
    },
    message_end: { type: "message_end", message: { role: "assistant" } },
    agent_settled: { type: "agent_settled" },
  };

  async function emit<K extends RouterHookName>(name: K, event: Partial<RouterEvents[K]> = {}) {
    let result: RouterResult = undefined;
    const payload = { ...defaults[name], ...event };

    for (const hook of hooks[name]) result = await hook(payload, ctx);

    return result;
  }

  const pi: RouterAPI = {
    on: (name, hook) => {
      hooks[name].push(hook);
    },
    registerCommand: (name, command) => {
      commands.set(name, command.handler);
    },
    appendEntry: (type, data) => {
      entries.push(entrySchema.parse({ type, data }));
    },
    getAllTools: () => [],
    getActiveTools: () => [],
    sendUserMessage: (...args) => {
      sent.push(args);
    },
    setModel: async (selected) => {
      selections.push(selected.id);
      const success = await (options.setModel?.(selected) ?? Promise.resolve(true));

      // Pi emits this before its setter resolves; router-owned selections must not disable auto.
      if (success) await emit("model_select", { model: selected, source: "set" });

      return success;
    },
  };

  registerRouter(pi, {
    configPath: "/synthetic/no-filesystem/router.json",
    load: async () => {
      if (warming) return firstConfig;
      const loaded = await (options.load?.() ?? Promise.resolve(options.config ?? config()));

      if (!initialized) firstConfig = loaded;

      return loaded;
    },
    probeGeneration: async (...args) => {
      if (!warming) probes.push(args);

      return !warming && options.probeGeneration
        ? options.probeGeneration(...args)
        : { target: args[1], passed: true, reason: "ok", milliseconds: 0 };
    },
    classify: async (...args) => {
      if (warming) return classification();
      classifications.push(args);

      return options.classify ? options.classify(...args) : classification();
    },
  });
  await emit("session_start");

  if (!options.unverified && firstConfig) {
    warming = true;
    await commands.get("typesafe-router")!("doctor", ctx);
    warming = false;
    entries.length = 0;
    notifications.length = 0;
    statuses.length = 0;
    selections.length = 0;
  }

  initialized = true;

  return {
    ctx,
    probes,
    emit,
    selections,
    classifications,
    entries,
    notifications,
    sent,
    statuses,
    terminal,
    input: (overrides: Partial<InputEvent> = {}) =>
      emit("input", { text: PROMPT, source: "interactive", images: [], ...overrides }),
    command: (args: string) => commands.get("typesafe-router")!(args, ctx),
    escape: () => [...terminal].map((handler) => handler("\u001b")),
    decisions: () =>
      entries.flatMap((entry) => (entry.type === "typesafe-router-decision" ? [entry.data] : [])),
  };
}

// A hung regression should fail quickly rather than leave a pending test indefinitely.
describe("registerRouter runtime hooks", { timeout: 3000 }, () => {
  it("off does not classify or select", async () => {
    const h = await harness({ config: config({ mode: "off" }) });
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.equal(h.classifications.length, 0);
    assert.deepEqual(h.selections, []);
  });

  it("headless opts out by default, even with a UI facade", async () => {
    const h = await harness({ mode: "rpc" });
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.equal(h.classifications.length, 0);
    assert.deepEqual(h.selections, []);
  });

  it("explicit allowHeadless permits routing", async () => {
    const h = await harness({ mode: "rpc", config: config({ allowHeadless: true }) });
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.deepEqual(h.selections, ["quick"]);
    assert.equal(h.terminal.size, 0);
  });

  for (const [name, event] of [
    ["steering", { streamingBehavior: "steer" }],
    ["follow-up", { streamingBehavior: "followUp" }],
    ["extension", { source: "extension" }],
  ] as const)
    it(`skips ${name} inputs`, async () => {
      const h = await harness();
      assert.deepEqual(await h.input(event), { action: "continue" });
      assert.equal(h.classifications.length, 0);
      assert.deepEqual(h.selections, []);
    });

  it("skips inputs while the agent is not idle", async () => {
    const h = await harness({ idle: false });
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.equal(h.classifications.length, 0);
  });

  for (const [name, result] of [
    ["uncertain", { choice: "uncertain" }],
    ["missing confidence", { confidence: undefined }],
    ["low confidence", { confidence: 0.2 }],
    ["nonfinite confidence", { confidence: NaN }],
  ] as const)
    it(`${name} chooses the conservative route, not the default`, async () => {
      const h = await harness({ classify: async () => classification(result) });
      assert.deepEqual(await h.input(), { action: "continue" });
      assert.deepEqual(h.selections, ["deep"]);
      assert.equal(h.decisions()[0].route, "deep");
    });

  it("classifier errors use the default chain without persisting error text", async () => {
    const h = await harness({
      classify: async () => {
        throw new Error(`${SECRET} ${PROMPT}`);
      },
    });

    assert.deepEqual(await h.input(), { action: "continue" });
    assert.deepEqual(h.selections, ["standard"]);
    assert.equal(h.decisions()[0].route, "standard");
    assert.ok(!JSON.stringify([h.entries, h.notifications]).includes(SECRET));
    assert.ok(!JSON.stringify([h.entries, h.notifications]).includes(PROMPT));
  });

  it("classifier timeout aborts its signal and uses the default chain; late success is ignored", async () => {
    const pending = deferred<Classification>();

    const h = await harness({
      config: config({ timeoutMs: 100 }),
      classify: () => pending.promise,
    });

    assert.deepEqual(await h.input(), { action: "continue" });
    assert.equal(h.classifications[0][2].signal.aborted, true);
    assert.deepEqual(h.selections, ["standard"]);
    assert.equal(h.decisions()[0].reason, "classifier-timeout");
    pending.resolve(classification());
    await nextTurn();
    assert.deepEqual(h.selections, ["standard"]);
  });

  it("missing, ineligible, auth-false and throwing candidates fall through in order before generation", async () => {
    const h = await harness({
      config: config({
        routes: {
          quick: ["missing", "tiny", "noauth", "throws", "next"].map(target),
          standard: [target("standard")],
          deep: [target("deep")],
        },
      }),
      models: [
        { ...model("tiny"), contextWindow: 1 },
        model("noauth"),
        model("throws"),
        model("next"),
        model("standard"),
        model("deep"),
      ],
      setModel: async (selected) => {
        if (selected.id === "noauth") return false;

        if (selected.id === "throws") throw new Error("synthetic auth failure");

        return true;
      },
    });

    assert.deepEqual(await h.input(), { action: "continue" });
    assert.deepEqual(h.selections, ["noauth", "throws", "next"]);
    assert.equal(h.decisions()[0].target?.model, "next");
    assert.equal(h.decisions()[0].skipped.length, 4);
    assert.deepEqual(h.sent, []);
  });

  it("uses Pi's 210000-token count for an Astra-sized model despite huge session messages", async () => {
    const h = await harness({
      config: config({
        routes: { quick: [target("quick")], standard: [target("quick")], deep: [target("quick")] },
      }),
      models: [{ ...model("quick"), contextWindow: 272_000 }],
      getContextUsage: () => ({ tokens: 210_000, contextWindow: 272_000, percent: 77.2 }),
    });

    h.ctx.sessionManager.getEntries = () => [
      {
        type: "message",
        id: "huge-message",
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: { role: "user", content: "漢".repeat(300_000), timestamp: 0 },
      },
    ];
    h.ctx.sessionManager.getLeafId = () => "huge-message";

    assert.deepEqual(await h.input(), { action: "continue" });
    assert.deepEqual(h.selections, ["quick"]);
    assert.equal(h.decisions()[0].target?.model, "quick");
  });

  it("counts the actual pending request exactly once at the host usage boundary", async () => {
    const text = "Explain é漢字👩🏽‍💻".repeat(20);
    const pendingTokens = estimateTokens({ role: "user", content: text, timestamp: 0 });
    assert.ok(pendingTokens > 0);

    for (const extraToken of [0, 1]) {
      const h = await harness({
        config: config({
          routes: {
            quick: [target("quick")],
            standard: [target("quick")],
            deep: [target("quick")],
          },
        }),
        models: [{ ...model("quick"), contextWindow: 210_000 + pendingTokens + 8192 }],
        getContextUsage: () => ({
          tokens: 210_000 + extraToken,
          contextWindow: 272_000,
          percent: 77.2,
        }),
      });

      assert.deepEqual(await h.input({ text }), {
        action: extraToken === 0 ? "continue" : "handled",
      });
      assert.deepEqual(h.selections, extraToken === 0 ? ["quick"] : []);

      if (extraToken === 1)
        assert.ok(h.decisions()[0].skipped.some((reason) => reason.includes("context-overflow")));
    }
  });

  it("unknown post-compaction context does not falsely block a candidate", async () => {
    const h = await harness({
      config: config({
        routes: { quick: [target("quick")], standard: [target("quick")], deep: [target("quick")] },
      }),
      models: [{ ...model("quick"), contextWindow: 1 }],
      getContextUsage: () => ({ tokens: null, contextWindow: 272_000, percent: null }),
    });

    assert.deepEqual(await h.input(), { action: "continue" });
    assert.deepEqual(h.selections, ["quick"]);
  });

  it("exhausted candidates handle the original input instead of generating", async () => {
    const h = await harness({ setModel: async () => false });
    assert.deepEqual(await h.input(), { action: "handled" });
    assert.equal(h.decisions()[0].target, undefined);
    assert.deepEqual(h.sent, []);
  });

  it("shadow classifies and records a decision but never sets a model", async () => {
    const h = await harness({ config: config({ mode: "shadow" }) });
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.equal(h.classifications.length, 1);
    assert.deepEqual(h.selections, []);
    assert.equal(h.decisions()[0].shadow, true);
  });

  it("Escape consumes the key, aborts classification and handles the unsent prompt", async () => {
    const entered = deferred<void>();
    const pending = deferred<Classification>();

    const h = await harness({
      classify: () => {
        entered.resolve();

        return pending.promise;
      },
    });

    const input = h.input();
    await entered.promise;
    assert.deepEqual(h.escape(), [{ consume: true }]);
    assert.equal(h.classifications[0][2].signal.aborted, true);
    assert.deepEqual(await input, { action: "handled" });
    pending.resolve(classification());
    await nextTurn();
    assert.deepEqual(h.selections, []);
    assert.deepEqual(h.decisions(), []);
    assert.equal(h.terminal.size, 0);
  });

  it("cancelled noncancellable setter keeps the lock until settlement", async () => {
    const entered = deferred<void>();
    const pending = deferred<boolean>();

    const h = await harness({
      setModel: () => {
        entered.resolve();

        return pending.promise;
      },
    });

    let settled = false;

    const original = h.input().then((result) => {
      settled = true;

      return result;
    });

    await entered.promise;
    h.escape();
    assert.deepEqual(await h.input({ text: "Second submission" }), { action: "handled" });
    assert.equal(settled, false);
    assert.equal(h.classifications.length, 1);
    assert.deepEqual(h.selections, ["quick"]);
    pending.resolve(true);
    assert.deepEqual(await original, { action: "handled" });
    assert.deepEqual(h.decisions(), []);
    assert.equal(h.terminal.size, 0);
    assert.deepEqual(h.sent, []);
  });

  it("router-owned model_select preserves auto, external model_select disables it", async () => {
    const h = await harness();
    await h.input();
    await h.input();
    assert.equal(h.classifications.length, 2);
    await h.emit("model_select", { model: model("deep"), source: "cycle" });
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.equal(h.classifications.length, 2);
    assert.deepEqual(h.selections, ["quick", "quick"]);
    assert.equal(
      h.entries.filter((entry) => entry.type === "typesafe-router-mode").at(-1)?.data.mode,
      "off",
    );
  });

  it("generation failure guides manual /model recovery without replay or selection", async () => {
    const h = await harness();
    await h.input();
    await h.emit("message_end", {
      message: { role: "assistant", provider: "fixture", model: "quick", stopReason: "error" },
    });
    await h.emit("agent_settled");
    assert.match(h.notifications.join("\n"), /\/model/);
    await h.command("recover");
    assert.deepEqual(h.selections, ["quick"]);
    assert.equal(h.decisions().length, 1);
    assert.deepEqual(h.sent, []);
  });

  it("invalid configuration blocks input until explicitly switched off", async () => {
    const h = await harness({
      load: async () => {
        throw new Error("invalid config");
      },
    });

    assert.deepEqual(await h.input(), { action: "handled" });
    await h.command("on");
    assert.deepEqual(await h.input(), { action: "handled" });
    await h.command("off");
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.equal(h.classifications.length, 0);
    assert.deepEqual(h.selections, []);
  });

  it("session shutdown aborts classification and ignores late completion", async () => {
    const entered = deferred<void>();
    const pending = deferred<Classification>();

    const h = await harness({
      classify: () => {
        entered.resolve();

        return pending.promise;
      },
    });

    const input = h.input();
    await entered.promise;
    await h.emit("session_shutdown");
    assert.equal(h.classifications[0][2].signal.aborted, true);
    assert.deepEqual(await input, { action: "handled" });
    pending.resolve(classification());
    await nextTurn();
    assert.deepEqual(h.selections, []);
    assert.deepEqual(h.decisions(), []);
    assert.equal(h.terminal.size, 0);
  });

  it("doctor owns the input lock and rejects a second doctor until its read settles", async () => {
    const read = deferred<RouterConfig>();
    const entered = deferred<void>();
    let reads = 0;

    const h = await harness({
      load: () => {
        if (++reads === 1) return Promise.resolve(config());
        entered.resolve();

        return read.promise;
      },
    });

    const doctor = h.command("doctor");
    await entered.promise;
    assert.deepEqual(await h.input(), { action: "handled" });
    await h.command("doctor");
    assert.equal(reads, 2);
    assert.equal(h.classifications.length, 0);
    assert.deepEqual(h.selections, []);
    read.resolve(config({ mode: "shadow" }));
    await doctor;
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.equal(h.classifications.length, 2);
    assert.equal(h.decisions()[0].shadow, false);
  });

  it("off cancels a pending doctor and its late read cannot reenable routing", async () => {
    const read = deferred<RouterConfig>();
    const entered = deferred<void>();
    let reads = 0;

    const h = await harness({
      load: () => {
        if (++reads === 1) return Promise.resolve(config());
        entered.resolve();

        return read.promise;
      },
    });

    const doctor = h.command("doctor");
    await entered.promise;
    await h.command("off");
    await doctor; // Cancellation must not wait for the underlying filesystem read.
    assert.deepEqual(await h.input(), { action: "continue" });
    read.resolve(config({ mode: "auto" }));
    await nextTurn();
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.equal(h.classifications.length, 0);
    assert.deepEqual(h.selections, []);
    await h.command("status");
    assert.match(h.notifications.at(-1)!, /(?:mode|routing): off/i);
  });

  it("shutdown aborts a pending doctor without waiting for or publishing its late read", async () => {
    const read = deferred<RouterConfig>();
    const entered = deferred<void>();
    let reads = 0;

    const h = await harness({
      load: () => {
        if (++reads === 1) return Promise.resolve(config());
        entered.resolve();

        return read.promise;
      },
    });

    const doctor = h.command("doctor");
    await entered.promise;
    const published = [h.entries.length, h.statuses.length, h.notifications.length];
    await h.emit("session_shutdown");
    await doctor;
    assert.deepEqual([h.entries.length, h.statuses.length, h.notifications.length], published);
    read.resolve(config({ mode: "auto" }));
    await nextTurn();
    assert.deepEqual([h.entries.length, h.statuses.length, h.notifications.length], published);
    assert.equal(h.classifications.length, 0);
    assert.deepEqual(h.selections, []);
    assert.equal(h.terminal.size, 0);
  });

  for (const command of ["on", "shadow"]) {
    for (const interruption of ["off", "shutdown"])
      it(`delayed ${command} confirmation cannot enable after ${interruption}`, async () => {
        const dialog = deferred<boolean>();
        const asked = deferred<void>();

        const h = await harness({
          config: config({ mode: "off" }),
          confirm: () => {
            asked.resolve();

            return dialog.promise;
          },
        });

        const enabling = h.command(command);
        await asked.promise;

        if (interruption === "off") await h.command("off");
        else await h.emit("session_shutdown");
        const published = [h.entries.length, h.statuses.length, h.notifications.length];
        dialog.resolve(true);
        await enabling;
        assert.deepEqual([h.entries.length, h.statuses.length, h.notifications.length], published);
        assert.equal(h.classifications.length, 0);

        if (interruption === "off") {
          assert.deepEqual(await h.input(), { action: "continue" });
          assert.equal(h.classifications.length, 0);
        }

        assert.deepEqual(h.selections, []);
      });
  }

  it("off preserves the input lock until a noncancellable setter actually settles", async () => {
    const entered = deferred<void>();
    const setter = deferred<boolean>();

    const h = await harness({
      setModel: () => {
        entered.resolve();

        return setter.promise;
      },
    });

    let settled = false;

    const input = h.input().then((result) => {
      settled = true;

      return result;
    });

    await entered.promise;
    await h.command("off");
    assert.deepEqual(await h.input(), { action: "handled" });
    assert.equal(settled, false);
    assert.equal(h.classifications.length, 1);
    assert.deepEqual(h.selections, ["quick"]);
    setter.resolve(true);
    assert.deepEqual(await input, { action: "handled" });
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.equal(h.classifications.length, 1);
    assert.deepEqual(h.decisions(), []);
    assert.equal(h.terminal.size, 0);
  });

  for (const event of [
    "session_before_switch",
    "session_before_fork",
    "session_before_tree",
  ] as const)
    it(`${event} vetoes navigation until the active setter settles`, async () => {
      const entered = deferred<void>();
      const setter = deferred<boolean>();

      const h = await harness({
        setModel: () => {
          entered.resolve();

          return setter.promise;
        },
      });

      const input = h.input();
      await entered.promise;
      assert.deepEqual(await h.emit(event), { cancel: true });
      assert.deepEqual(await h.input(), { action: "handled" });
      assert.deepEqual(await h.emit(event), { cancel: true });
      setter.resolve(true);
      assert.deepEqual(await input, { action: "handled" });
      assert.equal(await h.emit(event), undefined);
      assert.deepEqual(h.decisions(), []);
      assert.equal(h.terminal.size, 0);
    });

  for (const mode of ["tui", "rpc"] as const)
    it(`doctor applies disk settings and checks automatically while off in ${mode}`, async () => {
      let disk = config({ mode: "off" });

      const h = await harness({
        mode,
        load: async () => disk,
        confirm: unusedHostMethod,
      });

      disk = config({ mode: "auto", minConfidence: 0.8, allowHeadless: false });
      await h.command("doctor");
      assert.equal(h.classifications.length, 1);
      const state = h.classifications[0][1];
      assert.ok(state.current_request.length > 0);
      assert.notEqual(state.current_request, PROMPT);
      assert.deepEqual(state.recent_conversation, []);
      assert.deepEqual(await h.input(), { action: "continue" });
      assert.equal(h.classifications.length, 1);
      assert.deepEqual(h.selections, []);
      assert.deepEqual(h.sent, []);
      assert.deepEqual(h.decisions(), []);
      const report = h.notifications.at(-1)!;
      assert.match(report, /pi-typesafe-router: doctor/i);
      assert.match(report, /config:.*(?:applied|loaded|refreshed)/i);
      assert.match(report, /routing: off/i);
      assert.match(report, /classifier check:.*(?:ok|success|passed)/i);
      assert.match(report, /local/i);
      assert.match(report, /generation|probe/i);
    });

  for (const failure of ["missing", "error"] as const)
    it(`doctor disables routing on ${failure} config without classifying`, async () => {
      let reads = 0;

      const h = await harness({
        load: async () => {
          if (++reads === 1) return config();

          if (failure === "error") throw new Error(`${SECRET} ${PROMPT}`);

          return undefined;
        },
      });

      await h.command("doctor");
      const report = h.notifications.at(-1)!;
      assert.match(report, failure === "missing" ? /missing/i : /error|invalid|failed/i);
      assert.match(report, /routing: off/i);
      assert.match(report, /next:/i);
      assert.equal(h.classifications.length, 0);
      assert.deepEqual(h.selections, []);
      assert.deepEqual(h.sent, []);
      assert.ok(!report.includes(SECRET));
      assert.ok(!report.includes(PROMPT));
    });

  for (const code of ["credentials", "http", "network"] as const)
    it(`doctor reports safe ${code} failure without exposing raw errors`, async () => {
      const h = await harness({
        classify: async () => {
          const error = new ClassifierError(code, code === "http" ? 401 : undefined);
          error.message = `${SECRET} ${PROMPT}`;
          throw error;
        },
      });

      await h.command("doctor");
      const report = h.notifications.at(-1)!;
      assert.match(report, /classifier check:.*(?:failed|error)/i);
      assert.match(report, new RegExp(code, "i"));
      assert.match(report, /next:/i);

      if (code === "http") assert.match(report, /401/);
      assert.ok(!report.includes(SECRET));
      assert.ok(!report.includes(PROMPT));
      assert.deepEqual(h.selections, []);
      assert.deepEqual(h.sent, []);
    });

  it("doctor timeout aborts the synthetic check and ignores late success", async () => {
    const pending = deferred<Classification>();

    const h = await harness({
      config: config({ timeoutMs: 100 }),
      classify: () => pending.promise,
    });

    await h.command("doctor");
    assert.equal(h.classifications[0][2].signal.aborted, true);
    assert.match(h.notifications.at(-1)!, /timeout|timed out/i);
    const published = h.notifications.length;
    pending.resolve(classification());
    await nextTurn();
    assert.equal(h.notifications.length, published);
    assert.deepEqual(h.selections, []);
    assert.deepEqual(h.sent, []);
  });

  for (const interruption of ["off", "escape", "shutdown"] as const)
    it(`${interruption} invalidates doctor classification without late UI`, async () => {
      const entered = deferred<void>();
      const pending = deferred<Classification>();

      const h = await harness({
        classify: () => {
          entered.resolve();

          return pending.promise;
        },
      });

      const doctor = h.command("doctor");
      await entered.promise;

      if (interruption === "off") await h.command("off");
      else if (interruption === "escape") h.escape();
      else await h.emit("session_shutdown");
      await doctor;
      assert.equal(h.classifications[0][2].signal.aborted, true);
      const published = [h.notifications.length, h.statuses.length, h.entries.length];
      pending.resolve(classification());
      await nextTurn();
      assert.deepEqual([h.notifications.length, h.statuses.length, h.entries.length], published);
      assert.deepEqual(h.selections, []);
      assert.deepEqual(h.sent, []);
    });

  it("doctor holds the lock through classification; status observes without cancelling", async () => {
    const entered = deferred<void>();
    const pending = deferred<Classification>();

    const h = await harness({
      classify: () => {
        entered.resolve();

        return pending.promise;
      },
    });

    const doctor = h.command("doctor");
    await entered.promise;
    await h.command("doctor");
    assert.equal(h.classifications.length, 1);
    assert.deepEqual(await h.input(), { action: "handled" });
    await h.command("status");
    assert.match(h.notifications.at(-1)!, /(?:mode|routing): auto/i);
    assert.match(h.notifications.at(-1)!, /(?:activity|pending):.*(?:doctor|classif)/i);
    assert.equal(h.classifications[0][2].signal.aborted, false);
    pending.resolve(classification());
    await doctor;
    assert.match(h.notifications.at(-1)!, /classifier check:.*(?:ok|success|passed)/i);
    assert.deepEqual(h.selections, []);
  });

  it("status during a delayed doctor read neither cancels nor applies its own disk snapshot", async () => {
    const read = deferred<RouterConfig>();
    const entered = deferred<void>();
    let reads = 0;

    const h = await harness({
      load: async () => {
        reads++;

        if (reads === 1) return config({ mode: "off" });

        if (reads === 2) {
          entered.resolve();

          return read.promise;
        }

        return config({ mode: "auto" });
      },
    });

    const doctor = h.command("doctor");
    await entered.promise;
    await h.command("status");
    assert.equal(reads, 2);
    assert.match(h.notifications.at(-1)!, /not compared while an operation is running/i);
    assert.match(h.notifications.at(-1)!, /routing: off/i);
    assert.match(h.notifications.at(-1)!, /activity:.*(?:doctor|read|config)/i);
    assert.equal(h.classifications.length, 0);
    read.resolve(config({ mode: "auto" }));
    await doctor;
    assert.equal(h.classifications.length, 1);
    assert.match(h.notifications.at(-1)!, /classifier check:.*(?:ok|success|passed)/i);
    assert.match(h.notifications.at(-1)!, /routing: off/i);
  });

  it("status rereads disk without applying edits or changing the active mode", async () => {
    let reads = 0;
    let disk = config();

    const h = await harness({
      load: async () => {
        reads++;

        return disk;
      },
    });

    disk = config({ mode: "off", defaultRoute: "deep" });
    await h.command("status");
    assert.equal(reads, 2);
    assert.match(h.notifications.at(-1)!, /(?:mode|routing): auto/i);
    assert.match(h.notifications.at(-1)!, /unapplied|changed|differ/i);
    assert.equal(h.classifications.length, 0);
    assert.deepEqual(h.entries, []);
    await h.command("doctor");
    await h.command("status");
    assert.match(h.notifications.at(-1)!, /(?:matches|unchanged|in sync|applied)/i);
    assert.match(h.notifications.at(-1)!, /(?:mode|routing): auto/i);
  });

  for (const command of ["reload", "validate", "check", "cancel", "recover"])
    it(`removed ${command} gives guidance without effects`, async () => {
      let reads = 0;

      const h = await harness({
        load: async () => {
          reads++;

          return config();
        },
      });

      const before = [h.entries.length, h.statuses.length];
      await h.command(command);
      assert.match(h.notifications.at(-1)!, /removed/i);
      assert.match(
        h.notifications.at(-1)!,
        command === "recover" ? /\/model/ : command === "cancel" ? /off|Escape/i : /doctor/i,
      );
      assert.equal(reads, 1);
      assert.deepEqual([h.entries.length, h.statuses.length], before);
      assert.equal(h.classifications.length, 0);
      assert.deepEqual(h.selections, []);
      assert.deepEqual(h.sent, []);
    });

  for (const command of ["on", "shadow"] as const)
    it(`${command} cannot enable RPC routing just because a UI facade exists`, async () => {
      const h = await harness({
        mode: "rpc",
        config: config({ mode: "off", allowHeadless: false }),
        confirm: unusedHostMethod,
      });

      await h.command("doctor");
      assert.match(h.notifications.at(-1)!, /allowHeadless is false/);
      assert.doesNotMatch(h.notifications.at(-1)!, /next: \/typesafe-router on/);
      await h.command(command);
      assert.match(h.notifications.at(-1)!, /disabled in this interface/);
      assert.deepEqual(await h.input(), { action: "continue" });
      assert.equal(h.classifications.length, 1);
      assert.deepEqual(h.selections, []);
    });

  it("successful decisions contain neither credentials nor the raw prompt", async () => {
    const h = await harness();
    await h.input();
    assert.equal(h.classifications[0][1].current_request, PROMPT);
    assert.equal(h.classifications[0][2].apiKey, SECRET);
    assert.equal(h.decisions().length, 1);
    const persisted = JSON.stringify(h.entries);
    assert.ok(!persisted.includes(SECRET));
    assert.ok(!persisted.includes(PROMPT));
  });
});

describe("generation readiness gate", { timeout: 3000 }, () => {
  for (const mode of ["auto", "shadow"] as const)
    it(`${mode} startup blocks input and enabling until doctor succeeds`, async () => {
      const h = await harness({ unverified: true, config: config({ mode }) });
      assert.deepEqual(await h.input(), { action: "handled" });
      await h.command(mode === "auto" ? "on" : "shadow");
      assert.match(h.notifications.join("\n"), /doctor/i);
      assert.equal(h.classifications.length, 0);
      assert.deepEqual(h.selections, []);
      await h.command("doctor");
      await h.command(mode === "auto" ? "on" : "shadow");
      assert.deepEqual(await h.input(), { action: "continue" });
      assert.equal(h.classifications.length, 2);
    });

  it("one failed route blocks all routing even when the selected route passed", async () => {
    const h = await harness({
      unverified: true,
      probeGeneration: async (_registry, candidate) => ({
        target: candidate,
        passed: candidate.model !== "deep",
        reason: "synthetic",
        milliseconds: 0,
      }),
    });

    await h.command("doctor");
    await h.command("on");
    assert.deepEqual(await h.input(), { action: "handled" });
    assert.equal(h.classifications.length, 1);
    assert.deepEqual(h.selections, []);
    assert.match(h.notifications.join("\n"), /deep/);
  });

  it("one valid fallback per route unlocks, deduplicates probes and skips failed first candidates", async () => {
    const chain = [target("quick"), target("next")];

    const h = await harness({
      unverified: true,
      config: config({ routes: { quick: chain, standard: chain, deep: chain } }),
      probeGeneration: async (_registry, candidate) => ({
        target: candidate,
        passed: candidate.model === "next",
        reason: "synthetic",
        milliseconds: 0,
      }),
    });

    await h.command("doctor");
    assert.deepEqual(
      h.probes.map((args) => args[1].model),
      ["quick", "next"],
    );
    assert.ok(h.probes.every((args) => args[3] === 15000));
    await h.command("on");
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.deepEqual(h.selections, ["next"]);
    assert.equal(h.probes.length, 2, "routing must use proof, not run probes again");
  });

  it("a passed but locally unavailable candidate cannot establish readiness", async () => {
    const h = await harness({ unverified: true, available: [model("quick"), model("standard")] });
    await h.command("doctor");
    await h.command("on");
    assert.deepEqual(await h.input(), { action: "handled" });
    assert.deepEqual(h.selections, []);
    assert.equal(h.classifications.length, 1);
  });

  for (const change of [
    "mapping",
    "classifier reference",
    "provider reference",
    "auth source",
    "descriptor",
  ] as const)
    it(`${change} changes invalidate proof before input without classifying`, async () => {
      let disk = config();
      const h = await harness({ load: async () => disk });

      if (change === "mapping")
        disk = config({ routes: { ...disk.routes, quick: [target("next")] } });

      if (change === "classifier reference")
        disk = config({
          backend: {
            type: "typesafe",
            model: "jev-1.13.0",
            auth: { source: "env", variable: "OTHER_FIXTURE_KEY" },
          },
        });

      if (change === "provider reference")
        h.ctx.modelRegistry.getRegisteredProviderConfig = () => ({
          apiKey: "CHANGED_KEY_REFERENCE",
        });

      if (change === "auth source")
        h.ctx.modelRegistry.getProviderAuthStatus = () => ({
          configured: true,
          source: "models_json_key",
        });

      if (change === "descriptor")
        h.ctx.modelRegistry.getAll()[0].baseUrl = "https://changed.invalid";
      assert.deepEqual(await h.input(), { action: "handled" });
      assert.equal(h.classifications.length, 0);
      assert.deepEqual(h.selections, []);
      assert.match(h.notifications.at(-1)!, /doctor/i);
      assert.ok(!JSON.stringify(h.entries).includes("CHANGED_KEY_REFERENCE"));
    });

  it("on rechecks disk before enabling a previously verified off session", async () => {
    let disk = config({ mode: "off" });
    const h = await harness({ load: async () => disk });
    disk = config({ mode: "off", minConfidence: 0.9 });
    await h.command("on");
    assert.match(h.notifications.at(-1)!, /doctor/i);
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.equal(h.classifications.length, 0);
    assert.deepEqual(h.selections, []);
  });

  it("input verification reads disk abortably and ignores late config", async () => {
    let pause = false;
    const entered = deferred<void>();
    const pending = deferred<RouterConfig>();

    const h = await harness({
      load: async () => {
        if (!pause) return config();
        entered.resolve();

        return pending.promise;
      },
    });

    pause = true;
    const input = h.input();
    await entered.promise;
    await h.command("off");
    assert.deepEqual(await input, { action: "handled" });
    pending.resolve(config());
    await nextTurn();
    assert.equal(h.classifications.length, 0);
    assert.deepEqual(h.selections, []);
  });

  it("successful generation probes do not override a failed classifier check", async () => {
    const h = await harness({
      unverified: true,
      classify: async () => {
        throw new ClassifierError("credentials");
      },
    });

    await h.command("doctor");
    assert.equal(h.probes.length, 3);
    await h.command("on");
    assert.deepEqual(await h.input(), { action: "handled" });
    assert.equal(h.classifications.length, 1);
    assert.deepEqual(h.selections, []);
  });

  it("a separate classifier credential reference invalidates generation readiness", async () => {
    const h = await harness({
      config: config({
        backend: {
          type: "typesafe",
          model: "jev-1.13.0",
          auth: { source: "pi", provider: "classifier-fixture" },
        },
      }),
    });

    h.ctx.modelRegistry.getRegisteredProviderConfig = (provider) => ({
      apiKey: provider === "classifier-fixture" ? "changed-reference" : SECRET,
    });
    assert.deepEqual(await h.input(), { action: "handled" });
    assert.equal(h.classifications.length, 0);
    assert.deepEqual(h.selections, []);
  });

  it("scope changes block routing when any route loses its verified candidate", async () => {
    const h = await harness();
    h.ctx.scopedModels = [
      { model: model("quick"), thinkingLevel: "off" },
      { model: model("standard"), thinkingLevel: "off" },
    ];
    assert.deepEqual(await h.input(), { action: "handled" });
    assert.match(h.notifications.at(-1)!, /deep/);
    assert.equal(h.classifications.length, 0);
    assert.deepEqual(h.selections, []);
  });

  it("context growth rechecks eligibility of every verified route", async () => {
    const h = await harness({
      models: [model("quick"), model("standard"), { ...model("deep"), contextWindow: 30_000 }],
    });

    h.ctx.getContextUsage = () => ({ tokens: 35_000, contextWindow: 128_000, percent: 27 });
    assert.deepEqual(await h.input(), { action: "handled" });
    assert.match(h.notifications.at(-1)!, /deep/);
    assert.equal(h.classifications.length, 0);
    assert.deepEqual(h.selections, []);
  });

  it("off preserves completed proof and a new session clears it", async () => {
    const h = await harness();
    await h.command("off");
    await h.command("on");
    await h.input();
    assert.deepEqual(h.selections, ["quick"]);
    await h.emit("session_start");
    assert.deepEqual(await h.input(), { action: "handled" });
    assert.equal(h.classifications.length, 1);
  });

  for (const interruption of ["off", "shutdown", "disk change"] as const)
    it(`${interruption} during generation probe cannot publish stale readiness`, async () => {
      const entered = deferred<void>();
      const pending = deferred<Awaited<ReturnType<typeof probeGeneration>>>();
      let disk = config();

      const h = await harness({
        unverified: true,
        load: async () => disk,
        probeGeneration: async (_registry, candidate) => {
          if (candidate.model === "quick") {
            entered.resolve();

            return pending.promise;
          }

          return { target: candidate, passed: true, reason: "ok", milliseconds: 0 };
        },
      });

      const doctor = h.command("doctor");
      await entered.promise;

      if (interruption === "off") await h.command("off");
      else if (interruption === "shutdown") await h.emit("session_shutdown");
      else disk = config({ minConfidence: 0.9 });

      if (interruption !== "disk change") {
        await doctor;
        assert.equal(h.probes[0][2].aborted, true);
      }

      pending.resolve({ target: target("quick"), passed: true, reason: "ok", milliseconds: 0 });
      await doctor;
      await nextTurn();

      if (interruption === "shutdown") await h.emit("session_start");
      await h.command("on");
      await h.input();
      assert.deepEqual(h.selections, []);
      assert.match(h.notifications.join("\n"), /doctor/i);
    });
});
