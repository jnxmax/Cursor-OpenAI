import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

// The opt-in Hermes watchdog integration targets Linux, not Windows hosts.
test("native restart routing preserves tools and never forces a restart", { skip: process.platform !== "linux" }, () => {
  const result = spawnSync("/usr/bin/python3", ["-B", path.join(__dirname, "native_lifecycle_router_test.py")], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\bOK\s*$/u);
});
