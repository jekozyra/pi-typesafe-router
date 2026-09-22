import { createHash } from "node:crypto";
import type { RouterContext } from "./host.ts";
import { targetKey, type RouterConfig, type Target } from "./types.ts";

const providerIdentities = new WeakMap<
  NonNullable<ReturnType<RouterContext["modelRegistry"]["getProvider"]>>,
  number
>();

let nextIdentity = 0;

function providerIdentity(provider: ReturnType<RouterContext["modelRegistry"]["getProvider"]>) {
  if (!provider) return null;
  const previous = providerIdentities.get(provider);

  if (previous !== undefined) return previous;
  const identity = ++nextIdentity;
  providerIdentities.set(provider, identity);

  return identity;
}

export function configuredTargets(config: RouterConfig) {
  const targets = new Map<string, Target>();

  for (const chain of Object.values(config.routes))
    for (const target of chain) targets.set(targetKey(target), target);

  return [...targets.values()];
}

/** Hash configuration and resolved registry references; never persist or display credential material. */
export function verificationFingerprint(
  config: RouterConfig,
  registry: RouterContext["modelRegistry"],
) {
  const { showFooterStatus: _showFooterStatus, ...routingConfig } = config;
  const targets = configuredTargets(config);
  const providerIds = new Set(targets.map((target) => target.provider));

  if (config.backend.auth.source === "pi") providerIds.add(config.backend.auth.provider);

  const providers = [...providerIds].map((provider) => ({
    provider,
    // Pi replaces the composed provider when models.json/native registration changes.
    identity: providerIdentity(registry.getProvider(provider)),
    authSource: registry.getProviderAuthStatus(provider),
    extensionConfig: registry.getRegisteredProviderConfig(provider),
  }));

  const models = targets.map((target) => ({
    target,
    model: registry.find(target.provider, target.model),
  }));

  return createHash("sha256")
    .update(JSON.stringify({ config: routingConfig, providers, models }))
    .digest("hex");
}

export interface VerifiedGeneration {
  fingerprint: string;
  passed: Set<string>;
  checkedAt: string;
}
