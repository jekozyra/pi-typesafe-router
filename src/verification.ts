import { createHash } from "node:crypto";
import type { RouterContext } from "./host.ts";
import { targetKey, type RouterConfig, type Target } from "./types.ts";

type Registry = RouterContext["modelRegistry"];

const providerIdentities = new WeakMap<NonNullable<ReturnType<Registry["getProvider"]>>, number>();

let nextIdentity = 0;

function providerIdentity(provider: ReturnType<Registry["getProvider"]>) {
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
export function verificationFingerprint(config: RouterConfig, registry: Registry) {
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

  return createHash("sha256").update(JSON.stringify({ config, providers, models })).digest("hex");
}

/**
 * The resolved facts one target's access proof depends on: the target itself, the composed
 * provider's identity and auth state, and the catalogue entry that will actually be requested.
 *
 * Nothing here is persisted or displayed. Only a digest of it is kept, and only in memory.
 */
function targetEvidence(target: Target, registry: Registry) {
  return {
    target,
    provider: {
      provider: target.provider,
      identity: providerIdentity(registry.getProvider(target.provider)),
      authStatus: registry.getProviderAuthStatus(target.provider),
      registeredConfig: registry.getRegisteredProviderConfig(target.provider),
    },
    model: registry.find(target.provider, target.model) ?? null,
  };
}

/**
 * Hash one target alone. A change invalidates only this target's proof, so an unrelated
 * route's breakage never discards a proof that is still true.
 */
export function targetFingerprint(target: Target, registry: Registry): string {
  return createHash("sha256")
    .update(JSON.stringify(targetEvidence(target, registry)))
    .digest("hex");
}

export interface TargetProof {
  target: Target;
  fingerprint: string;
  checkedAt: string;
}

/** One persisted proof: the target plus the fingerprint it was earned against. */
export type StoredProof = TargetProof;

/**
 * Session-scoped generation access proofs.
 *
 * A proof records that one exact target answered a synthetic request. It is valid only while
 * the target and the resolved model/provider facts it was earned against are unchanged, and
 * it is discarded on restart, reload, and shutdown. Holding proofs in memory is deliberate:
 * a persisted proof would claim validity across credential and catalogue changes this process
 * cannot observe.
 *
 * A caller may serialize `entries()` into a session entry and, after revalidating each
 * fingerprint against the current registry, restore it with `adopt`. The store itself never
 * reads or writes a session file, so it cannot restore a proof it has not checked.
 */
export class ProofStore {
  readonly #proofs = new Map<string, TargetProof>();

  /** The stored proof for this target, or `undefined` when it is absent or stale. */
  valid(target: Target, registry: Registry): TargetProof | undefined {
    const proof = this.#proofs.get(targetKey(target));

    if (!proof) return undefined;

    return proof.fingerprint === targetFingerprint(target, registry) ? proof : undefined;
  }

  /**
   * Adopt a proof whose fingerprint the caller has already validated. Passing an unvalidated
   * fingerprint here would let a stale proof claim a target, so only restore code calls it.
   */
  adopt(target: Target, fingerprint: string, checkedAt: string): void {
    this.#proofs.set(targetKey(target), { target, fingerprint, checkedAt });
  }

  remember(target: Target, registry: Registry): void {
    this.#proofs.set(targetKey(target), {
      target,
      fingerprint: targetFingerprint(target, registry),
      checkedAt: new Date().toISOString(),
    });
  }

  /** The subset of `targets` whose proofs are still current. */
  validKeys(registry: Registry, targets: readonly Target[]): Set<string> {
    const keys = new Set<string>();

    for (const target of targets) if (this.valid(target, registry)) keys.add(targetKey(target));

    return keys;
  }

  /** A snapshot for persistence, in insertion order. */
  entries(): TargetProof[] {
    return [...this.#proofs.values()];
  }

  get size(): number {
    return this.#proofs.size;
  }

  clear(): void {
    this.#proofs.clear();
  }
}
