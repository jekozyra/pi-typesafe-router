import assert from "node:assert/strict";
import test from "node:test";
import { GitHubPort } from "../scripts/release/pr.js";

const port = new GitHubPort("token", "owner", "repo", 13, "changeset-release/main");

for (const declared of [true, false]) {
  for (const path of ["package.json", "package-lock.json", "CHANGELOG.md"]) {
    test(`reads release metadata above 8 KiB: ${path}, declared=${declared}`, async (t) => {
      const content = "x".repeat(140_000);
      t.mock.method(
        globalThis,
        "fetch",
        async () =>
          new Response(content, {
            headers: declared ? { "content-length": String(content.length) } : {},
          }),
      );
      assert.equal(await port.readFile(path, "sha"), content);
    });
  }

  for (const { path, limit, error } of [
    { path: ".changeset/pr-13.md", limit: 8 * 1024, error: "generated-changeset-too-large" },
    { path: "package-lock.json", limit: 1024 * 1024, error: "release-candidate-file-too-large" },
  ]) {
    test(`rejects oversized ${path}, declared=${declared}`, async (t) => {
      let cancelled = false;
      t.mock.method(
        globalThis,
        "fetch",
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(limit));
                controller.enqueue(new Uint8Array(1));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: declared ? { "content-length": String(limit + 1) } : {} },
          ),
      );
      await assert.rejects(port.readFile(path, "sha"), { message: error });
      assert.equal(cancelled, true);
    });
  }
}
