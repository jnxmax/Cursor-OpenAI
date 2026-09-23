import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fallbackChainFor, markExhausted, markRecovered } from "../src/cursor/quotaState";

test("Cursor fallback replaces Opus 5 with 5.5 and skips it while exhausted", () => {
  const directory = mkdtempSync(join(tmpdir(), "cursor-opus-quota-"));
  const previous = process.env.QUOTA_STATE_PATH;
  process.env.QUOTA_STATE_PATH = join(directory, "quota.json");
  try {
    assert.deepEqual(fallbackChainFor("grok-4.7"), ["gemini-3.8-flash", "claude-opus-5-5"]);
    assert.deepEqual(fallbackChainFor("gemini-3.8-flash"), ["claude-opus-5-5"]);
    assert.deepEqual(fallbackChainFor("claude-opus-5-5"), []);
    assert.deepEqual(fallbackChainFor("claude-opus-5"), []);
    markExhausted("claude-opus-5-5", "quota exceeded");
    assert.deepEqual(fallbackChainFor("gemini-3.8-flash"), []);
    markRecovered("claude-opus-5-5");
    assert.deepEqual(fallbackChainFor("gemini-3.8-flash"), ["claude-opus-5-5"]);
  } finally {
    if (previous === undefined) delete process.env.QUOTA_STATE_PATH;
    else process.env.QUOTA_STATE_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
