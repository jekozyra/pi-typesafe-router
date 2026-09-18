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

const shallowArray = z.array(z.unknown());

const shallowRecord = z.record(z.string(), z.unknown());

const recordEntries = z.array(z.tuple([z.string(), z.unknown()]));

const estimateNode = z
  .union([
    z.undefined().transform(() => ({ kind: "scalar" as const, bytes: 4 })),
    z.null().transform(() => ({ kind: "scalar" as const, bytes: 4 })),
    z.string().transform((text) => ({
      kind: "scalar" as const,
      bytes: Buffer.byteLength(JSON.stringify(text), "utf8"),
    })),
    z.number().transform((number) => ({ kind: "scalar" as const, bytes: String(number).length })),
    z.boolean().transform((boolean) => ({ kind: "scalar" as const, bytes: boolean ? 4 : 5 })),
    z.instanceof(Object).transform((identity) => {
      // Validate one level only; keep the original identity for ancestor detection.
      const array = shallowArray.safeParse(identity);

      if (array.success) return { kind: "array" as const, identity, items: array.data };
      const record = shallowRecord.safeParse(identity);

      if (record.success)
        return {
          kind: "record" as const,
          identity,
          // Zod's object output strips __proto__; tuples preserve every serialized key.
          entries: recordEntries.parse(Object.entries(identity)),
        };

      return { kind: "invalid" as const };
    }),
  ])
  .catch({ kind: "invalid" });

type EstimateNode = z.infer<typeof estimateNode>;

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
  const ancestors = new Set<Extract<EstimateNode, { kind: "array" | "record" }>["identity"]>();

  function estimate(node: EstimateNode): number {
    switch (node.kind) {
      case "invalid":
        return Infinity;
      case "scalar":
        return node.bytes;
      case "array":
      case "record": {
        if (ancestors.has(node.identity)) return Infinity;
        ancestors.add(node.identity);

        try {
          if (node.kind === "array")
            return (
              2 +
              node.items.reduce<number>(
                (sum, item) => sum + estimate(estimateNode.parse(item)) + 1,
                0,
              )
            );

          const image = ["image", "image_url", "input_image"].includes(
            z
              .string()
              .catch("")
              .parse(node.entries.find(([key]) => key === "type")?.[1]),
          );

          let total = image ? 16_384 : 2;

          for (const [key, item] of node.entries) {
            if (image && ["data", "source", "url", "image_url", "image"].includes(key)) continue;
            total +=
              Buffer.byteLength(JSON.stringify(key), "utf8") +
              estimate(estimateNode.parse(item)) +
              2;
          }

          return total;
        } finally {
          ancestors.delete(node.identity);
        }
      }
    }
  }

  try {
    return (
      256 +
      estimate(estimateNode.parse(systemPrompt)) +
      estimate(estimateNode.parse(messages)) +
      estimate(estimateNode.parse(tools)) +
      32 * (messages.length + tools.length)
    );
  } catch {
    // Throwing getters, proxies and excessive nesting cannot yield a safe estimate.
    return Infinity;
  }
}
