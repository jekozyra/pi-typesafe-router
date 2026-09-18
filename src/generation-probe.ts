import type { RouterContext } from "./host.ts";
import { abortable } from "./settings.ts";
import type { Target } from "./types.ts";

export interface GenerationProbeResult {
  target: Target;
  passed: boolean;
  reason: string;
  milliseconds: number;
}

/** Isolated connectivity request. Native providers may ignore maxTokens: not an absolute cost cap. */
export async function probeGeneration(
  registry: Pick<RouterContext["modelRegistry"], "find" | "complete">,
  target: Target,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<GenerationProbeResult> {
  const started = performance.now();
  const deadline = new AbortController();
  const combined = AbortSignal.any([signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  let responseStatus: number | undefined;

  const result = (reason: string): GenerationProbeResult => ({
    target,
    passed: reason === "ok",
    reason,
    milliseconds: Math.max(0, Math.round(performance.now() - started)),
  });

  try {
    combined.throwIfAborted();
    const model = registry.find(target.provider, target.model);

    if (!model || model.provider !== target.provider || model.id !== target.model) {
      return result("unknown-model");
    }

    // The race includes host authentication resolution, even if it ignores abort.
    const response = await abortable(
      () =>
        registry.complete(
          model,
          {
            systemPrompt: "This is a synthetic connectivity probe. Reply briefly with OK.",
            messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }],
            tools: [],
          },
          {
            signal: combined,
            maxTokens: 128,
            maxRetries: 0,
            transport: "sse",
            // Pi calls this after resolving auth and before invoking provider transport.
            transformHeaders: (headers) => {
              combined.throwIfAborted();

              return headers;
            },
            onResponse: (response) => {
              responseStatus = response.status;
            },
          },
        ),
      combined,
    );

    combined.throwIfAborted();

    if (responseStatus !== undefined && responseStatus >= 400)
      return result(`http-${responseStatus}`);

    if (response.role !== "assistant") return result("invalid-role");

    if (response.provider !== target.provider || response.model !== target.model) {
      return result("identity-mismatch");
    }

    if (response.content.some((part) => part.type === "toolCall")) return result("tool-call");

    if (response.stopReason !== "stop" && response.stopReason !== "length") {
      return result("invalid-stop-reason");
    }

    // Text is evidence of API access, not an instruction or authoritative probe verdict.
    if (!response.content.some((part) => part.type === "text" && part.text.trim().length > 0)) {
      return result("empty-text");
    }

    return result("ok");
  } catch {
    if (signal.aborted) throw new DOMException("Generation probe cancelled", "AbortError");

    return result(
      deadline.signal.aborted
        ? "timeout"
        : responseStatus !== undefined && responseStatus >= 400
          ? `http-${responseStatus}`
          : "request-failed",
    );
  } finally {
    clearTimeout(timer);
  }
}
