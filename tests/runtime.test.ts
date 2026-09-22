/**
 * Lifecycle tests for `registerRouter` in `src/index.ts`.
 *
 * `registerRouter` takes its classifier, generation probe, and config loader as arguments,
 * so the extension's own host seam is enough to drive the real hook wiring offline: no Pi
 * process, no credentials, no socket. The suite covers the *contract* gates — which
 * submissions are routed, which continue untouched, what gets probed, what a session
 * replays, and what a manual model change does — rather than trying to re-render the TUI.
 *
 * The fakes are typed against the extension's own `RouterAPI` / `RouterContext`, so a change
 * to that seam fails here rather than in a live session.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { z } from "zod";

import { baseConfigInput, installPiStubs, model } from "./harness.ts";

installPiStubs();

const { registerRouter } = await import("../src/index.ts");

const { parseConfig } = await import("../src/config.ts");

const { configuredTargets } = await import("../src/verification.ts");

const { ClassifierError } = await import("../src/types.ts");

import type { InputEventResult, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RouterAPI, RouterContext, RouterEvents } from "../src/host.ts";
import type { Classification, Classify, RouterConfig, Target, TaskClass } from "../src/types.ts";
import type { GenerationProbeResult } from "../src/generation-probe.ts";
import type { RoutingPolicy } from "../src/policy.ts";

const NAME = "typesafe-router";

const CONFIG_PATH = "/tmp/typesafe-router-tests.json";

type TerminalHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

/** Pi's own custom-entry payload type, named so the fake does not assert it. */
type CustomEntryData = Extract<SessionEntry, { type: "custom" }>["data"];

/** What a hook may return to the host: an input decision, a cancellation, or nothing. */
type FakeResult = InputEventResult | { cancel?: boolean } | void;

/**
 * The event a test supplies for one hook. Only `type` is required, because each test drives a
 * single hook with the fields that hook reads; the router never validates its host's events.
 */
interface FakeEvent {
  type: string;
}

/** The erased hook shape the double stores; a specific hook is assignable to it. */
type ErasedHook = (event: FakeEvent, ctx: RouterContext) => FakeResult | Promise<FakeResult>;

interface FakeHost {
  api: RouterAPI;
  entries: Array<{ customType: string; data?: CustomEntryData }>;
  has(command: string): boolean;
  hasHook(name: string): boolean;
  fire<E extends FakeEvent>(name: string, event: E, ctx: RouterContext): Promise<FakeResult>;
  fireCommand(args: string, ctx: RouterContext): Promise<void>;
  /** Deliver terminal input to whatever handler the router currently holds, if any. */
  terminal(data: string): { consume?: boolean; data?: string } | undefined;
  hasTerminalHandler(): boolean;
}

function fakeHost(
  selection: { results: boolean[]; models: string[]; thinking: string[] },
  terminalHandlers: Set<TerminalHandler>,
): FakeHost {
  const hooks = new Map<string, ErasedHook>();

  const commands = new Map<
    string,
    { handler: (args: string, ctx: RouterContext) => Promise<void> }
  >();

  const entries: FakeHost["entries"] = [];

  async function fire<E extends FakeEvent>(
    name: string,
    event: E,
    ctx: RouterContext,
  ): Promise<FakeResult> {
    const hook = hooks.get(name);
    assert.ok(hook, `${name} hook is registered`);

    return await hook(event, ctx);
  }

  async function fireCommand(args: string, ctx: RouterContext): Promise<void> {
    const command = commands.get(NAME);
    assert.ok(command, "the router command is registered");
    await command.handler(args, ctx);
  }

  const api = {
    appendEntry: (customType: string, data?: CustomEntryData) => {
      entries.push({ customType, data });
    },
    getAllTools: () => [],
    getActiveTools: () => [],
    sendUserMessage: () => {},
    setModel: async (selected: { provider: string; id: string }) => {
      selection.models.push(`${selected.provider}/${selected.id}`);

      return selection.results.shift() ?? true;
    },
    setThinkingLevel: (level: string) => {
      selection.thinking.push(level);
    },
    on: <K extends keyof RouterEvents & string>(
      name: K,
      hook: (event: RouterEvents[K], ctx: RouterContext) => FakeResult | Promise<FakeResult>,
    ) => {
      // SAFETY: the store is erased across hook names; a hook always accepts its own event,
      // and every call site fires a hook with the event that hook declares.
      hooks.set(name, hook as ErasedHook);
    },
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: RouterContext) => Promise<void> },
    ) => {
      commands.set(name, command);
    },
  } satisfies RouterAPI;

  return {
    api,
    entries,
    has: (command) => commands.has(command),
    hasHook: (name) => hooks.has(name),
    fire,
    fireCommand,
    terminal: (data) => {
      for (const handler of terminalHandlers) {
        const result = handler(data);

        if (result) return result;
      }

      return undefined;
    },
    hasTerminalHandler: () => terminalHandlers.size > 0,
  };
}

interface ContextOptions {
  mode?: RouterContext["mode"];
  hasUI?: boolean;
  branch?: SessionEntry[];
  model?: RouterContext["model"];
  idle?: boolean;
  catalog?: ReturnType<typeof model>[];
}

interface FakeSession {
  ctx: RouterContext;
  notifications: string[];
  statuses: Array<string | undefined>;
  editorTexts: string[];
  setIdle(value: boolean): void;
}

function context(
  options: ContextOptions,
  terminalHandlers: Set<TerminalHandler>,
  liveBranch?: () => SessionEntry[],
): FakeSession {
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];
  const editorTexts: string[] = [];
  let idle = options.idle ?? true;
  const branch = options.branch ?? [];
  const catalog = options.catalog ?? [];

  // Pi composes one provider object per provider id; the fake must too, or every
  // fingerprint would be recomputed against a fresh identity.
  const providerObjects = new Map<
    string,
    NonNullable<ReturnType<RouterContext["modelRegistry"]["getProvider"]>>
  >();

  const ctx: RouterContext = {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    scopedModels: [],
    model: options.model ?? model("provider-quick", "quick-model"),
    isIdle: () => idle,
    getSystemPrompt: () => "",
    getContextUsage: () => ({ tokens: 100, contextWindow: 200_000, percent: 0.05 }),
    sessionManager: {
      getEntries: () => liveBranch?.() ?? branch,
      getBranch: () => liveBranch?.() ?? branch,
      buildContextEntries: () => [],
      getLeafId: () => null,
    },
    modelRegistry: {
      getAll: () => catalog,
      getAvailable: () => catalog,
      find: (provider, id) =>
        catalog.find((entry) => entry.provider === provider && entry.id === id),
      getProviderAuth: async () => undefined,
      getProviderAuthStatus: () => ({ configured: true, source: "environment" as const }),
      getRegisteredProviderConfig: () => undefined,
      getProvider: (provider) => {
        const existing = providerObjects.get(provider);

        if (existing) return existing;

        // SAFETY: this fake exists to be a stable object identity; no provider member is read.
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- identity-only fake provider
        const created = { id: provider } as unknown as NonNullable<
          ReturnType<RouterContext["modelRegistry"]["getProvider"]>
        >;

        providerObjects.set(provider, created);

        return created;
      },
      complete: async () => {
        throw new Error("no model is contacted by this suite");
      },
    },
    ui: {
      notify: (message) => {
        notifications.push(message);
      },
      setStatus: (_key, value) => {
        statuses.push(value);
      },
      setWidget: () => {},
      setEditorText: (text) => {
        editorTexts.push(text);
      },
      confirm: async () => true,
      select: async () => undefined,
      input: async () => undefined,
      onTerminalInput: (handler) => {
        terminalHandlers.add(handler);

        return () => terminalHandlers.delete(handler);
      },
    },
  };

  return {
    ctx,
    notifications,
    statuses,
    editorTexts,
    setIdle: (value) => {
      idle = value;
    },
  };
}

/** The model and thinking selections a harness records, in call order. */
interface SelectionLog {
  results: boolean[];
  models: string[];
  thinking: string[];
}

interface HarnessOptions {
  config?: RouterConfig;
  loadFails?: boolean;
  load?: () => Promise<RouterConfig | undefined>;
  context?: ContextOptions;
  classify?: Classify;
  /** Probe outcome per target; the timeout is the configured generation-probe bound. */
  probe?: (target: Target, timeoutMs: number) => Promise<GenerationProbeResult>;
  /** Model-selection outcomes in order; `true` once the queue is empty. */
  selectionResults?: boolean[];
  /**
   * Make `sessionManager.getBranch()` return the entries the router itself appended. This is
   * how a reload or tree navigation is simulated after a doctor run persisted its proofs.
   */
  branchFromEntries?: boolean;
}

interface Harness extends FakeSession {
  host: FakeHost;
  config: RouterConfig;
  models: string[];
  thinking: string[];
  probes: string[];
  classified(): number;
}

/** A catalog containing exactly the configuration's targets, all usable and available. */
function catalogFor(config: RouterConfig) {
  return configuredTargets(config).map((target) => model(target.provider, target.model));
}

function harness(options: HarnessOptions = {}): Harness {
  const config = options.config ?? parseConfig(baseConfigInput());

  const selection: SelectionLog = {
    results: [...(options.selectionResults ?? [])],
    models: [],
    thinking: [],
  };

  const terminalHandlers = new Set<TerminalHandler>();
  const host = fakeHost(selection, terminalHandlers);

  const liveBranch = options.branchFromEntries
    ? () =>
        host.entries.map((entry, index) =>
          customEntry(entry.customType, entry.data, `live-${String(index)}`),
        )
    : undefined;

  const session = context(
    { ...options.context, catalog: options.context?.catalog ?? catalogFor(config) },
    terminalHandlers,
    liveBranch,
  );

  const probes: string[] = [];
  let classified = 0;

  registerRouter(host.api, {
    configPath: CONFIG_PATH,
    load: async () => {
      if (options.loadFails) throw new Error("unreadable");

      return options.load ? await options.load() : config;
    },
    classify: async (backend, state, call) => {
      classified++;

      if (options.classify) return await options.classify(backend, state, call);

      throw new Error("classification is not expected in this suite");
    },
    probeGeneration: async (registry, target, signal, timeoutMs) => {
      probes.push(`${target.provider}/${target.model}`);

      if (options.probe) return await options.probe(target, timeoutMs);

      return { target, passed: true, reason: "ok", milliseconds: 1 };
    },
  });

  return {
    host,
    ...session,
    config,
    models: selection.models,
    thinking: selection.thinking,
    probes,
    classified: () => classified,
  };
}

function automatic(): RouterConfig {
  return parseConfig({ ...baseConfigInput(), mode: "auto" });
}

function shadow(): RouterConfig {
  return parseConfig({ ...baseConfigInput(), mode: "shadow" });
}

/** A classifier that always answers with one route and the given confidence. */
function classifier(choice: TaskClass, confidence = 0.95): Classify {
  const probabilities = { quick: 0.1, standard: 0.1, deep: 0.1, uncertain: 0.1 };

  return async () =>
    ({
      choice,
      probabilities: { ...probabilities, [choice]: 0.7 },
      confidence,
      requestedModel: "jev-1.13.0",
      returnedModel: "jev-1.13.0",
    }) satisfies Classification;
}

function classification(choice: TaskClass, confidence = 0.95): Classification {
  return {
    choice,
    probabilities: { quick: 0.1, standard: 0.1, deep: 0.1, uncertain: 0.1, [choice]: 0.7 },
    confidence,
    requestedModel: "jev-1.13.0",
    returnedModel: "jev-1.13.0",
  };
}

function startSession(host: FakeHost, ctx: RouterContext) {
  return host.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
}

interface InputEventOverrides {
  text?: string;
  images?: readonly unknown[];
  source?: string;
  streamingBehavior?: string;
}

const inputEvent = (overrides: InputEventOverrides = {}) => ({
  type: "input",
  text: "explain this function",
  images: [],
  source: "interactive",
  ...overrides,
});

/** A complete custom session entry; Pi always supplies id, parentId, and timestamp. */
function customEntry(customType: string, data?: CustomEntryData, id = "entry"): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType,
    data,
  };
}

test("registers the command and the hooks the extension depends on", () => {
  const { host } = harness();

  assert.equal(host.has(NAME), true);

  for (const hook of [
    "session_start",
    "session_shutdown",
    "input",
    "model_select",
    "message_end",
    "agent_settled",
  ])
    assert.equal(host.hasHook(hook), true, `${hook} hook`);
});

test("session_start loads the injected configuration and replays the session mode", async () => {
  const { host, ctx, notifications } = harness({
    context: {
      branch: [customEntry(`${NAME}-mode`, { mode: "shadow" })],
    },
  });

  await startSession(host, ctx);
  await host.fireCommand("status", ctx);
  const status = notifications.at(-1) ?? "";

  assert.match(status, /pi-typesafe-router: status/);
  assert.match(status, /routing: shadow/);
  assert.match(status, /matches active configuration/);
  assert.match(status, /current model: provider-quick\/quick-model/);
});

test("a mode entry from another session's branch is ignored", async () => {
  const { host, ctx, notifications } = harness({
    context: { branch: [customEntry("other-extension", { mode: "shadow" })] },
  });

  await startSession(host, ctx);
  await host.fireCommand("status", ctx);

  assert.match(notifications.at(-1) ?? "", /routing: off/);
});

test("input passes through untouched while routing is off", async () => {
  const { host, ctx, classified } = harness();
  await startSession(host, ctx);

  assert.deepEqual(await host.fire("input", inputEvent(), ctx), { action: "continue" });
  assert.equal(classified(), 0);
});

test("extension-injected and streaming input never reaches the classifier", async () => {
  for (const event of [
    inputEvent({ source: "extension" }),
    inputEvent({ streamingBehavior: "steer" }),
    inputEvent({ streamingBehavior: "followUp" }),
  ]) {
    const { host, ctx, classified } = harness({ config: automatic() });
    await startSession(host, ctx);

    assert.deepEqual(await host.fire("input", event, ctx), { action: "continue" });
    assert.equal(classified(), 0);
  }
});

test("a busy session leaves the submission alone", async () => {
  const { host, ctx, classified, setIdle } = harness({ config: automatic() });
  await startSession(host, ctx);
  setIdle(false);

  assert.deepEqual(await host.fire("input", inputEvent(), ctx), { action: "continue" });
  assert.equal(classified(), 0);
});

test("headless routing stays disabled unless the configuration allows it", async () => {
  const { host, ctx, classified, probes, models } = harness({
    config: automatic(),
    context: { mode: "json", hasUI: false },
  });

  await startSession(host, ctx);

  assert.deepEqual(await host.fire("input", inputEvent(), ctx), { action: "continue" });
  assert.equal(classified(), 0);
  assert.deepEqual(probes, []);
  assert.deepEqual(models, []);
});

test("an unreadable configuration continues the prompt instead of blocking it", async () => {
  const { host, ctx, notifications, classified } = harness({ loadFails: true });
  await startSession(host, ctx);

  assert.deepEqual(await host.fire("input", inputEvent(), ctx), { action: "continue" });
  assert.equal(classified(), 0);
  assert.ok(
    notifications.some((message) => message.includes("Invalid router configuration")),
    notifications.join("\n"),
  );

  // The warning is emitted once, not on every submission.
  const before = notifications.length;

  await host.fire("input", inputEvent(), ctx);
  assert.equal(notifications.length, before);
});

test("only the classified route is inspected, so a broken other route cannot block it", async () => {
  const config = parseConfig({
    ...baseConfigInput(),
    mode: "auto",
    routes: {
      quick: [{ provider: "provider-broken", model: "missing-model", thinking: "low" }],
      standard: [{ provider: "provider-standard", model: "standard-model", thinking: "medium" }],
      deep: [{ provider: "provider-deep", model: "deep-model", thinking: "high" }],
    },
  });

  // `provider-broken` is deliberately absent from the catalogue.
  const { host, ctx, probes, models } = harness({ config, classify: classifier("deep") });
  await startSession(host, ctx);

  assert.deepEqual(await host.fire("input", inputEvent(), ctx), { action: "continue" });
  assert.deepEqual(probes, ["provider-deep/deep-model"]);
  assert.deepEqual(models, ["provider-deep/deep-model"]);
});

test("the selected chain is probed in order and falls through to the next candidate", async () => {
  const config = parseConfig({
    ...baseConfigInput(),
    mode: "auto",
    routes: {
      quick: [
        { provider: "provider-primary", model: "primary-model", thinking: "low" },
        { provider: "provider-backup", model: "backup-model", thinking: "low" },
      ],
      standard: [{ provider: "provider-standard", model: "standard-model", thinking: "medium" }],
      deep: [{ provider: "provider-deep", model: "deep-model", thinking: "high" }],
    },
  });

  const { host, ctx, probes, models, thinking, notifications } = harness({
    config,
    classify: classifier("quick"),
    probe: async (target) => ({
      target,
      passed: target.provider === "provider-backup",
      reason: target.provider === "provider-backup" ? "ok" : "request-failed",
      milliseconds: 1,
    }),
  });

  await startSession(host, ctx);

  assert.deepEqual(await host.fire("input", inputEvent(), ctx), { action: "continue" });
  assert.deepEqual(probes, ["provider-primary/primary-model", "provider-backup/backup-model"]);
  assert.deepEqual(models, ["provider-backup/backup-model"]);
  assert.deepEqual(thinking, ["low"]);
  assert.ok(
    notifications.some((message) => /quick → provider-backup\/backup-model/.test(message)),
    notifications.join("\n"),
  );
});

test("a passed probe is reused for the session instead of re-probing every submission", async () => {
  const { host, ctx, probes, models } = harness({
    config: automatic(),
    classify: classifier("deep"),
  });

  await startSession(host, ctx);

  await host.fire("input", inputEvent(), ctx);
  assert.deepEqual(probes, ["provider-deep/deep-model"]);

  await host.fire("input", inputEvent(), ctx);
  assert.deepEqual(probes, ["provider-deep/deep-model"]);
  assert.deepEqual(models, ["provider-deep/deep-model", "provider-deep/deep-model"]);
});

test("a classifier failure continues on the current model and records the fallback", async () => {
  const { host, ctx, notifications, models, thinking } = harness({
    config: automatic(),
    classify: async () => {
      throw new ClassifierError("timeout");
    },
  });

  await startSession(host, ctx);

  assert.deepEqual(await host.fire("input", inputEvent(), ctx), { action: "continue" });
  assert.deepEqual(models, []);
  assert.deepEqual(thinking, []);
  assert.ok(
    notifications.some((message) => /could not classify this request \(timeout\)/.test(message)),
    notifications.join("\n"),
  );

  const decision = decisionOf(host);
  assert.deepEqual(decision?.fallback, "classifier-failure");
});

test("a route whose candidates all fail probing continues on the current model", async () => {
  const { host, ctx, notifications, models, thinking, probes } = harness({
    config: automatic(),
    classify: classifier("deep"),
    probe: async (target) => ({
      target,
      passed: false,
      reason: "request-failed",
      milliseconds: 1,
    }),
  });

  await startSession(host, ctx);

  assert.deepEqual(await host.fire("input", inputEvent(), ctx), { action: "continue" });
  assert.deepEqual(probes, ["provider-deep/deep-model"]);
  assert.deepEqual(models, []);
  assert.deepEqual(thinking, []);
  assert.ok(
    notifications.some((message) =>
      /No usable model in the deep route \(probe-failed\)/.test(message),
    ),
    notifications.join("\n"),
  );

  const decision = decisionOf(host);
  assert.deepEqual(decision?.fallback, "probe-failed");
});

test("a model-application failure continues on the current model without changing effort", async () => {
  const { host, ctx, notifications, models, thinking } = harness({
    config: automatic(),
    classify: classifier("deep"),
    selectionResults: [false],
  });

  await startSession(host, ctx);

  assert.deepEqual(await host.fire("input", inputEvent(), ctx), { action: "continue" });
  assert.deepEqual(models, ["provider-deep/deep-model"]);
  assert.deepEqual(thinking, []);
  assert.ok(
    notifications.some((message) => /No usable model in the deep route/.test(message)),
    notifications.join("\n"),
  );
});

test("an uncertain classification stays on the conservative route and is not a failure", async () => {
  const { host, ctx, models, notifications } = harness({
    config: automatic(),
    classify: classifier("quick", 0.2),
  });

  await startSession(host, ctx);

  assert.deepEqual(await host.fire("input", inputEvent(), ctx), { action: "continue" });
  assert.deepEqual(models, ["provider-deep/deep-model"]);
  assert.ok(
    notifications.some((message) => message.includes("deep → provider-deep/deep-model")),
    notifications.join("\n"),
  );
});

test("input without classifiable context skips Jev and takes the conservative route", async () => {
  const { host, ctx, classified, probes, models } = harness({ config: automatic() });
  await startSession(host, ctx);

  assert.deepEqual(await host.fire("input", inputEvent({ text: "/skill:repo-docs" }), ctx), {
    action: "continue",
  });
  assert.equal(classified(), 0);
  assert.deepEqual(probes, ["provider-deep/deep-model"]);
  assert.deepEqual(models, ["provider-deep/deep-model"]);

  const decision = decisionOf(host);
  assert.equal(decision?.route, "deep");
  assert.equal(decision?.reason, "insufficient-context");
});

test("cancellation restores the prompt to the editor and suppresses generation", async () => {
  let release: ((value: Classification) => void) | undefined;

  const classify: Classify = () =>
    new Promise<Classification>((resolve) => {
      release = resolve;
    });

  const { host, ctx, editorTexts, models, notifications } = harness({
    config: automatic(),
    classify,
  });

  await startSession(host, ctx);

  const pending = host.fire("input", inputEvent(), ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(host.hasTerminalHandler(), true);
  assert.deepEqual(host.terminal("escape"), { consume: true });
  release?.(classification("quick"));

  assert.deepEqual(await pending, { action: "handled" });
  assert.deepEqual(editorTexts, ["explain this function"]);
  assert.deepEqual(models, []);
  assert.ok(
    notifications.some((message) => message.includes("restored to the editor")),
    notifications.join("\n"),
  );
});

test("cancellation reports unrestored attachments instead of silently dropping them", async () => {
  let release: ((value: Classification) => void) | undefined;

  const { host, ctx, notifications } = harness({
    config: automatic(),
    classify: () =>
      new Promise<Classification>((resolve) => {
        release = resolve;
      }),
  });

  await startSession(host, ctx);

  const pending = host.fire(
    "input",
    inputEvent({ images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }),
    ctx,
  );

  await new Promise((resolve) => setImmediate(resolve));
  host.terminal("escape");
  release?.(classification("quick"));

  await pending;
  assert.ok(
    notifications.some((message) => message.includes("Image attachments are not restored")),
    notifications.join("\n"),
  );
});

test("shadow mode classifies and proposes without probing or switching models", async () => {
  const { host, ctx, probes, models, thinking } = harness({
    config: shadow(),
    classify: classifier("quick"),
  });

  await startSession(host, ctx);

  assert.deepEqual(await host.fire("input", inputEvent(), ctx), { action: "continue" });
  assert.deepEqual(probes, []);
  assert.deepEqual(models, []);
  assert.deepEqual(thinking, []);

  const decision = decisionOf(host);
  assert.equal(decision?.shadow, true);
  assert.equal(
    decision?.target?.provider,
    "provider-quick",
    "shadow records the proposal it would have applied",
  );
});

test("a shadow classifier failure records the fallback, not a proposed route", async () => {
  const { host, ctx, probes, models } = harness({
    config: shadow(),
    classify: async () => {
      throw new ClassifierError("model-mismatch");
    },
  });

  await startSession(host, ctx);

  assert.deepEqual(await host.fire("input", inputEvent(), ctx), { action: "continue" });
  assert.deepEqual(probes, []);
  assert.deepEqual(models, []);

  const data = decisionOf(host);

  assert.equal(data?.fallback, "classifier-failure");
  assert.equal(data?.target, undefined, "shadow proposed a target it never classified");
  assert.equal(data?.reason, "model-mismatch");
});

test("a decision records the policy, configuration, and candidate provenance", async () => {
  const { host, ctx } = harness({ config: automatic(), classify: classifier("deep") });
  await startSession(host, ctx);
  await host.fire("input", inputEvent(), ctx);

  const provenance = decisionOf(host)?.provenance;

  for (const hash of [
    provenance?.policyHash,
    provenance?.configHash,
    provenance?.candidateSnapshotHash,
  ])
    assert.match(hash ?? "", /^[0-9a-f]{64}$/u);

  assert.deepEqual(provenance?.classifierModel, {
    requested: "jev-1.13.0",
    returned: "jev-1.13.0",
  });
});

test("doctor local reports the configuration without any request", async () => {
  const { host, ctx, probes, classified, notifications } = harness({ config: automatic() });
  await startSession(host, ctx);

  await host.fireCommand("doctor local", ctx);

  assert.equal(classified(), 0, "a local run must not contact the classifier");
  assert.deepEqual(probes, [], "a local run must not probe generation models");

  const report = notifications.join("\n");

  assert.match(report, /checks: local only/u);
  assert.match(report, /provenance: policy/u);
  assert.match(report, /pi-typesafe-router: ✅/u);
});

test("doctor local keeps proofs a live run earned", async () => {
  const { host, ctx, probes } = harness({ config: automatic(), classify: classifier("quick") });
  await startSession(host, ctx);
  await host.fireCommand("doctor live", ctx);
  const afterLive = probes.length;

  await host.fireCommand("doctor local", ctx);
  await host.fireCommand("doctor local", ctx);
  assert.equal(probes.length, afterLive);
});

test("a live doctor publishes no proof when its final configuration check changes", async () => {
  const config = automatic();
  const changed = parseConfig({ ...baseConfigInput(), mode: "auto", minConfidence: 0.7 });
  let reads = 0;

  const { host, ctx, probes } = harness({
    config,
    classify: classifier("quick"),
    load: async () => {
      reads++;

      return reads === 3 ? changed : config;
    },
  });

  await startSession(host, ctx);
  await host.fireCommand("doctor live", ctx);

  assert.deepEqual(probes, [
    "provider-quick/quick-model",
    "provider-standard/standard-model",
    "provider-deep/deep-model",
  ]);

  await host.fire("input", inputEvent(), ctx);
  assert.equal(probes.at(-1), "provider-quick/quick-model");
  assert.equal(probes.length, 4, "automatic routing must re-probe after an invalid doctor run");
});

test("manual doctor still probes every distinct configured target", async () => {
  const { host, ctx, probes, classified, notifications } = harness({
    config: automatic(),
    classify: classifier("quick"),
  });

  await startSession(host, ctx);

  await host.fireCommand("doctor", ctx);

  assert.deepEqual(probes, [
    "provider-quick/quick-model",
    "provider-standard/standard-model",
    "provider-deep/deep-model",
  ]);
  assert.equal(classified(), 1, "doctor makes its own synthetic classifier request");
  assert.ok(
    notifications.some((message) => message.includes("pi-typesafe-router: ✅")),
    notifications.join("\n"),
  );
});

test("bare doctor and doctor live are the same billable run", async () => {
  const probesFor = async (args: string) => {
    const { host, ctx, probes } = harness({ config: automatic(), classify: classifier("quick") });
    await startSession(host, ctx);
    await host.fireCommand(args, ctx);

    return probes;
  };

  assert.deepEqual(await probesFor("doctor"), await probesFor("doctor live"));
});

test("an unknown doctor option is refused instead of silently ignored", async () => {
  const { host, ctx, probes, notifications } = harness({ config: automatic() });
  await startSession(host, ctx);

  await host.fireCommand("doctor remote", ctx);

  assert.deepEqual(probes, []);
  assert.ok(notifications.some((message) => message.includes("doctor [local|live]")));
});

test("a manual model selection turns automatic routing off", async () => {
  const { host, ctx } = harness({ config: automatic() });
  await startSession(host, ctx);

  await host.fire(
    "model_select",
    { type: "model_select", model: model("provider-deep", "deep-model"), source: "set" },
    ctx,
  );

  assert.ok(
    host.entries.some(
      (entry) =>
        entry.customType === `${NAME}-mode` && JSON.stringify(entry.data) === '{"mode":"off"}',
    ),
    JSON.stringify(host.entries),
  );
});

test("/typesafe-router off persists the session mode and stops routing", async () => {
  const { host, ctx, notifications, classified } = harness({ config: automatic() });
  await startSession(host, ctx);
  await host.fireCommand("off", ctx);

  assert.ok(notifications.some((message) => /routing: off/.test(message)));
  assert.ok(
    host.entries.some(
      (entry) =>
        entry.customType === `${NAME}-mode` && JSON.stringify(entry.data) === '{"mode":"off"}',
    ),
  );
  assert.deepEqual(await host.fire("input", inputEvent(), ctx), { action: "continue" });
  assert.equal(classified(), 0);
});

test("enabling routing needs a valid configuration, not a doctor run", async () => {
  const { host, ctx, probes, classified } = harness({ classify: classifier("quick") });
  await startSession(host, ctx);

  await host.fireCommand("on", ctx);

  assert.ok(
    host.entries.some(
      (entry) =>
        entry.customType === `${NAME}-mode` && JSON.stringify(entry.data) === '{"mode":"auto"}',
    ),
    JSON.stringify(host.entries),
  );
  assert.deepEqual(probes, [], "enabling routing probes nothing by itself");

  assert.deepEqual(await host.fire("input", inputEvent(), ctx), { action: "continue" });
  assert.equal(classified(), 1);
});

test("/typesafe-router help does not touch configuration", async () => {
  const { host, ctx, notifications } = harness();
  const before = host.entries.length;
  await startSession(host, ctx);

  await host.fireCommand("help", ctx);

  assert.ok(notifications.some((message) => message.includes("Usage: /typesafe-router")));
  assert.equal(host.entries.length, before);
});

test("a removed command reports its replacement instead of failing", async () => {
  const { host, ctx, notifications } = harness();
  await startSession(host, ctx);

  await host.fireCommand("recover", ctx);

  assert.ok(notifications.some((message) => message.includes("Recovery command removed")));
});

interface RoutedMessageOverrides {
  stopReason?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
  };
}

/** One assistant message from the routed model, shaped as Pi delivers it. */
function routedMessage(provider: string, id: string, overrides: RoutedMessageOverrides = {}) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      provider,
      model: id,
      stopReason: "stop",
      usage: {
        input: 120,
        output: 40,
        cacheRead: 10,
        cacheWrite: 0,
        totalTokens: 170,
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      },
      ...overrides,
    },
  };
}

/**
 * The entry payloads this file reads, parsed the way any reader of a session file must: an
 * unknown entry in, a named shape out. Each schema states only the fields the tests assert;
 * `passthrough` keeps the rest visible without widening the type.
 */
const targetSchema = z.object({
  provider: z.string(),
  model: z.string(),
  thinking: z.string(),
});

const decisionEntrySchema = z
  .object({
    decisionId: z.string(),
    mode: z.string(),
    shadow: z.boolean(),
    applied: z.boolean(),
    route: z.string(),
    reason: z.string(),
    fallback: z.string().optional(),
    backend: z.string(),
    target: targetSchema.optional(),
    milliseconds: z.number(),
    minConfidence: z.number(),
    candidates: z.array(
      z.object({ target: z.string(), status: z.string(), reason: z.string().optional() }),
    ),
    selectedIndex: z.number().optional(),
    projection: z.object({ characters: z.number(), historyMessages: z.number() }),
    provenance: z.object({
      policyId: z.string(),
      policyHash: z.string(),
      configHash: z.string(),
      candidateSnapshotHash: z.string(),
      classifierModel: z.object({ requested: z.string(), returned: z.string().optional() }),
    }),
  })
  .passthrough();

const usageSchema = z
  .object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
    totalTokens: z.number(),
    costUsd: z.number(),
  })
  .partial();

const outcomeEntrySchema = z
  .object({
    decisionId: z.string(),
    provider: z.string(),
    model: z.string(),
    configuredThinking: z.string().optional(),
    status: z.string(),
    stopReason: z.string().optional(),
    responses: z.number(),
    elapsedSinceRoutingMs: z.number().optional(),
    usage: usageSchema.optional(),
  })
  .passthrough();

const feedbackEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    decisionId: z.string(),
    expectedRoute: z.string().optional(),
    skipped: z.boolean(),
  })
  .passthrough();

const verificationEntrySchema = z
  .object({ verified: z.boolean(), proofs: z.array(z.unknown()).optional() })
  .passthrough();

type DecisionData = z.infer<typeof decisionEntrySchema>;

type OutcomeData = z.infer<typeof outcomeEntrySchema>;

type FeedbackData = z.infer<typeof feedbackEntrySchema>;

/** Parse every entry of one custom type; a payload that does not parse is not returned. */
function parsedEntries<T>(host: FakeHost, customType: string, schema: z.ZodType<T>): T[] {
  return host.entries.flatMap((entry) => {
    if (entry.customType !== customType) return [];

    const parsed = schema.safeParse(entry.data);

    return parsed.success ? [parsed.data] : [];
  });
}

function decisionsOf(host: FakeHost): DecisionData[] {
  return parsedEntries(host, `${NAME}-decision`, decisionEntrySchema);
}

function decisionOf(host: FakeHost): DecisionData | undefined {
  return decisionsOf(host).at(-1);
}

function outcomesOf(host: FakeHost): OutcomeData[] {
  return parsedEntries(host, `${NAME}-outcome`, outcomeEntrySchema);
}

function feedbackOf(host: FakeHost): FeedbackData[] {
  return parsedEntries(host, `${NAME}-feedback`, feedbackEntrySchema);
}

function verificationOf(host: FakeHost) {
  return parsedEntries(host, `${NAME}-verification`, verificationEntrySchema);
}

/** A session branch already holding one decision entry, as a resumed session would have. */
function branchWithDecision(decisionId: string): SessionEntry[] {
  return [customEntry(`${NAME}-decision`, { decisionId }, "decision-entry")];
}

test("a decision records its mode, candidates, projection, and schema version", async () => {
  const { host, ctx } = harness({ config: automatic(), classify: classifier("deep") });
  await startSession(host, ctx);
  await host.fire("input", inputEvent(), ctx);

  const decision = decisionOf(host);

  assert.equal(decision?.schemaVersion, 2);
  assert.match(String(decision?.decisionId), /^[0-9a-f]{16}$/u);
  assert.equal(decision?.mode, "auto");
  assert.equal(decision?.shadow, false);
  assert.equal(decision?.applied, true);
  assert.equal(decision?.minConfidence, 0.8);
  assert.equal(decision?.margin, 0.6);
  assert.deepEqual(decision?.candidates, [
    { target: "provider-deep/deep-model", status: "applied" },
  ]);
  assert.deepEqual(decision?.projection, {
    characters: "explain this function".length,
    historyMessages: 0,
  });
  assert.deepEqual(decision?.target, {
    provider: "provider-deep",
    model: "deep-model",
    thinking: "high",
  });
});

test("an unapplied decision records every candidate outcome and its fallback", async () => {
  const config = parseConfig({
    ...baseConfigInput(),
    mode: "auto",
    routes: {
      quick: [
        { provider: "provider-primary", model: "primary-model", thinking: "low" },
        { provider: "provider-backup", model: "backup-model", thinking: "low" },
      ],
      standard: [{ provider: "provider-standard", model: "standard-model", thinking: "medium" }],
      deep: [{ provider: "provider-deep", model: "deep-model", thinking: "high" }],
    },
  });

  const { host, ctx } = harness({
    config,
    classify: classifier("quick"),
    probe: async (target) => ({
      target,
      passed: false,
      reason: "request-failed",
      milliseconds: 1,
    }),
  });

  await startSession(host, ctx);
  await host.fire("input", inputEvent(), ctx);

  const decision = decisionOf(host);

  assert.equal(decision?.applied, false);
  assert.equal(decision?.fallback, "probe-failed");
  assert.equal(decision?.target, undefined);
  assert.deepEqual(decision?.candidates, [
    { target: "provider-primary/primary-model", status: "probe-failed", reason: "request-failed" },
    { target: "provider-backup/backup-model", status: "probe-failed", reason: "request-failed" },
  ]);
});

test("a chain fallback records the applied index, not the first candidate", async () => {
  const config = parseConfig({
    ...baseConfigInput(),
    mode: "auto",
    routes: {
      quick: [
        { provider: "provider-primary", model: "primary-model", thinking: "low" },
        { provider: "provider-backup", model: "backup-model", thinking: "low" },
      ],
      standard: [{ provider: "provider-standard", model: "standard-model", thinking: "medium" }],
      deep: [{ provider: "provider-deep", model: "deep-model", thinking: "high" }],
    },
  });

  const { host, ctx } = harness({
    config,
    classify: classifier("quick"),
    probe: async (target) => ({
      target,
      passed: target.provider === "provider-backup",
      reason: target.provider === "provider-backup" ? "ok" : "request-failed",
      milliseconds: 1,
    }),
  });

  await startSession(host, ctx);
  await host.fire("input", inputEvent(), ctx);

  const decision = decisionOf(host);

  assert.equal(decision?.selectedIndex, 1);
  assert.equal(decision?.applied, true);
  assert.deepEqual(decision?.candidates, [
    { target: "provider-primary/primary-model", status: "probe-failed", reason: "request-failed" },
    { target: "provider-backup/backup-model", status: "applied" },
  ]);
});

test("the routed generation appends exactly one correlated outcome entry", async () => {
  const { host, ctx } = harness({ config: automatic(), classify: classifier("deep") });
  await startSession(host, ctx);
  await host.fire("input", inputEvent(), ctx);

  const decision = decisionOf(host);

  await host.fire("message_end", routedMessage("provider-deep", "deep-model"), ctx);
  // A second turn in the same run counts, but must not open a second outcome.
  await host.fire("message_end", routedMessage("provider-deep", "deep-model"), ctx);
  await host.fire("agent_settled", { type: "agent_settled" }, ctx);
  // A repeated settle must not duplicate the entry.
  await host.fire("agent_settled", { type: "agent_settled" }, ctx);

  const outcomes = outcomesOf(host);

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.decisionId, decision?.decisionId);
  assert.equal(outcomes[0]?.status, "settled");
  assert.equal(outcomes[0]?.responses, 2);
  assert.equal(outcomes[0]?.configuredThinking, "high");
  assert.ok(Number.isFinite(outcomes[0]?.elapsedSinceRoutingMs));
  assert.deepEqual(outcomes[0]?.usage, {
    inputTokens: 240,
    outputTokens: 80,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    totalTokens: 340,
    costUsd: 0.06,
  });
});

test("a routed run that ends before any assistant response records one aborted outcome", async () => {
  const { host, ctx } = harness({ config: automatic(), classify: classifier("deep") });
  await startSession(host, ctx);
  await host.fire("input", inputEvent(), ctx);

  const decision = decisionOf(host);
  assert.equal(decision?.applied, true, "the route must be applied for this case to be routed");

  // No message_end arrives: the run was aborted before generation was observable.
  await host.fire("agent_settled", { type: "agent_settled" }, ctx);

  const outcomes = outcomesOf(host);

  assert.equal(outcomes.length, 1, "an applied route still gets a terminal outcome");
  assert.equal(outcomes[0]?.decisionId, decision?.decisionId);
  assert.equal(outcomes[0]?.status, "aborted");
  assert.equal(outcomes[0]?.responses, 0);
  assert.equal(outcomes[0]?.stopReason, undefined);
});

test("partial usage stays unknown instead of becoming an observed zero", async () => {
  const { host, ctx } = harness({ config: automatic(), classify: classifier("deep") });
  await startSession(host, ctx);
  await host.fire("input", inputEvent(), ctx);
  await host.fire("message_end", routedMessage("provider-deep", "deep-model"), ctx);
  await host.fire(
    "message_end",
    routedMessage("provider-deep", "deep-model", {
      usage: {
        input: 80,
        output: 20,
        cacheRead: 5,
        totalTokens: 105,
      },
    }),
    ctx,
  );
  await host.fire("agent_settled", { type: "agent_settled" }, ctx);

  const outcome = outcomesOf(host)[0];
  assert.deepEqual(outcome?.usage, {
    inputTokens: 200,
    outputTokens: 60,
    cacheReadTokens: 15,
    totalTokens: 275,
  });
});

test("an errored routed generation is recorded as an error, not as success", async () => {
  const { host, ctx } = harness({ config: automatic(), classify: classifier("deep") });
  await startSession(host, ctx);
  await host.fire("input", inputEvent(), ctx);
  await host.fire(
    "message_end",
    routedMessage("provider-deep", "deep-model", { stopReason: "error" }),
    ctx,
  );
  await host.fire("agent_settled", { type: "agent_settled" }, ctx);

  const outcomes = outcomesOf(host);

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.status, "error");
  assert.equal(outcomes[0]?.stopReason, "error");
});

test("a shadow decision claims no routed generation outcome", async () => {
  const { host, ctx } = harness({ config: shadow(), classify: classifier("quick") });
  await startSession(host, ctx);
  await host.fire("input", inputEvent(), ctx);
  await host.fire("message_end", routedMessage("provider-quick", "quick-model"), ctx);
  await host.fire("agent_settled", { type: "agent_settled" }, ctx);

  assert.deepEqual(outcomesOf(host), []);
});

test("a decision that fell back to the current model claims no outcome", async () => {
  const { host, ctx } = harness({
    config: automatic(),
    classify: classifier("deep"),
    probe: async (target) => ({ target, passed: false, reason: "timeout", milliseconds: 1 }),
  });

  await startSession(host, ctx);
  await host.fire("input", inputEvent(), ctx);
  await host.fire("message_end", routedMessage("provider-quick", "quick-model"), ctx);
  await host.fire("agent_settled", { type: "agent_settled" }, ctx);

  assert.deepEqual(outcomesOf(host), []);
});

test("feedback binds to the newest decision on the branch and changes no routing", async () => {
  const decisionId = "0123456789abcdef";

  const { host, ctx, notifications, probes, models } = harness({
    classify: classifier("quick"),
    context: { branch: branchWithDecision(decisionId) },
  });

  await startSession(host, ctx);
  await host.fireCommand("feedback quick", ctx);

  const feedback = feedbackOf(host);

  assert.equal(feedback.length, 1);
  assert.equal(feedback[0]?.schemaVersion, 1);
  assert.equal(feedback[0]?.decisionId, decisionId);
  assert.equal(feedback[0]?.expectedRoute, "quick");
  assert.equal(feedback[0]?.skipped, false);
  assert.ok(notifications.some((message) => message.includes("Routing behavior is unchanged")));
  assert.deepEqual(probes, []);
  assert.deepEqual(models, []);
});

test("a skipped feedback names no route and is still recorded", async () => {
  const { host, ctx } = harness({
    context: { branch: branchWithDecision("0123456789abcdef") },
  });

  await startSession(host, ctx);
  await host.fireCommand("feedback skip", ctx);

  const feedback = feedbackOf(host);

  assert.equal(feedback.length, 1);
  assert.equal(feedback[0]?.skipped, true);
  assert.equal(feedback[0]?.expectedRoute, undefined);
});

test("feedback without an eligible decision is refused instead of guessed", async () => {
  const { host, ctx, notifications } = harness();
  await startSession(host, ctx);
  await host.fireCommand("feedback deep", ctx);

  assert.deepEqual(feedbackOf(host), []);
  assert.ok(
    notifications.some((message) => message.includes("No routing decision in this session")),
  );
});

test("feedback accepts only a class or skip, never free text", async () => {
  const { host, ctx, notifications } = harness({
    context: { branch: branchWithDecision("0123456789abcdef") },
  });

  await startSession(host, ctx);
  await host.fireCommand("feedback maybe", ctx);

  assert.deepEqual(feedbackOf(host), []);
  assert.ok(notifications.some((message) => message.includes("feedback")));
});

test("no session entry carries prompt text or a credential value", async () => {
  const plantedKey = "sk-live-PLANTED-CREDENTIAL-9999";
  const plantedPrompt = "rotate the billing database credential for the staging cluster";
  // Other tests in this file rely on the ambient key, so restore whatever was here before.
  const savedKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = plantedKey;

  try {
    const { host, ctx } = harness({ config: automatic(), classify: classifier("deep") });
    await startSession(host, ctx);
    await host.fire("input", inputEvent({ text: plantedPrompt }), ctx);
    await host.fire("message_end", routedMessage("provider-deep", "deep-model"), ctx);
    await host.fire("agent_settled", { type: "agent_settled" }, ctx);

    const serialized = JSON.stringify(host.entries);

    assert.ok(host.entries.some((entry) => entry.customType === `${NAME}-decision`));
    assert.ok(host.entries.some((entry) => entry.customType === `${NAME}-outcome`));
    assert.equal(serialized.includes("rotate the billing"), false, "prompt text leaked");
    assert.equal(serialized.includes(plantedKey), false, "credential value leaked");
  } finally {
    if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = savedKey;
  }
});

/** Write one policy artifact to a temporary file a configuration can point at. */
async function writePolicyFile(policy: RoutingPolicy, t: { after(callback: () => void): void }) {
  const directory = await mkdtemp(join(tmpdir(), "router-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "policy.json");
  await writeFile(path, JSON.stringify(policy));

  return path;
}

/** One valid external rubric artifact; each call returns a fresh object. */
function policyArtifact(id: string, question = "task_class"): RoutingPolicy {
  return {
    version: 1,
    id,
    question,
    type: "choice",
    instructions: "Classify the request under the external rubric.",
    criteria: { quick: "Quick.", standard: "Standard.", deep: "Deep.", uncertain: "Uncertain." },
  };
}

test("an external policyPath is the rubric the classifier sends and the hash a decision records", async (t) => {
  const external = policyArtifact("external-rubric", "external_class");

  const path = await writePolicyFile(external, t);
  let seen: RoutingPolicy | undefined;

  const { host, ctx } = harness({
    config: parseConfig({ ...baseConfigInput(), mode: "auto", policyPath: path }),
    classify: async (_backend, _state, call) => {
      seen = call.policy;

      return classification("quick");
    },
  });

  await startSession(host, ctx);
  assert.deepEqual(await host.fire("input", inputEvent(), ctx), { action: "continue" });

  assert.equal(seen?.id, external.id);
  assert.equal(seen?.question, external.question);
  assert.equal(decisionOf(host)?.provenance.policyId, external.id);
});

test("a policy rewritten between sessions is reloaded with the new rubric", async (t) => {
  const path = await writePolicyFile(policyArtifact("rubric-one"), t);
  const seen: string[] = [];

  const { host, ctx } = harness({
    config: parseConfig({ ...baseConfigInput(), mode: "auto", policyPath: path }),
    classify: async (_backend, _state, call) => {
      seen.push(call.policy.id);

      return classification("quick");
    },
  });

  await startSession(host, ctx);
  await host.fire("input", inputEvent(), ctx);
  assert.deepEqual(seen, ["rubric-one"]);
  assert.equal(decisionOf(host)?.provenance.policyId, "rubric-one");

  // The applied rubric is file state; a reload must pick up the rewrite rather than
  // keeping the rubric the previous session read.
  await writeFile(path, JSON.stringify(policyArtifact("rubric-two")));
  await startSession(host, ctx);
  await host.fire("input", inputEvent(), ctx);

  assert.deepEqual(seen, ["rubric-one", "rubric-two"]);
  assert.equal(decisionOf(host)?.provenance.policyId, "rubric-two");
});

test("a policy that becomes unreadable on reload disables routing", async (t) => {
  const path = await writePolicyFile(policyArtifact("rubric-one"), t);

  const { host, ctx, classified, notifications } = harness({
    config: parseConfig({ ...baseConfigInput(), mode: "auto", policyPath: path }),
    classify: classifier("quick"),
  });

  await startSession(host, ctx);
  await host.fire("input", inputEvent(), ctx);
  assert.equal(classified(), 1);

  await writeFile(path, "{ not a policy");
  await startSession(host, ctx);

  assert.deepEqual(await host.fire("input", inputEvent(), ctx), { action: "continue" });
  assert.equal(classified(), 1, "a reloaded bad policy must not fall back to the bundled rubric");
  assert.ok(notifications.some((message) => message.includes("Invalid router configuration")));
});

test("an unreadable policyPath disables routing instead of falling back to the bundled artifact", async () => {
  const { host, ctx, classified, notifications } = harness({
    config: parseConfig({
      ...baseConfigInput(),
      mode: "auto",
      policyPath: "/nonexistent/pi-typesafe-router-policy.json",
    }),
    classify: classifier("quick"),
  });

  await startSession(host, ctx);
  assert.deepEqual(await host.fire("input", inputEvent(), ctx), { action: "continue" });
  assert.equal(classified(), 0, "an unreadable policy must not fall back to the bundled rubric");
  assert.ok(notifications.some((message) => message.includes("Invalid router configuration")));
});

test("a live doctor persists proofs that a reload restores without re-probing", async () => {
  const { host, ctx, probes } = harness({
    config: automatic(),
    classify: classifier("quick"),
    branchFromEntries: true,
  });

  await startSession(host, ctx);
  await host.fireCommand("doctor live", ctx);

  assert.ok(
    verificationOf(host).some((entry) => entry.verified),
    "a successful live doctor must persist its proofs",
  );

  const probesAfterDoctor = probes.length;
  // A reload clears the in-memory store and rebuilds it from the session branch.
  await startSession(host, ctx);
  await host.fire("input", inputEvent(), ctx);

  assert.equal(probes.length, probesAfterDoctor, "restored proofs must not be re-probed");
});

test("a reload tombstones persisted proofs whose fingerprint no longer matches", async () => {
  const { host, ctx } = harness({
    config: automatic(),
    classify: classifier("quick"),
    branchFromEntries: true,
  });

  await startSession(host, ctx);
  await host.fireCommand("doctor live", ctx);
  const before = host.entries.length;

  // Rotate a registry fact every target fingerprint covers, then reload the session.
  ctx.modelRegistry.getRegisteredProviderConfig = () => ({ apiKey: "changed-reference" });
  await startSession(host, ctx);

  const appended = verificationOf(host);
  assert.equal(appended.at(-1)?.verified, false, "a stale fingerprint must be tombstoned");
  assert.ok(
    host.entries.slice(before).some((entry) => entry.customType === `${NAME}-verification`),
    "the tombstone is a new session entry",
  );
});
