export const TASK_CLASSES = ["quick", "standard", "deep", "uncertain"] as const;

export type TaskClass = (typeof TASK_CLASSES)[number];

export type Route = Exclude<TaskClass, "uncertain">;

export type Mode = "off" | "shadow" | "auto";

export type CredentialSource =
  | { source: "env"; variable: string }
  | { source: "pi"; provider: string };

export const BACKEND_TYPES = ["typesafe", "cloudflare", "vercel", "openrouter"] as const;

export type BackendType = (typeof BACKEND_TYPES)[number];

export function isBackendType(value: string): value is BackendType {
  return BACKEND_TYPES.some((backend) => backend === value);
}

export type Backend =
  | { type: "typesafe"; model: string; auth: CredentialSource }
  | {
      type: "cloudflare";
      model: "typesafe/jev";
      accountId: string;
      gatewayId: string;
      auth: CredentialSource;
    }
  | {
      type: "vercel";
      model: "typesafe-ai/jev";
      auth: CredentialSource;
      zeroDataRetention: boolean;
    }
  | { type: "openrouter"; model: "typesafe/jev-1.13"; auth: CredentialSource };

export const HISTORY_ROLES = ["user", "assistant"] as const;

export type HistoryRole = (typeof HISTORY_ROLES)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface Target {
  provider: string;
  model: string;
  /** Thinking level applied after this target is selected. */
  thinking: ThinkingLevel;
}

export interface RouterConfigCommon {
  mode: Mode;
  allowHeadless: boolean;
  backend: Backend;
  timeoutMs: number;
  generationProbeTimeoutMs: number;
  minConfidence: number;
  maxContextChars: number;
  historyMessages: number;
  outputReserveTokens: number;
  routes: Record<Route, Target[]>;
  defaultRoute: Route;
  uncertainRoute: Route;
  /**
   * Absolute path to an external classifier rubric. Omitted means the `policy.json` bundled
   * beside the extension is used. The file is validated with the same strict schema, and an
   * unreadable or invalid file disables routing rather than falling back silently.
   */
  policyPath?: string;
}

/** Config version 1: the historical projection, which disclosed assistant text too. */
export interface RouterConfigV1 extends RouterConfigCommon {
  version: 1;
}

/** Config version 2: an explicit projection policy, user-only by default. */
export interface RouterConfigV2 extends RouterConfigCommon {
  version: 2;
  historyRoles: HistoryRole[];
}

export type RouterConfig = RouterConfigV1 | RouterConfigV2;

/**
 * The roles a config projects into classifier state.
 *
 * Version 1 predates the setting and keeps its user-and-assistant behavior so an existing
 * file is not silently reinterpreted. Version 2 states the policy in the file; the generated
 * Home configuration and `/typesafe-router setup` both choose user-only.
 */
export function historyRoles(config: RouterConfig): readonly HistoryRole[] {
  return config.version === 2 ? config.historyRoles : ["user", "assistant"];
}

export interface ClassificationState {
  current_request: string;
  recent_conversation: Array<{ role: "user" | "assistant"; text: string }>;
}

export interface Classification {
  choice: TaskClass;
  probabilities: Record<TaskClass, number>;
  confidence?: number;
  requestedModel: string;
  returnedModel?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export type ClassifierFailureCode =
  | "credentials"
  | "timeout"
  | "cancelled"
  | "network"
  | "invalid-response"
  | "model-mismatch"
  | "http";

// Explicit fields rather than constructor parameter properties: parameter properties are not
// erasable syntax, so Node's strip-only TypeScript mode (the offline test runner) rejects them.
export class ClassifierError extends Error {
  readonly code: ClassifierFailureCode;
  readonly status?: number;

  constructor(code: ClassifierFailureCode, status?: number) {
    super(status === undefined ? `Classifier ${code}` : `Classifier ${code} (HTTP ${status})`);
    this.name = "ClassifierError";
    this.code = code;
    this.status = status;
  }
}

/**
 * The validated classifier rubric: the instructions and criteria sent to the backend, plus
 * the question key that carries them. Produced from the bundled artifact or a config's
 * `policyPath`, never hard-coded in the transport.
 */
export interface RoutingPolicy {
  version: 1;
  id: string;
  question: string;
  type: "choice";
  instructions: string;
  criteria: Record<TaskClass, string>;
}

export interface ClassifyOptions {
  signal: AbortSignal;
  apiKey: string;
  /** The rubric this call must send, resolved from the applied configuration. */
  policy: RoutingPolicy;
}

export type Classify = (
  backend: Backend,
  state: ClassificationState,
  options: ClassifyOptions,
) => Promise<Classification>;

export interface ModelInfo {
  provider: string;
  id: string;
  input: readonly string[];
  contextWindow: number;
  maxTokens: number;
}

export interface Eligibility {
  models: readonly ModelInfo[];
  available: readonly ModelInfo[];
  scope: readonly Target[];
  hasImages: boolean;
  inputTokens: number | null;
  outputReserveTokens: number;
}

export interface CandidateCheck {
  target: Target;
  eligible: boolean;
  reason?: string;
}

export const targetKey = (target: Target): string => `${target.provider}/${target.model}`;
