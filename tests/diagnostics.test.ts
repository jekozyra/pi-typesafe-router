import assert from "node:assert/strict";
import { it } from "node:test";
import { routeLines } from "../src/diagnostics.ts";

const target = { provider: "fixture", model: "quick" };

it("renders shared generation results beside each mapped model", () => {
  const candidates = [{ target, eligible: true }];

  const lines = routeLines({ quick: candidates, standard: candidates }, [
    { target, passed: true, reason: "ok", milliseconds: 158 },
  ]);

  assert.deepEqual(lines, [
    "routes:",
    "  quick:",
    "    fixture/quick\n    ✅ passed in 158 ms",
    "  standard:",
    "    fixture/quick\n    ✅ passed in 158 ms",
  ]);
});

it("renders failed probes with their duration and safe reason", () => {
  const lines = routeLines({ quick: [{ target, eligible: true }] }, [
    { target, passed: false, reason: "timeout", milliseconds: 15000 },
  ]);

  assert.equal(lines.at(-1), "    fixture/quick\n    ❌ failed in 15000 ms (timeout)");
});

it("keeps local restrictions distinct from successful generation checks", () => {
  const lines = routeLines({ quick: [{ target, eligible: false, reason: "out-of-scope" }] }, [
    { target, passed: true, reason: "ok", milliseconds: 12 },
  ]);

  assert.equal(
    lines.at(-1),
    "    fixture/quick\n    ✅ passed in 12 ms; not routable: excluded by Pi's current model scope",
  );
});

it("never invents a duration or outcome for a missing generation result", () => {
  const lines = routeLines({ quick: [{ target, eligible: true }] }, []);
  assert.equal(lines.at(-1), "    fixture/quick\n    not checked");
});
