/**
 * Shared fixtures for the router's offline suite.
 *
 * Pi ships its packages only inside the bundled executable, so bare
 * `@earendil-works/*` specifiers do not resolve under plain Node. `installPiStubs()`
 * registers a loader hook that answers those three specifiers with small in-memory
 * modules before any subject module is imported. Call it at the top of a test file and
 * import the subjects dynamically afterwards:
 *
 *     import { installPiStubs } from "./harness.ts";
 *     installPiStubs();
 *     const { chooseRoute } = await import("../src/routing.ts");
 *
 * The stubs implement only what the extension reads. They are test doubles, not models of
 * Pi: assertions here never claim Pi's own behavior, only the extension's use of it.
 */

import { register } from "node:module";

import type { Model } from "@earendil-works/pi-ai";

import type { Target, ThinkingLevel } from "../src/types.ts";

/** Pi estimates prompt size from message content; the exact arithmetic is Pi's business. */
const PI_CODING_AGENT_STUB = `
export const getAgentDir = () => "/tmp/pi-agent-dir";
export const estimateTokens = (message) => {
  const content = message && message.content;
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  return Math.max(1, Math.ceil(text.length / 4));
};
export const convertToLlm = (messages) => messages;
export const buildSessionContext = (entries) => ({
  messages: (entries ?? []).flatMap((entry) =>
    entry && entry.type === "message" && entry.message ? [entry.message] : [],
  ),
  thinkingLevel: "off",
  model: undefined,
});
`;

const PI_TUI_STUB = `
export const matchesKey = (data, key) => data === key;
`;

const PI_AI_STUB = `
export const PI_AI_STUB = true;
`;

const STUB_SOURCES = {
  "@earendil-works/pi-ai": PI_AI_STUB,
  "@earendil-works/pi-tui": PI_TUI_STUB,
  "@earendil-works/pi-coding-agent": PI_CODING_AGENT_STUB,
} satisfies Record<string, string>;

let installed = false;

/** Idempotent per process. Must run before the first dynamic import of a subject module. */
export function installPiStubs(): void {
  if (installed) return;
  installed = true;

  const hook = `
const SOURCES = ${JSON.stringify(STUB_SOURCES)};
export async function resolve(specifier, context, next) {
  const source = SOURCES[specifier];
  if (source !== undefined) {
    return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
  }
  return next(specifier, context);
}
`;

  register(`data:text/javascript,${encodeURIComponent(hook)}`);
}

/** A fresh, schema-valid router configuration. Fictional IDs; no provider is contacted. */
export function baseConfigInput() {
  return {
    version: 1,
    mode: "off",
    allowHeadless: false,
    backend: {
      type: "typesafe",
      model: "jev-1.13.0",
      auth: { source: "env", variable: "TYPESAFE_API_KEY" },
    },
    timeoutMs: 1500,
    generationProbeTimeoutMs: 15_000,
    minConfidence: 0.8,
    maxContextChars: 12_000,
    historyMessages: 4,
    outputReserveTokens: 8192,
    routes: {
      quick: [{ provider: "provider-quick", model: "quick-model", thinking: "low" }],
      standard: [{ provider: "provider-standard", model: "standard-model", thinking: "medium" }],
      deep: [{ provider: "provider-deep", model: "deep-model", thinking: "high" }],
    },
    defaultRoute: "deep",
    uncertainRoute: "deep",
  };
}

/** A version-2 configuration: the projection is stated, and it is user-only. */
export function baseConfigInputV2() {
  return { ...baseConfigInput(), version: 2, historyRoles: ["user"] };
}

/** A catalogue entry with usable limits unless a test overrides one. */
export function model(
  provider: string,
  id: string,
  overrides: Partial<{
    input: ("text" | "image")[];
    contextWindow: number;
    maxTokens: number;
  }> = {},
): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
    ...overrides,
  };
}

/** A `RouterConfig["routes"]`-shaped chain helper. */
export function target(provider: string, id: string, thinking: ThinkingLevel = "high"): Target {
  return { provider, model: id, thinking };
}

/** The base fixture's route map, typed so callers can spread and patch one chain. */
export function baseRoutes() {
  return baseConfigInput().routes;
}
