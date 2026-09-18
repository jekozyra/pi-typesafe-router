import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  InputEventResult,
  MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export type RouterContext = Pick<
  ExtensionContext,
  "mode" | "hasUI" | "scopedModels" | "model" | "isIdle" | "getSystemPrompt" | "getContextUsage"
> & {
  sessionManager: Pick<
    ExtensionContext["sessionManager"],
    "getEntries" | "getLeafId" | "buildContextEntries" | "getBranch"
  >;
  modelRegistry: Pick<
    ExtensionContext["modelRegistry"],
    | "getAll"
    | "getAvailable"
    | "find"
    | "getProviderAuth"
    | "complete"
    | "getProviderAuthStatus"
    | "getRegisteredProviderConfig"
    | "getProvider"
  >;
  ui: Pick<
    ExtensionContext["ui"],
    "notify" | "setStatus" | "setWidget" | "confirm" | "onTerminalInput" | "select" | "input"
  >;
};

type RouterHookName =
  | "session_start"
  | "session_shutdown"
  | "session_before_switch"
  | "session_before_fork"
  | "session_before_tree"
  | "session_tree"
  | "input"
  | "model_select"
  | "message_end"
  | "agent_settled";

export type RouterEvents = {
  [K in RouterHookName]: K extends "message_end"
    ? {
        type: K;
        message: Pick<MessageEndEvent["message"], "role"> &
          Partial<Pick<AssistantMessage, "provider" | "model" | "stopReason">>;
      }
    : Extract<ExtensionEvent, { type: K }>;
};

type RouterResults = {
  [K in RouterHookName]: K extends "input"
    ? InputEventResult
    : K extends "session_before_switch" | "session_before_fork" | "session_before_tree"
      ? { cancel?: boolean }
      : never;
};

type RouterHook<K extends RouterHookName> = (
  event: RouterEvents[K],
  ctx: RouterContext,
) => RouterResults[K] | void | Promise<RouterResults[K] | void>;

export type RouterAPI = Pick<
  ExtensionAPI,
  "appendEntry" | "getAllTools" | "getActiveTools" | "sendUserMessage" | "setModel"
> & {
  on<K extends RouterHookName>(name: K, hook: RouterHook<K>): void;
  registerCommand(
    name: string,
    command: Omit<Parameters<ExtensionAPI["registerCommand"]>[1], "handler"> & {
      handler: (args: string, ctx: RouterContext) => Promise<void>;
    },
  ): void;
};
