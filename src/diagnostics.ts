import type { GenerationProbeResult } from "./generation-probe.ts";
import {
  targetKey,
  type CandidateCheck,
  type Classification,
  type ClassifierFailureCode,
  type Mode,
  type RouterConfig,
} from "./types.ts";

export interface EvaluationResult {
  classification?: Classification;
  reason: string;
  failure?: { code: ClassifierFailureCode | "unavailable"; status?: number };
}

export function runtimeLines(
  mode: Mode,
  activity: string,
  path: string,
  config?: RouterConfig,
  classifierReport?: readonly string[],
) {
  return [
    `runtime: node ${process.version} ${process.platform} ${process.arch}`,
    `config path: ${path}`,
    `routing: ${mode}${mode === "off" ? " (automatic routing is disabled)" : ""}`,
    `activity: ${activity}`,
    ...(config
      ? [
          ...(classifierReport ?? [`classifier: ${config.backend.type} / ${config.backend.model}`]),
          `auth: ${config.backend.auth.source === "env" ? `environment ${config.backend.auth.variable}` : `Pi provider ${config.backend.auth.provider}`}`,
          `routing policy: timeout ${config.timeoutMs}ms; minimum confidence ${config.minConfidence}; default ${config.defaultRoute}; uncertain ${config.uncertainRoute}`,
        ]
      : ["classifier: not configured"]),
  ];
}

const candidateReasons = new Map(
  Object.entries({
    "unknown-model": "model not found in Pi's catalogue; choose an exact ID from /model",
    unavailable: "generation credentials not configured in Pi",
    "out-of-scope": "excluded by Pi's current model scope",
    "image-unsupported": "cannot accept images in this conversation",
    "invalid-model-limits": "model context/output limits are missing or invalid",
    "invalid-token-budget": "conversation size could not be safely estimated",
    "context-overflow":
      "conversation plus output reserve exceeds this model's context; compact or choose a larger model",
    "virtual-provider": "virtual routers cannot be generation targets",
  }),
);

export function routeLines(
  routes: Record<string, CandidateCheck[]>,
  probes: readonly GenerationProbeResult[],
) {
  const results = new Map(probes.map((probe) => [targetKey(probe.target), probe]));

  return [
    "routes:",
    ...Object.entries(routes).flatMap(([route, candidates]) => [
      `  ${route}:`,
      ...candidates.map((candidate) => {
        const key = targetKey(candidate.target);
        const probe = results.get(key);

        const outcome = probe
          ? `${probe.passed ? "✅ passed" : "❌ failed"} in ${probe.milliseconds} ms${probe.passed ? "" : ` (${probe.reason})`}`
          : "not checked";

        const restriction = candidate.eligible
          ? ""
          : `; not routable: ${candidateReasons.get(candidate.reason ?? "") ?? candidate.reason ?? "ineligible; no reason supplied"}`;

        return `    ${key}\n    ${outcome}${restriction}`;
      }),
    ]),
  ];
}

export function classifierLines(result: EvaluationResult, elapsedMs: number, config: RouterConfig) {
  if (result.classification) {
    const answer = result.classification;

    const lines = [
      "classifier:",
      `  ${config.backend.type} / ${config.backend.model}`,
      `  ✅ passed in ${elapsedMs} ms (${answer.choice}; confidence ${answer.confidence ?? "unavailable"})`,
    ];

    if (
      answer.choice === "uncertain" ||
      answer.confidence === undefined ||
      answer.confidence < config.minConfidence
    )
      lines.push(
        `classifier policy: this answer uses the conservative ${config.uncertainRoute} route; confidence is not generation success probability`,
      );

    return lines;
  }

  const failure = result.failure;
  const reason = failure?.status ? `HTTP ${failure.status}` : (failure?.code ?? result.reason);
  let action: string;

  switch (failure?.code) {
    case "credentials":
      action =
        config.backend.auth.source === "env"
          ? `set ${config.backend.auth.variable} in Pi's launch environment and restart Pi, then run /typesafe-router doctor`
          : `configure credentials for Pi provider ${config.backend.auth.provider}, then run /typesafe-router doctor`;
      break;
    case "http":
      action =
        failure.status === 401 || failure.status === 403
          ? "check the classifier credential's validity and permissions; restart Pi if you changed its environment, then run /typesafe-router doctor"
          : failure.status === 429
            ? "check classifier quota or rate limits and retry /typesafe-router doctor later"
            : "check the selected classifier service's availability and run /typesafe-router doctor again";
      break;
    case "timeout":
      action = `check connectivity or increase timeoutMs (currently ${config.timeoutMs}), then run /typesafe-router doctor`;
      break;
    case "network":
      action =
        "check network access to the configured classifier service, then run /typesafe-router doctor";
      break;
    case "invalid-response":
      action =
        "the response did not match the supported classifier protocol; verify the configured model and backend compatibility";
      break;
    default:
      action =
        "check the configured classifier backend and credentials, then run /typesafe-router doctor";
  }

  return [
    "classifier:",
    `  ${config.backend.type} / ${config.backend.model}`,
    `  ❌ failed in ${elapsedMs} ms (${reason})`,
    `next: ${action}`,
  ];
}
