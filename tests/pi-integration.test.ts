import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CustomEntry,
  type ExtensionError,
} from "@earendil-works/pi-coding-agent";

const provider = "router-integration-fixture";
const selectedId = "first-eligible";
const initialId = "initial-and-fallback";
const dummyKey = "integration-dummy-key-not-a-secret";

/** Real Pi loader/session/provider plumbing; only generation and HTTP are synthetic. */
async function fixture(t: TestContext, failGeneration = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-typesafe-router-sdk-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const envNames = ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "TEST_TYPESAFE_KEY"] as const;
  const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  let session: AgentSession | undefined;
  t.after(async () => {
    try {
      if (session) {
        await session.abort();
        session.dispose();
      }
    } finally {
      for (const [name, value] of savedEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  delete process.env.TEST_TYPESAFE_KEY;
  // No paid/network calls are permitted, even if the extension regresses.
  const http = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Integration smoke tests forbid network requests");
  });
  await mkdir(cwd);
  await mkdir(agentDir);
  const chain = [selectedId, initialId].map((model) => ({ provider, model }));
  await writeFile(join(agentDir, "typesafe-router.json"), JSON.stringify({
    version: 1,
    mode: "auto",
    allowHeadless: true,
    backend: { type: "typesafe", auth: { source: "env", variable: "TEST_TYPESAFE_KEY" } },
    routes: { quick: chain, standard: chain, deep: chain },
    defaultRoute: "standard",
    uncertainRoute: "deep",
    outputReserveTokens: 256,
  }));

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const generations: Array<{ provider: string; model: string }> = [];
  modelRuntime.registerProvider(provider, {
    api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1",
    apiKey: dummyKey,
    models: [selectedId, initialId].map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
    })),
    streamSimple(model) {
      generations.push({ provider: model.provider, model: model.id });
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
        stopReason: "pending",
      };
      stream.push({ type: "start", partial: message });
      if (failGeneration) {
        message.stopReason = "error";
        message.errorMessage = "503 synthetic generation failure";
        stream.push({ type: "error", reason: "error", error: message });
      } else {
        message.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        message.content[0] = { type: "text", text: "synthetic reply" };
        stream.push({ type: "text_delta", contentIndex: 0, delta: "synthetic reply", partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: "synthetic reply", partial: message });
        message.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message });
      }
      stream.end();
      return stream;
    },
  });
  await modelRuntime.setRuntimeApiKey(provider, dummyKey);
  const initialModel = modelRuntime.getModel(provider, initialId);
  assert.ok(initialModel);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  // Import after setting the profile: no config override API is required.
  const { default: routerExtension } = await import("../src/index.ts");
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Reply briefly. This is an isolated integration test.",
    appendSystemPrompt: [],
    extensionFactories: [routerExtension],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  assert.equal(resourceLoader.getExtensions().extensions.length, 1);
  const sessionManager = SessionManager.inMemory(cwd);
  const created = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    modelRuntime,
    model: initialModel,
    thinkingLevel: "off",
    noTools: "all",
    settingsManager,
    sessionManager,
  });
  session = created.session;
  const errors: ExtensionError[] = [];
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  // SDK creation alone does not emit session_start. Print binding supplies the
  // headless mode and invokes startup hooks, just as the built-in print runner.
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  assert.deepEqual(errors, []);
  const sendUserMessage = t.mock.method(session, "sendUserMessage");
  const records = () => sessionManager.getEntries().filter(
    (entry): entry is CustomEntry => entry.type === "custom" && entry.customType.startsWith("typesafe-router"),
  );
  return { session, sessionManager, generations, records, errors, events, http, sendUserMessage };
}

// These tests mutate process env and fetch. Keep them serial; node:test isolates
// other test files in separate processes under the project's test command.
describe("real Pi SDK integration", { concurrency: false }, () => {
  it("loads the extension and selects the default route's first eligible model before generation", async (t) => {
    const f = await fixture(t);
    assert.equal(f.session.model?.id, initialId);
    const before = f.records().length;
    await f.session.prompt("Explain a small function.");
    assert.equal(f.session.model?.id, selectedId);
    assert.deepEqual(f.generations, [{ provider, model: selectedId }]);
    const appended = f.records().slice(before);
    assert.ok(appended.length > 0, "routing must append a custom decision entry");
    const recordData = JSON.stringify(appended.map((entry) => entry.data));
    assert.ok(recordData.includes("standard"), "missing classifier credentials must use defaultRoute, not uncertainRoute");
    assert.ok(recordData.includes(selectedId), "decision entry must identify the selected model");
    assert.equal(f.session.messages.filter((message) => message.role === "user").length, 1);
    assert.equal(f.sendUserMessage.mock.callCount(), 0);
    assert.equal(f.http.mock.callCount(), 0, "missing classifier key must short-circuit before HTTP");
    assert.deepEqual(f.errors, []);
  });

  it("/typesafe-router off disables routing and subsequent input passes through unchanged", async (t) => {
    const f = await fixture(t);
    await f.session.prompt("/typesafe-router off");
    assert.deepEqual(f.generations, [], "the slash command itself must not generate");
    assert.equal(f.session.model?.id, initialId);
    const before = f.records().length;
    const prompt = "Keep this request exactly as entered.";
    await f.session.prompt(prompt);
    assert.deepEqual(f.generations, [{ provider, model: initialId }]);
    assert.equal(f.session.model?.id, initialId);
    assert.equal(f.records().length, before, "off mode must not append routing decisions");
    const users = f.session.messages.filter((message) => message.role === "user");
    assert.equal(users.length, 1);
    assert.deepEqual(users[0]?.content, [{ type: "text", text: prompt }]);
    assert.equal(f.sendUserMessage.mock.callCount(), 0);
    assert.equal(f.http.mock.callCount(), 0);
    assert.deepEqual(f.errors, []);
  });

  it("generation failure does not resend the prompt or fall back to another model", async (t) => {
    const f = await fixture(t, true);
    await f.session.prompt("Trigger the synthetic generation failure.");
    await f.session.agent.waitForIdle();
    assert.deepEqual(f.generations, [{ provider, model: selectedId }]);
    assert.equal(f.session.model?.id, selectedId);
    assert.equal(f.sendUserMessage.mock.callCount(), 0, "router must never replay a failed generation");
    assert.equal(f.session.messages.filter((message) => message.role === "user").length, 1);
    const assistants = f.session.messages.filter((message) => message.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0]?.stopReason, "error");
    assert.match(assistants[0]?.errorMessage ?? "", /synthetic generation failure/);
    assert.equal(f.events.filter((event) => event.type === "agent_start").length, 1);
    assert.equal(f.events.filter((event) => event.type === "auto_retry_start").length, 0);
    assert.equal(f.session.agent.hasQueuedMessages(), false);
    assert.equal(f.session.isIdle, true);
    assert.equal(f.http.mock.callCount(), 0);
    assert.deepEqual(f.errors, []);
  });
});
