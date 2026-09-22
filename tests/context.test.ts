/**
 * Bounded-projection tests for `src/context.ts`.
 *
 * `projectState` is the disclosure boundary: whatever it returns is what leaves the machine
 * for the classifier. The rules worth pinning are the ones that fail quietly — which roles
 * are dropped, what happens when the newest message does not fit, and whether an unknown
 * context size defers to Pi instead of guessing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { installPiStubs } from "./harness.ts";

installPiStubs();

const { contextInputTokens, projectState } = await import("../src/context.ts");

const { estimateTokens } = await import("@earendil-works/pi-coding-agent");

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 });

/** Pi's usage record: tokens and percent are null after compaction, and both bounds are stated. */
const usage = (tokens: number | null) => ({
  tokens,
  contextWindow: 200_000,
  percent: tokens === null ? null : tokens / 200_000,
});

const assistant = (text: string) => ({ role: "assistant" as const, content: text, timestamp: 0 });

/** Version 1's historical projection, spelled out at each call site. */
const BOTH = ["user", "assistant"] as const;

/** Version 2's generated policy. */
const USER_ONLY = ["user"] as const;

/** `projectState` with the pre-v2 projection, so the older assertions stay about bounds. */
function project(
  current: string,
  history: readonly { role: string; content: unknown }[],
  maxChars: number,
  historyMessages: number,
  roles: readonly ("user" | "assistant")[] = BOTH,
) {
  return projectState(current, history, maxChars, historyMessages, roles);
}

test("rejects an empty or oversized current request", () => {
  assert.equal(project("", [], 100, 4), undefined);
  assert.equal(project("   \n\t ", [], 100, 4), undefined);
  assert.equal(project("x".repeat(101), [], 100, 4), undefined);
});

test("accepts a current request exactly at the bound", () => {
  const state = project("x".repeat(100), [], 100, 4);

  assert.equal(state?.current_request.length, 100);
  assert.deepEqual(state?.recent_conversation, []);
});

test("rejects an unusable bound instead of guessing one", () => {
  assert.equal(project("hello", [], 0, 4), undefined);
  assert.equal(project("hello", [], -1, 4), undefined);
  assert.equal(project("hello", [], 1.5, 4), undefined);
  assert.equal(project("hello", [], 100, -1), undefined);
  assert.equal(project("hello", [], 100, 1.5), undefined);
});

test("historyMessages zero sends the request alone", () => {
  const state = project("hello", [user("earlier")], 100, 0);

  assert.deepEqual(state?.recent_conversation, []);
});

test("keeps the newest messages in chronological order", () => {
  const history = [user("one"), user("two"), user("three"), user("four"), user("five")];
  const state = project("now", history, 1000, 2);

  assert.deepEqual(state?.recent_conversation, [
    { role: "user", text: "four" },
    { role: "user", text: "five" },
  ]);
});

test("a user-only projection drops assistant text even when it would fit", () => {
  const state = project(
    "now",
    [user("kept"), assistant("quoted file contents"), user("also kept")],
    1000,
    8,
    USER_ONLY,
  );

  assert.deepEqual(state?.recent_conversation, [
    { role: "user", text: "kept" },
    { role: "user", text: "also kept" },
  ]);
});

test("a user-only projection never reaches a tool result or an image", () => {
  const state = project(
    "now",
    [
      { role: "toolResult", content: "tool output" },
      {
        role: "user",
        content: [
          { type: "text", text: "kept" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      },
      assistant("assistant text"),
    ],
    1000,
    4,
    USER_ONLY,
  );

  assert.deepEqual(state?.recent_conversation, [{ role: "user", text: "kept" }]);
});

test("drops non-conversational roles and empty text", () => {
  const state = project(
    "now",
    [
      user("kept"),
      { role: "toolResult", content: "tool output" },
      { role: "system", content: "system prompt" },
      user("   "),
      { role: "bashExecution", content: "ls -la" },
      assistant("assistant text"),
    ],
    1000,
    8,
  );

  assert.deepEqual(state?.recent_conversation, [
    { role: "user", text: "kept" },
    { role: "assistant", text: "assistant text" },
  ]);
});

test("a malformed content shape is skipped rather than thrown", () => {
  const state = project(
    "now",
    [user("kept"), { role: "user", content: { text: "object" } }],
    1000,
    8,
  );

  assert.deepEqual(state?.recent_conversation, [{ role: "user", text: "kept" }]);
});

test("text blocks are joined in order; non-text blocks are dropped", () => {
  const state = project(
    "now",
    [
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "text", text: "second" },
        ],
      },
    ],
    1000,
    4,
  );

  assert.deepEqual(state?.recent_conversation, [{ role: "user", text: "first\nsecond" }]);
});

test("stops at the newest message that does not fit", () => {
  // "older" fits the character bound but is older than "too-big", so it must not appear.
  const state = project("now", [user("older"), user("x".repeat(50))], 20, 4);

  assert.deepEqual(state?.recent_conversation, []);
  assert.equal(state?.current_request, "now");
});

test("the whole projection stays inside maxChars", () => {
  const history = [user("a".repeat(40)), user("b".repeat(40)), user("c".repeat(40))];
  const state = project("current", history, 100, 4);

  const characters =
    (state?.current_request.length ?? 0) +
    (state?.recent_conversation.reduce((total, message) => total + message.text.length, 0) ?? 0);

  assert.ok(characters <= 100, `projection used ${characters} characters`);
});

test("an unknown context size defers to Pi", () => {
  assert.equal(contextInputTokens(usage(null), [], undefined), null);
  assert.equal(contextInputTokens(usage(null), [user("hello")], user("hello")), null);
});

test("a reported context size is used as the history total", () => {
  assert.equal(contextInputTokens(usage(500), [], undefined), 500);

  const pending = { role: "user" as const, content: "hello", timestamp: 0 };
  assert.equal(contextInputTokens(usage(500), [], pending), 500 + estimateTokens(pending));
});

test("without a reported size the messages are estimated", () => {
  const first = user("first");
  const second = user("second");
  const pending = user("third");
  const expected = estimateTokens(first) + estimateTokens(second);

  assert.equal(contextInputTokens(undefined, [first, second], undefined), expected);
  assert.equal(
    contextInputTokens(undefined, [first, second], pending),
    expected + estimateTokens(pending),
  );
});
