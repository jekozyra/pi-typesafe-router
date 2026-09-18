export const TASK_CLASSES = ["quick", "standard", "deep", "uncertain"] as const;

export type TaskClass = (typeof TASK_CLASSES)[number];

export type Route = Exclude<TaskClass, "uncertain">;

export type Mode = "off" | "shadow" | "auto";

export type CredentialSource =
  | { source: "env"; variable: string }
  | { source: "pi"; provider: string };

export type Backend =
  | { type: "typesafe"; model: string; auth: CredentialSource }
  | { type: "cloudflare"; model: "typesafe/jev"; accountId: string; auth: CredentialSource }
  | {
      type: "vercel";
      model: "typesafe-ai/jev";
      auth: CredentialSource;
      zeroDataRetention: boolean;
    };

export interface Target {
  provider: string;
  model: string;
}

export interface RouterConfig {
  version: 1;
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
  | "http";

export class ClassifierError extends Error {
  constructor(
    public readonly code: ClassifierFailureCode,
    public readonly status?: number,
  ) {
    super(status === undefined ? `Classifier ${code}` : `Classifier ${code} (HTTP ${status})`);
    this.name = "ClassifierError";
  }
}

export interface ClassifyOptions {
  signal: AbortSignal;
  apiKey: string;
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
