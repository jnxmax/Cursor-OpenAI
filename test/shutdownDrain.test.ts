import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import pino from "pino";
import { deferred, until } from "./helpers/offlineCursor";
import { makeTestConfig } from "./helpers/testConfig";

// Execute the real entrypoint in memory. No config/.env is loaded, no listener,
// process exit, or child process is real; only the shutdown dependency is delayed.
for (const mode of ["SIGTERM", "restart", "failure", "timeout"] as const) {
  void test(`entrypoint ${mode} waits for session drain before exit/respawn`, async () => {
    const drain = deferred<void>();
    const exits: number[] = [];
    let spawned = 0;
    let stopped = false;
    let sessionShutdowns = 0;
    let restart: (() => void) | undefined;
    let deadline: (() => void) | undefined;
    const handlers = new Map<string, () => void>();
    const config = makeTestConfig({ cursorApiKey: undefined, autoOpenBrowser: false });
    const log = pino({ level: "silent" });
    const server = { close: (callback?: () => void) => { stopped = true; callback?.(); } };
    class ConfigStore {
      config = config;
      setupComplete = false;
      onServerRebindNeeded() { /* no rebind in this contract test */ }
      onRestartRequested(callback: () => void) { restart = callback; }
    }
    const modules: Record<string, unknown> = {
      "node:child_process": { spawn: () => { spawned += 1; return { unref: () => undefined }; } },
      "@cursor/sdk": {},
      "./config": { loadConfig: () => config },
      "./configStore": { ConfigStore },
      "./logger": { createLogger: () => log },
      "./server": { buildApp: () => ({
        app: {},
        sessionManager: { shutdown: () => { sessionShutdowns += 1; return drain.promise; }, stats: () => ({ ownedStores: 1 }) },
        heldRunManager: { shutdown: () => undefined },
        responseStore: { shutdown: () => undefined },
      }) },
      "./utils/openBrowser": {},
      "./utils/findAvailablePort": { listenWithPortFallback: async () => ({ server, port: 1 }) },
      "./utils/networkAddresses": { isAllInterfacesHost: () => false },
    };
    const source = fs.readFileSync(path.join(__dirname, "../src/index.ts"), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    vm.runInNewContext(compiled.outputText, {
      exports: {}, console,
      require: (id: string) => { assert.ok(id in modules, `unexpected entrypoint dependency ${id}`); return modules[id]; },
      process: {
        on: (event: string, listener: () => void) => handlers.set(event, listener),
        exit: (code: number) => exits.push(code), stdout: { isTTY: false },
        execPath: "fixture-node", argv: ["fixture-node", "fixture-entrypoint"], env: {}, cwd: () => "/tmp",
      },
      setTimeout: (callback: () => void, ms: number) => {
        if (ms === 300) queueMicrotask(callback);
        else { assert.equal(ms, 10_000); deadline = callback; }
        return { unref: () => undefined };
      },
      clearTimeout: () => undefined,
    });
    await until(() => handlers.has("SIGTERM"));
    if (mode === "restart") { assert.ok(restart); restart(); }
    else { const terminate = handlers.get("SIGTERM"); assert.ok(terminate); terminate(); }
    await until(() => sessionShutdowns > 0);
    assert.ok(stopped);
    assert.deepEqual(exits, [], "must not exit before disposal completes");
    assert.equal(spawned, 0, "must not respawn before the old owner is drained");
    if (mode === "timeout") {
      assert.ok(deadline);
      deadline();
      assert.deepEqual(exits, [1], "a timed-out drain is not a clean shutdown");
      drain.resolve();
    } else if (mode === "failure") {
      drain.reject(new Error("injected drain failure"));
      await until(() => exits.length > 0);
      assert.deepEqual(exits, [1]);
    } else {
      drain.resolve();
      await until(() => exits.length > 0);
      assert.deepEqual(exits, [0]);
      assert.equal(spawned, mode === "restart" ? 1 : 0);
    }
  });
}
