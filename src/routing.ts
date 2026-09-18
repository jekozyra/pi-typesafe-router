import type { CandidateCheck, Classification, Eligibility, Route, RouterConfig, Target } from "./types.ts";

const virtualProviders = new Set(["auto", "smart-router", "typesafe-router"]);
const positiveFinite = (value: number): boolean => Number.isFinite(value) && value > 0;

/** Deterministic preflight only; preserve configured order, never perform runtime retries. */
export function candidateChecks(targets: readonly Target[], eligibility: Eligibility): CandidateCheck[] {
  return targets.map((target) => {
    const reject = (reason: string): CandidateCheck => ({ target, eligible: false, reason });
    if (virtualProviders.has(target.provider.toLowerCase())) return reject("virtual-provider");
    const model = eligibility.models.find((item) => item.provider === target.provider && item.id === target.model);
    if (!model) return reject("unknown-model");
    if (!eligibility.available.some((item) => item.provider === target.provider && item.id === target.model)) return reject("unavailable");
    if (eligibility.scope.length && !eligibility.scope.some((item) => item.provider === target.provider && item.model === target.model)) return reject("out-of-scope");
    if (eligibility.hasImages && !model.input.includes("image")) return reject("image-unsupported");
    if (!positiveFinite(model.contextWindow) || !positiveFinite(model.maxTokens)) return reject("invalid-model-limits");
    if (!Number.isFinite(eligibility.inputTokens) || eligibility.inputTokens < 0 || !positiveFinite(eligibility.outputReserveTokens)) return reject("invalid-token-budget");
    const reserve = Math.min(eligibility.outputReserveTokens, model.maxTokens);
    if (eligibility.inputTokens + reserve > model.contextWindow) return reject("context-overflow");
    return { target, eligible: true };
  });
}

export function chooseRoute(classification: Classification | undefined, config: RouterConfig): Route {
  if (!classification) return config.defaultRoute;
  const { choice, confidence } = classification;
  if (choice === "uncertain" || confidence === undefined || !Number.isFinite(confidence)
    || confidence < config.minConfidence || confidence < 0 || confidence > 1
    || !["quick", "standard", "deep"].includes(choice)) return config.uncertainRoute;
  return choice;
}
