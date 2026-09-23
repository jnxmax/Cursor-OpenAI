import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import pino from "pino";
import { findNativeWorkspace, installNativeLifecycleHook, rememberNativeWorkspace } from "../src/cursor/nativeLifecycle";

for (const helper of [undefined, "relative.py", "/nonexistent-native-helper-test.py"]) {
  test(`unconfigured or invalid helper does not install hooks: ${helper}`, (t) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-native-"));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    assert.equal(installNativeLifecycleHook({ cwd, helper, log: pino({ level: "silent" }) }), false);
    assert.equal(fs.existsSync(path.join(cwd, ".cursor")), false);
  });
}

test("hook publication is idempotent and shell-quotes paths without executing them", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-native-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const helper = path.join(cwd, "helper ' $(false).py");
  fs.writeFileSync(helper, "# never executed\n");
  const params = { cwd, helper, log: pino({ level: "silent" }) };
  assert.equal(installNativeLifecycleHook(params), true);
  const target = path.join(cwd, ".cursor", "hooks.json");
  const original = fs.readFileSync(target, "utf8");
  assert.equal(installNativeLifecycleHook(params), true);
  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["hooks.json"]);
  // shlex only parses the serialized command; it does not run the hook/helper.
  const parsed: unknown = JSON.parse(execFileSync("/usr/bin/python3", ["-c",
    "import json,shlex,sys; print(json.dumps(shlex.split(json.load(sys.stdin)['hooks']['preToolUse'][0]['command'])))"],
  { input: original, encoding: "utf8", timeout: 3000 }));
  assert.deepEqual(parsed, ["/usr/bin/python3", path.resolve(__dirname, "../scripts/cursor-native-lifecycle-router.py"), "--helper", helper]);
});

test("workspace aliases are idempotent and never overwrite another target", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-native-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "original");
  const other = path.join(root, "other");
  fs.mkdirSync(cwd);
  fs.mkdirSync(other);
  const alias = path.join(root, ".native-resume-test");
  const log = pino({ level: "silent" });
  rememberNativeWorkspace({ cwd, alias, log });
  rememberNativeWorkspace({ cwd, alias, log });
  assert.equal(findNativeWorkspace(alias, log), cwd);
  rememberNativeWorkspace({ cwd: other, alias, log });
  assert.equal(findNativeWorkspace(alias, log), cwd);
});

test("missing, foreign, broken and escaping workspace aliases are not used", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-native-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = pino({ level: "silent" });
  const alias = path.join(root, ".native-resume-test");
  assert.equal(findNativeWorkspace(alias, log), undefined);
  fs.writeFileSync(alias, "foreign");
  assert.equal(findNativeWorkspace(alias, log), undefined);
  fs.unlinkSync(alias);
  fs.symlinkSync("missing", alias, "dir");
  assert.equal(findNativeWorkspace(alias, log), undefined);
  fs.unlinkSync(alias);
  fs.symlinkSync("..", alias, "dir");
  assert.equal(findNativeWorkspace(alias, log), undefined);
});

test("linked foreign hooks and settings directories are preserved", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-native-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const helper = path.join(cwd, "helper.py");
  fs.writeFileSync(helper, "# never executed\n");
  const foreign = path.join(cwd, "foreign");
  fs.mkdirSync(foreign);
  fs.symlinkSync(foreign, path.join(cwd, ".cursor"));
  const log = pino({ level: "silent" });
  const warn = t.mock.method(log, "warn", () => undefined);
  assert.equal(installNativeLifecycleHook({ cwd, helper, log }), false);
  assert.deepEqual(fs.readdirSync(foreign), []);
  assert.equal(warn.mock.callCount(), 1);
});
