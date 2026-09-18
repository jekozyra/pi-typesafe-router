import { estimateTokens, type ContextUsage } from "@earendil-works/pi-coding-agent";
import type { UserMessage } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ClassificationState } from "./types.ts";

const textBlock = z.object({ type: z.literal("text"), text: z.string() });

const conversationalText = z
  .union([
    z.string(),
    z
      .array(textBlock.transform((block) => [block.text]).catch([]))
      .transform((blocks) => blocks.flat().join("\n")),
  ])
  .catch("");

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
    const text = conversationalText.parse(message.content);

    if (!text.trim()) continue;

    // Stop at the first non-fitting text message: don't resurrect older context.
    if (text.length > remaining) break;
    recent.push({ role: message.role, text });
    remaining -= text.length;
  }

  recent.reverse();

  return { current_request: current, recent_conversation: recent };
}

/** Use Pi's reported context count and its own estimator for unsent input. */
export function contextInputTokens(
  usage: ContextUsage | undefined,
  messages: readonly Parameters<typeof estimateTokens>[0][],
  pending?: UserMessage,
): number | null {
  // Pi deliberately marks usage unknown immediately after compaction.
  if (usage?.tokens === null) return null;

  const history =
    usage?.tokens ?? messages.reduce((tokens, message) => tokens + estimateTokens(message), 0);

  return history + (pending ? estimateTokens(pending) : 0);
}
