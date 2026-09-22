import { isAbsolute } from "node:path";
import { z } from "zod";
import { HISTORY_ROLES, THINKING_LEVELS } from "./types.ts";

const virtualProviders = new Set(["auto", "smart-router", "typesafe-router"]);

const identifier = z
  .string()
  .min(1)
  .max(512)
  // Reject control characters in identifiers before displaying them in the terminal.
  // oxlint-disable-next-line no-control-regex
  .refine((value) => value.trim() === value && !/\s|[\u0000-\u001f\u007f]/u.test(value));

const provider = identifier.refine(
  (value) => !value.includes("/") && !virtualProviders.has(value.toLowerCase()),
);

const auth = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("env"),
      variable: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/u)
        .max(256),
    })
    .strict(),
  z.object({ source: z.literal("pi"), provider }).strict(),
]);

const envAuth = (variable: string) => ({ source: "env" as const, variable });

const backend = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("typesafe"),
      model: identifier.default("jev-1.13.0"),
      auth: auth.default(envAuth("TYPESAFE_API_KEY")),
    })
    .strict(),
  z
    .object({
      type: z.literal("cloudflare"),
      model: z.literal("typesafe/jev").default("typesafe/jev"),
      accountId: z
        .string()
        .length(32)
        .regex(/^[a-fA-F0-9]{32}$/u),
      gatewayId: identifier,
      auth: auth.default(envAuth("CLOUDFLARE_API_TOKEN")),
    })
    .strict(),
  z
    .object({
      type: z.literal("vercel"),
      model: z.literal("typesafe-ai/jev").default("typesafe-ai/jev"),
      auth: auth.default(envAuth("AI_GATEWAY_API_KEY")),
      zeroDataRetention: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      type: z.literal("openrouter"),
      model: z.literal("typesafe/jev-1.13").default("typesafe/jev-1.13"),
      auth: auth.default(envAuth("OPENROUTER_API_KEY")),
    })
    .strict(),
]);

const target = z
  .object({
    provider,
    model: identifier,
    thinking: z.enum(THINKING_LEVELS).default("high"),
  })
  .strict();

const chain = z
  .array(target)
  .min(1)
  .max(8)
  .refine((targets) => {
    const keys = targets.map(({ provider, model }) => JSON.stringify([provider, model]));

    return new Set(keys).size === keys.length;
  });

const route = z.enum(["quick", "standard", "deep"]);

/**
 * An external rubric is a path, and a path is not a value to echo. Padding, control
 * characters, and non-absolute paths are rejected here so the resolver only ever sees a
 * well-formed absolute path.
 */
const policyPath = z
  .string()
  .min(1)
  .max(4096)
  // oxlint-disable-next-line no-control-regex -- control characters are what is rejected
  .refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value))
  .refine((value) => isAbsolute(value));

/** Fields both config versions share. */
const common = {
  mode: z.enum(["off", "shadow", "auto"]).default("off"),
  allowHeadless: z.boolean().default(false),
  backend: backend.default({
    type: "typesafe",
    model: "jev-1.13.0",
    auth: envAuth("TYPESAFE_API_KEY"),
  }),
  timeoutMs: z.number().int().min(100).max(30_000).default(1500),
  generationProbeTimeoutMs: z.number().int().min(100).max(60_000).default(15_000),
  minConfidence: z.number().min(0).max(1).default(0.8),
  maxContextChars: z.number().int().min(256).max(32_000).default(12_000),
  historyMessages: z.number().int().min(0).max(20).default(4),
  outputReserveTokens: z.number().int().min(256).max(131_072).default(8192),
  routes: z.object({ quick: chain, standard: chain, deep: chain }).strict(),
  defaultRoute: route.default("deep"),
  uncertainRoute: route.default("deep"),
  policyPath: policyPath.optional(),
};

// Version 1 keeps the historical projection. Version 2 states it, so a reader can see what
// leaves the machine without reading the extension source. A document with no `version` is
// version 1, which is what an already-installed file and an older upstream file both are.
const v1 = z.object({ ...common, version: z.literal(1).default(1) }).strict();

const v2 = z
  .object({
    ...common,
    version: z.literal(2),
    historyRoles: z
      .array(z.enum(HISTORY_ROLES))
      .min(1)
      .max(2)
      .default(["user"])
      .refine((roles) => new Set(roles).size === roles.length),
  })
  .strict();

const schema = z.union([v2, v1]);

/** Never expose Zod issues: even paths and unknown-key diagnostics can contain secrets. */
export const parseConfig = schema.catch(() => {
  throw new Error("Invalid router configuration; check the documented schema.");
}).parse;
