import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { registerRouter } from "../src/index.ts";
import { parseConfig } from "../src/config.ts";
import type { Classification, Classify, ModelInfo, RouterConfig } from "../src/types.ts";

const SECRET = "synthetic-auth-marker-not-a-real-key";
const PROMPT = "Private prompt marker: explain the event loop and its scheduling.";
const target = (model: string) => ({ provider: "fixture", model });
const model = (id: string): ModelInfo => ({ provider: "fixture", id, input: ["text", "image"], contextWindow: 128_000, maxTokens: 16_384 });
const classification = (overrides: Partial<Classification> = {}): Classification => ({
  choice: "quick", confidence: 0.99,
  probabilities: { quick: 0.99, standard: 0.005, deep: 0.005, uncertain: 0 },
  requestedModel: "jev-1.13.0", ...overrides,
});
const config = (overrides: Partial<RouterConfig> = {}) => parseConfig({
  mode: "auto", backend: { type: "typesafe", auth: { source: "pi", provider: "fixture" } },
  routes: { quick: [target("quick")], standard: [target("standard")], deep: [target("deep")] },
  defaultRoute: "standard", uncertainRoute: "deep", ...overrides,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

type Hook = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
type TerminalHook = (data: string) => { consume?: boolean } | undefined;
interface Options {
  config?: RouterConfig;
  load?: () => Promise<RouterConfig | undefined>;
  classify?: Classify;
  setModel?: (model: ModelInfo) => Promise<boolean>;
  models?: ModelInfo[];
  available?: ModelInfo[];
  mode?: "tui" | "rpc";
  idle?: boolean;
  confirm?: () => Promise<boolean>;
}

/** Only the host boundary is synthetic. Routing, config parsing and cancellation are real. */
async function harness(options: Options = {}) {
  const hooks = new Map<string, Hook[]>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const terminal = new Set<TerminalHook>();
  const selections: string[] = [];
  const classifications: Parameters<Classify>[] = [];
  const entries: Array<{ type: string; data: any }> = [];
  const notifications: string[] = [];
  const sent: unknown[] = [];
  const statuses: unknown[] = [];
  const models = options.models ?? [model("quick"), model("standard"), model("deep"), model("next")];
  let initialized = false;
  const ctx = {
    mode: options.mode ?? "tui", hasUI: true, scopedModels: [], model: models[0],
    // Pi starts the extension before a run; busy-input scenarios begin afterward.
    isIdle: () => !initialized || (options.idle ?? true),
    getSystemPrompt: () => "Synthetic system prompt",
    sessionManager: { getEntries: () => [], getLeafId: () => null, buildContextEntries: () => [], getBranch: () => [] },
    modelRegistry: {
      getAll: () => models,
      getAvailable: () => options.available ?? models,
      find: (provider: string, id: string) => models.find(item => item.provider === provider && item.id === id),
      getProviderAuth: async () => ({ auth: { apiKey: SECRET } }),
    },
    ui: {
      notify: (text: string) => { notifications.push(text); },
      setStatus: (...args: unknown[]) => { statuses.push(args); },
      confirm: options.confirm ?? (async () => true),
      onTerminalInput: (handler: TerminalHook) => { terminal.add(handler); return () => { terminal.delete(handler); }; },
    },
  } as unknown as ExtensionContext;
  async function emit(name: string, event: unknown = {}) {
    let result: unknown;
    for (const hook of hooks.get(name) ?? []) result = await hook(event, ctx);
    return result;
  }
  const pi = {
    on: (name: string, hook: Hook) => { hooks.set(name, [...(hooks.get(name) ?? []), hook]); },
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commands.set(name, command.handler); },
    appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); },
    getAllTools: () => [], getActiveTools: () => [],
    sendUserMessage: (...args: unknown[]) => { sent.push(args); },
    setModel: async (selected: ModelInfo) => {
      selections.push(selected.id);
      const success = await (options.setModel?.(selected) ?? Promise.resolve(true));
      // Pi emits this before its setter resolves; router-owned selections must not disable auto.
      if (success) await emit("model_select", { model: selected, source: "set" });
      return success;
    },
  } as unknown as ExtensionAPI;
  registerRouter(pi, {
    configPath: "/synthetic/no-filesystem/router.json",
    load: options.load ?? (async () => options.config ?? config()),
    classify: async (...args) => {
      classifications.push(args);
      return options.classify ? options.classify(...args) : classification();
    },
  });
  await emit("session_start");
  initialized = true;
  return {
    ctx, emit, selections, classifications, entries, notifications, sent, statuses, terminal,
    input: (overrides: Partial<InputEvent> = {}) => emit("input", { text: PROMPT, source: "interactive", images: [], ...overrides }),
    command: (args: string) => commands.get("typesafe-router")!(args, ctx),
    escape: () => [...terminal].map(handler => handler("\u001b")),
    decisions: () => entries.filter(entry => entry.type === "typesafe-router-decision").map(entry => entry.data),
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
  ] as const) it(`skips ${name} inputs`, async () => {
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
    ["uncertain", { choice: "uncertain" }], ["missing confidence", { confidence: undefined }],
    ["low confidence", { confidence: 0.2 }], ["nonfinite confidence", { confidence: NaN }],
  ] as const) it(`${name} chooses the conservative route, not the default`, async () => {
    const h = await harness({ classify: async () => classification(result) });
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.deepEqual(h.selections, ["deep"]);
    assert.equal(h.decisions()[0].route, "deep");
  });

  it("classifier errors use the default chain without persisting error text", async () => {
    const h = await harness({ classify: async () => { throw new Error(`${SECRET} ${PROMPT}`); } });
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.deepEqual(h.selections, ["standard"]);
    assert.equal(h.decisions()[0].route, "standard");
    assert.ok(!JSON.stringify([h.entries, h.notifications]).includes(SECRET));
    assert.ok(!JSON.stringify([h.entries, h.notifications]).includes(PROMPT));
  });

  it("classifier timeout aborts its signal and uses the default chain; late success is ignored", async () => {
    const pending = deferred<Classification>();
    const h = await harness({ config: config({ timeoutMs: 100 }), classify: () => pending.promise });
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
      config: config({ routes: { quick: ["missing", "tiny", "noauth", "throws", "next"].map(target), standard: [target("standard")], deep: [target("deep")] } }),
      models: [{ ...model("tiny"), contextWindow: 1 }, model("noauth"), model("throws"), model("next")],
      setModel: async selected => {
        if (selected.id === "noauth") return false;
        if (selected.id === "throws") throw new Error("synthetic auth failure");
        return true;
      },
    });
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.deepEqual(h.selections, ["noauth", "throws", "next"]);
    assert.equal(h.decisions()[0].target.model, "next");
    assert.equal(h.decisions()[0].skipped.length, 4);
    assert.deepEqual(h.sent, []);
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
    const h = await harness({ classify: () => { entered.resolve(); return pending.promise; } });
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
    const h = await harness({ setModel: () => { entered.resolve(); return pending.promise; } });
    let settled = false;
    const original = h.input().then(result => { settled = true; return result; });
    await entered.promise;
    await h.command("cancel");
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
    await h.emit("model_select", { model: model("deep"), source: "manual" });
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.equal(h.classifications.length, 2);
    assert.deepEqual(h.selections, ["quick", "quick"]);
    assert.equal(h.entries.filter(entry => entry.type === "typesafe-router-mode").at(-1)?.data.mode, "off");
  });

  it("generation failure never replays; explicit recover selects next and turns routing off", async () => {
    const h = await harness({ config: config({ routes: { quick: [target("quick"), target("next")], standard: [target("standard")], deep: [target("deep")] } }) });
    await h.input();
    await h.emit("message_end", { message: { role: "assistant", provider: "fixture", model: "quick", stopReason: "error" } });
    await h.emit("agent_settled");
    await h.emit("agent_settled");
    assert.deepEqual(h.selections, ["quick"]);
    assert.deepEqual(h.sent, []);
    await h.command("recover");
    assert.deepEqual(h.selections, ["quick", "next"]);
    assert.equal(h.decisions().at(-1).reason, "explicit-recovery");
    assert.equal(h.entries.filter(entry => entry.type === "typesafe-router-mode").at(-1)?.data.mode, "off");
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.equal(h.classifications.length, 1);
    await h.command("recover");
    assert.deepEqual(h.selections, ["quick", "next"]);
    assert.deepEqual(h.sent, []);
  });

  it("invalid configuration blocks input until explicitly switched off", async () => {
    const h = await harness({ load: async () => { throw new Error("invalid config"); } });
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
    const h = await harness({ classify: () => { entered.resolve(); return pending.promise; } });
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

  it("a stale check confirmation cannot replace a routed input's pending setter", async () => {
    const dialog = deferred<boolean>();
    const asked = deferred<void>();
    const entered = deferred<void>();
    const setter = deferred<boolean>();
    const h = await harness({
      confirm: () => { asked.resolve(); return dialog.promise; },
      setModel: () => { entered.resolve(); return setter.promise; },
    });
    const check = h.command("check");
    await asked.promise;
    const input = h.input();
    await entered.promise;
    dialog.resolve(true);
    await check;
    assert.equal(h.classifications.length, 1, "stale check must not classify");
    assert.deepEqual(await h.input({ text: "Concurrent submission" }), { action: "handled" });
    assert.equal(h.terminal.size, 1, "original operation retains its cancellation hook");
    let shutdownSettled = false;
    const shutdown = h.emit("session_shutdown").then(() => { shutdownSettled = true; });
    await nextTurn();
    assert.equal(shutdownSettled, false, "shutdown must await the original setter");
    setter.resolve(true);
    assert.deepEqual(await input, { action: "handled" });
    await shutdown;
    assert.deepEqual(h.selections, ["quick"]);
    assert.deepEqual(h.decisions(), []);
    assert.equal(h.terminal.size, 0);
  });

  it("reload owns the input lock and rejects a second reload until its read settles", async () => {
    const read = deferred<RouterConfig>();
    const entered = deferred<void>();
    let reads = 0;
    const h = await harness({ load: () => {
      if (++reads === 1) return Promise.resolve(config());
      entered.resolve();
      return read.promise;
    } });
    const reload = h.command("reload");
    await entered.promise;
    assert.deepEqual(await h.input(), { action: "handled" });
    await h.command("reload");
    assert.equal(reads, 2);
    assert.equal(h.classifications.length, 0);
    assert.deepEqual(h.selections, []);
    read.resolve(config({ mode: "shadow" }));
    await reload;
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.equal(h.classifications.length, 1);
    assert.equal(h.decisions()[0].shadow, true);
  });

  it("off cancels a pending reload and its late read cannot reenable routing", async () => {
    const read = deferred<RouterConfig>();
    const entered = deferred<void>();
    let reads = 0;
    const h = await harness({ load: () => {
      if (++reads === 1) return Promise.resolve(config());
      entered.resolve();
      return read.promise;
    } });
    const reload = h.command("reload");
    await entered.promise;
    await h.command("off");
    await reload; // Cancellation must not wait for the underlying filesystem read.
    assert.deepEqual(await h.input(), { action: "continue" });
    read.resolve(config({ mode: "auto" }));
    await nextTurn();
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.equal(h.classifications.length, 0);
    assert.deepEqual(h.selections, []);
    await h.command("status");
    assert.match(h.notifications.at(-1)!, /^Mode: off\n/);
  });

  it("shutdown aborts a pending reload without waiting for or publishing its late read", async () => {
    const read = deferred<RouterConfig>();
    const entered = deferred<void>();
    let reads = 0;
    const h = await harness({ load: () => {
      if (++reads === 1) return Promise.resolve(config());
      entered.resolve();
      return read.promise;
    } });
    const reload = h.command("reload");
    await entered.promise;
    const published = [h.entries.length, h.statuses.length, h.notifications.length];
    await h.emit("session_shutdown");
    await reload;
    assert.deepEqual([h.entries.length, h.statuses.length, h.notifications.length], published);
    read.resolve(config({ mode: "auto" }));
    await nextTurn();
    assert.deepEqual([h.entries.length, h.statuses.length, h.notifications.length], published);
    assert.equal(h.classifications.length, 0);
    assert.deepEqual(h.selections, []);
    assert.equal(h.terminal.size, 0);
  });

  for (const alreadyOff of [false, true]) it(`manual selection invalidates recovery${alreadyOff ? " even when already off" : ""}`, async () => {
    const h = await harness({ config: config({ routes: { quick: [target("quick"), target("next")], standard: [target("standard")], deep: [target("deep")] } }) });
    await h.input();
    // Seed a genuine failure too: external selection must clear existing recovery eligibility.
    await h.emit("message_end", { message: { role: "assistant", provider: "fixture", model: "quick", stopReason: "error" } });
    if (alreadyOff) await h.command("off");
    await h.emit("model_select", { model: model("deep"), source: "manual" });
    await h.emit("message_end", { message: { role: "assistant", provider: "fixture", model: "deep", stopReason: "error" } });
    await h.emit("agent_settled");
    await h.command("recover");
    assert.deepEqual(h.selections, ["quick"]);
    assert.equal(h.decisions().length, 1);
    assert.deepEqual(h.sent, []);
    // A delayed failure from A must not resurrect its discarded chain either.
    await h.emit("message_end", { message: { role: "assistant", provider: "fixture", model: "quick", stopReason: "error" } });
    await h.command("recover");
    assert.deepEqual(h.selections, ["quick"]);
  });

  for (const failed of [
    { provider: "fixture", model: "deep" },
    { provider: "other-provider", model: "quick" },
    {},
  ]) it(`unmatched failure cannot enable recovery: ${JSON.stringify(failed)}`, async () => {
    const h = await harness({ config: config({ routes: { quick: [target("quick"), target("next")], standard: [target("standard")], deep: [target("deep")] } }) });
    await h.input();
    await h.emit("message_end", { message: { role: "assistant", ...failed, stopReason: "error" } });
    const notices = h.notifications.length;
    await h.emit("agent_settled");
    assert.equal(h.notifications.length, notices, "unrelated failures must not advertise recovery");
    await h.command("recover");
    assert.deepEqual(h.selections, ["quick"]);
    assert.equal(h.decisions().length, 1);
    assert.deepEqual(h.sent, []);
  });

  for (const command of ["on", "shadow"]) {
    for (const interruption of ["off", "shutdown"]) it(`delayed ${command} confirmation cannot enable after ${interruption}`, async () => {
      const dialog = deferred<boolean>();
      const asked = deferred<void>();
      const h = await harness({ config: config({ mode: "off" }), confirm: () => { asked.resolve(); return dialog.promise; } });
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

  it("a delayed check confirmation after shutdown does not classify or publish", async () => {
    const dialog = deferred<boolean>();
    const asked = deferred<void>();
    const h = await harness({ confirm: () => { asked.resolve(); return dialog.promise; } });
    const check = h.command("check");
    await asked.promise;
    await h.emit("session_shutdown");
    const published = [h.entries.length, h.statuses.length, h.notifications.length];
    dialog.resolve(true);
    await check;
    assert.equal(h.classifications.length, 0);
    assert.deepEqual([h.entries.length, h.statuses.length, h.notifications.length], published);
    assert.equal(h.terminal.size, 0);
  });

  it("off preserves the input lock until a noncancellable setter actually settles", async () => {
    const entered = deferred<void>();
    const setter = deferred<boolean>();
    const h = await harness({ setModel: () => { entered.resolve(); return setter.promise; } });
    let settled = false;
    const input = h.input().then(result => { settled = true; return result; });
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

  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"]) it(`${event} vetoes navigation until the active setter settles`, async () => {
    const entered = deferred<void>();
    const setter = deferred<boolean>();
    const h = await harness({ setModel: () => { entered.resolve(); return setter.promise; } });
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
