import { test } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { Agent } from "@cursor/sdk";
import type { AgentOptions, LocalAgentStore } from "@cursor/sdk";

import { SessionManager } from "../src/cursor/sessionManager";
import { drainLocalAgentWrites } from "../src/cursor/drainLocalAgentWrites";
import { makeTestConfig } from "./helpers/testConfig";
import { offlineCursor, request, sqliteFds, until } from "./helpers/offlineCursor";

function disposable(store: LocalAgentStore | undefined): store is LocalAgentStore & { dispose(): Promise<void> } {
  return store !== undefined && "dispose" in store && typeof store.dispose === "function";
}

void test("disposal failure remains owned, is logged at error, and rejects drain without blocking healthy stores", async (t) => {
  const sdk = offlineCursor(t);
  const log = pino({ level: "silent" });
  const errors = t.mock.method(log, "error", () => undefined);
  const manager = new SessionManager(makeTestConfig(), log);
  const broken = await manager.resolve(request("broken-dispose"));
  const healthy = await manager.resolve(request("healthy-dispose"));
  const store = sdk.stores.get(broken.agent.agentId);
  assert.ok(disposable(store));
  const originalDispose = store.dispose.bind(store);
  const disposal = t.mock.method(store, "dispose", async () => { throw new Error("injected SQLite disposal failure"); });
  broken.release();
  healthy.release();
  manager.evictAll();
  const drain = manager.drain();
  // Cleanup only the injected fixture, even on RED. Never retry in production.
  t.after(async () => { disposal.mock.restore(); await originalDispose(); });
  await assert.rejects(drain, /drain failed/);
  assert.ok(errors.mock.callCount() > 0, "disposal failure must not be debug-only");
  assert.deepEqual(sqliteFds(healthy.cwd), { index: 0, store: 0 });
  assert.ok(sqliteFds(broken.cwd).index > 0);
  assert.equal(manager.stats().ownedStores, 1);
  assert.equal(manager.stats().failedStores, 1);
  assert.equal(manager.stats().failedSessions, 1);
  await assert.rejects(manager.resolve(request("broken-dispose")), /cleanup failed|drain failed/);
  assert.equal(disposal.mock.callCount(), 1, "a possibly partially disposed store must not be blindly retried");
  await assert.rejects(manager.shutdown(), /drain failed/);
});


void test("agent async disposal rejection retains ownership instead of closing storage underneath an executor", async (t) => {
  const sdk = offlineCursor(t);
  const create = Agent.create;
  t.mock.method(Agent, "create", async (options?: AgentOptions) => {
    const agent = await create(options ?? {});
    t.mock.method(agent, Symbol.asyncDispose, async () => { throw new Error("injected executor release failure"); });
    return agent;
  });
  const log = pino({ level: "silent" });
  const errors = t.mock.method(log, "error", () => undefined);
  const manager = new SessionManager(makeTestConfig(), log);
  const handle = await manager.resolve(request("executor-failure"));
  const store = sdk.stores.get(handle.agent.agentId);
  assert.ok(disposable(store));
  t.after(() => store.dispose());
  handle.release();
  await assert.rejects(manager.shutdown(), /drain failed/);
  assert.ok(errors.mock.callCount() > 0);
  assert.equal(manager.stats().ownedStores, 1);
  assert.equal(manager.stats().failedSessions, 1);
  assert.ok(sqliteFds(handle.cwd).index > 0);
});

void test("local checkpoint drain refuses an SDK agent without the verified internal contract", async (t) => {
  const sdk = offlineCursor(t);
  const manager = new SessionManager(makeTestConfig(), pino({ level: "silent" }));
  const handle = await manager.resolve(request("unsupported-sdk-contract"));
  // The public facade deliberately has no private SDK fields.
  await assert.rejects(drainLocalAgentWrites(handle.agent), /Unsupported Cursor SDK/);
  assert.equal(sdk.stores.size, 1);
  handle.release();
  await manager.shutdown();
  assert.deepEqual(sqliteFds(handle.cwd), { index: 0, store: 0 });
});


void test("failed run quiescence is visible while cached and refuses new request reservations", async (t) => {
  const sdk = offlineCursor(t);
  const create = Agent.create;
  t.mock.method(Agent, "create", async (options?: AgentOptions) => {
    const agent = await create(options ?? {});
    const send = agent.send.bind(agent);
    t.mock.method(agent, "send", async (...args: Parameters<typeof send>) => {
      const run = await send(...args);
      t.mock.method(run, "conversation", async () => { throw new Error("injected conversation flush failure"); });
      return run;
    });
    return agent;
  });
  const log = pino({ level: "silent" });
  const errors = t.mock.method(log, "error", () => undefined);
  const manager = new SessionManager(makeTestConfig(), log);
  const handle = await manager.resolve(request("failed-quiescence"));
  const run = await handle.agent.send("fixture");
  const control = sdk.controls.at(-1);
  const store = sdk.stores.get(handle.agent.agentId);
  assert.ok(control && disposable(store));
  t.after(async () => { handle.release(); await assert.rejects(manager.shutdown()); await store.dispose(); });
  control.finish();
  await run.wait();
  await until(() => errors.mock.callCount() > 0);
  await assert.rejects(handle.whenIdle(), /quiescence/);
  await assert.rejects(manager.resolve(request("failed-quiescence")), /quiescence/);
  assert.equal(manager.stats().failedSessions, 1);
  assert.equal(manager.stats().ownedStores, 1);
});
