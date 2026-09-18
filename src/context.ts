import type { ClassificationState } from "./types.ts";

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block: unknown) => {
      if (!block || typeof block !== "object") return [];
      const value = block as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n");
}

/** Project only conversational text; never inspect files, tools, or image bytes. */
export function projectState(
  current: string,
  history: readonly { role: string; content: unknown }[],
  maxChars: number,
  historyMessages: number,
): ClassificationState | undefined {
  if (
    !Number.isInteger(maxChars) ||
    maxChars < 1 ||
    !Number.isInteger(historyMessages) ||
    historyMessages < 0 ||
    !current.trim() ||
    current.length > maxChars
  )
    return undefined;
  const recent: ClassificationState["recent_conversation"] = [];
  let remaining = maxChars - current.length;
  for (let i = history.length - 1; i >= 0 && recent.length < historyMessages; i--) {
    const message = history[i]!;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = textContent(message.content);
    if (!text.trim()) continue;
    // Stop at the first non-fitting text message: don't resurrect older context.
    if (text.length > remaining) break;
    recent.push({ role: message.role, text });
    remaining -= text.length;
  }
  recent.reverse();
  return { current_request: current, recent_conversation: recent };
}

/**
 * Deliberately overestimates text with UTF-8 bytes, JSON syntax and framing.
 * Images get a fixed 16k reserve, not a base64-sized estimate. This is a
 * preflight heuristic, not an exact provider tokenizer or image-size guarantee.
 * Cyclic/non-serializable input fails closed rather than underestimating it.
 */
export function estimateInputTokens(
  systemPrompt: string,
  messages: readonly unknown[],
  tools: readonly unknown[],
): number {
  const ancestors = new Set<object>();
  function estimate(value: unknown): number {
    if (value === undefined) return 4;
    if (value === null) return 4;
    if (typeof value === "string") return Buffer.byteLength(JSON.stringify(value), "utf8");
    if (typeof value === "number") return Number.isFinite(value) ? String(value).length : Infinity;
    if (typeof value === "boolean") return value ? 4 : 5;
    if (typeof value !== "object" || ancestors.has(value)) return Infinity;
    ancestors.add(value);
    try {
      if (Array.isArray(value))
        return 2 + value.reduce((sum: number, item: unknown) => sum + estimate(item) + 1, 0);
      const record = value as Record<string, unknown>;
      const image =
        record.type === "image" || record.type === "image_url" || record.type === "input_image";
      let total = image ? 16_384 : 2;
      for (const [key, item] of Object.entries(record)) {
        // Image payloads may be strings or nested URLs/sources; none are expanded.
        if (image && ["data", "source", "url", "image_url", "image"].includes(key)) continue;
        total += estimate(key) + estimate(item) + 2;
      }
      return total;
    } finally {
      ancestors.delete(value);
    }
  }
  return (
    256 +
    estimate(systemPrompt) +
    estimate(messages) +
    estimate(tools) +
    32 * (messages.length + tools.length)
  );
}
