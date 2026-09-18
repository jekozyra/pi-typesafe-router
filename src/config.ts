import { z } from "zod";
import type { RouterConfig } from "./types.ts";

const virtualProviders = new Set(["auto", "smart-router", "typesafe-router"]);
const identifier = z.string().min(1).max(512).refine((value) => value.trim() === value && !/\s|[\u0000-\u001f\u007f]/u.test(value));
const provider = identifier.refine((value) => !value.includes("/") && !virtualProviders.has(value.toLowerCase()));
const auth = z.discriminatedUnion("source", [
  z.object({ source: z.literal("env"), variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/u).max(256) }).strict(),
  z.object({ source: z.literal("pi"), provider }).strict(),
]);
const envAuth = (variable: string) => ({ source: "env" as const, variable });
const backend = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("typesafe"),
    model: identifier.default("jev-1.13.0"),
    auth: auth.default(envAuth("TYPESAFE_API_KEY")),
  }).strict(),
  z.object({
    type: z.literal("cloudflare"),
    model: z.literal("typesafe/jev").default("typesafe/jev"),
    accountId: z.string().length(32).regex(/^[a-fA-F0-9]{32}$/u),
    auth: auth.default(envAuth("CLOUDFLARE_API_TOKEN")),
  }).strict(),
  z.object({
    type: z.literal("vercel"),
    model: z.literal("typesafe-ai/jev").default("typesafe-ai/jev"),
    auth: auth.default(envAuth("AI_GATEWAY_API_KEY")),
    zeroDataRetention: z.boolean().default(true),
  }).strict(),
]);
const target = z.object({ provider, model: identifier }).strict();
const chain = z.array(target).min(1).max(8).refine((targets) => {
  const keys = targets.map(({ provider, model }) => JSON.stringify([provider, model]));
  return new Set(keys).size === keys.length;
});
const route = z.enum(["quick", "standard", "deep"]);
const schema = z.object({
  version: z.literal(1).default(1),
  mode: z.enum(["off", "shadow", "auto"]).default("off"),
  allowHeadless: z.boolean().default(false),
  backend: backend.default({ type: "typesafe", model: "jev-1.13.0", auth: envAuth("TYPESAFE_API_KEY") }),
  timeoutMs: z.number().int().min(100).max(30_000).default(1500),
  minConfidence: z.number().min(0).max(1).default(0.8),
  maxContextChars: z.number().int().min(256).max(32_000).default(12_000),
  historyMessages: z.number().int().min(0).max(20).default(4),
  outputReserveTokens: z.number().int().min(256).max(131_072).default(8192),
  routes: z.object({ quick: chain, standard: chain, deep: chain }).strict(),
  defaultRoute: route.default("deep"),
  uncertainRoute: route.default("deep"),
}).strict();

/** Never expose Zod issues: even paths and unknown-key diagnostics can contain secrets. */
export function parseConfig(value: unknown): RouterConfig {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("Invalid router configuration; check the documented schema.");
  return result.data;
}
