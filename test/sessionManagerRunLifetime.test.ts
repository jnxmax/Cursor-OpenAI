import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { Agent, CursorAgentPlatform } from "@cursor/sdk";
import type { AgentOptions } from "@cursor/sdk";
import { SessionManager } from "../src/cursor/sessionManager";
import { openSqliteLocalAgentStore } from "../src/cursor/openSqliteLocalAgentStore";
import { makeTestConfig } from "./helpers/testConfig";
import { deferred, offlineCursor, request, sqliteFds, until } from "./helpers/offlineCursor";

const log = pino({ level: "silent" });

for (const ending of ["finished", "error", "cancelled"] as const) {
  void test(`manual eviction retains the ${ending} run after request release, through late writes`, async (t) => {
    const sdk = offlineCursor(t);
    const manager = new SessionManager(makeTestConfig(), log);
    const handle = await manager.resolve(request(ending));
    const run = await handle.agent.send("fixture");
    const control = sdk.controls.at(-1);
    assert.ok(control);
    handle.release();
    manager.evict(handle.key);
    let drained = false;
    const drain = manager.drain().then(() => { drained = true; });
    if (ending === "cancelled") { await run.cancel(); assert.ok(control.aborted); }
    await control.checkpoint();
    assert.equal(drained, false, "cancel acknowledgement is not executor completion");
    assert.deepEqual(sqliteFds(handle.cwd), { index: 5, store: 3 });
    if (ending === "error") control.fail(); else control.finish();
    assert.equal((await run.wait()).status, ending);
    await drain;
    assert.deepEqual(sqliteFds(handle.cwd), { index: 0, store: 0 });
    const store = await openSqliteLocalAgentStore(handle.cwd);
    try {
      assert.equal((await store.runs.get({ agentId: handle.agent.agentId, runId: run.id }))?.status, ending);
    } finally { await store.dispose(); }
    await manager.shutdown();
  });
}

void test("TTL removes cache membership but keeps queued/resolved users and their late run alive", async (t) => {
  const sdk = offlineCursor(t);
  const manager = new SessionManager(makeTestConfig({ sessionTtlMs: 1 }), log);
  const first = await manager.resolve(request("queued"));
  const second = await manager.resolve(request("queued"));
  const unlock = await first.mutex.acquire();
  const queued = second.mutex.acquire();
  await until(() => manager.stats().cachedAgents === 0);
  first.release();
  unlock();
  const releaseQueued = await queued;
  assert.ok(sqliteFds(second.cwd).index > 0);
  const run = await second.agent.send("still owned after TTL");
  const control = sdk.controls.at(-1);
  assert.ok(control);
  releaseQueued();
  second.release();
  await control.checkpoint();
  control.finish();
  await run.wait();
  await manager.drain();
  manager.remember({ ...request("queued"), messages: [], handle: second });
  assert.equal(manager.stats().cachedAgents, 0, "remember must not resurrect an evicted owner");
  assert.deepEqual(sqliteFds(first.cwd), { index: 0, store: 0 });
  await manager.shutdown();
});

void test("cancelled runs keep an in-flight checkpoint owned until its storage write finishes", async (t) => {
  const sdk = offlineCursor(t);
  const manager = new SessionManager(makeTestConfig(), log);
  const handle = await manager.resolve(request("cancel-pending-checkpoint"));
  const run = await handle.agent.send("fixture");
  const control = sdk.controls.at(-1);
  const store = sdk.stores.get(handle.agent.agentId);
  assert.ok(control && store);
  const gate = deferred<void>();
  let writing = false;
  const get = store.checkpoints.get.bind(store.checkpoints);
  t.mock.method(store.checkpoints, "get", async (input: Parameters<typeof get>[0]) => {
    writing = true;
    await gate.promise;
    return get(input);
  });
  const checkpoint = control.checkpoint();
  await until(() => writing);
  await run.cancel();
  control.finish();
  handle.release();
  manager.evict(handle.key);
  let drained = false;
  const drain = manager.drain().then(() => { drained = true; });
  t.after(async () => { gate.resolve(); await checkpoint; await drain; await manager.shutdown(); });
  await run.wait();
  await run.conversation();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false, "checkpoint write is still in flight after SDK cancellation completion");
  gate.resolve();
  await checkpoint;
  await drain;
  assert.deepEqual(sqliteFds(handle.cwd), { index: 0, store: 0 });
});

void test("shutdown rejects admission and awaits the SDK executor release as well as the run", async (t) => {
  const sdk = offlineCursor(t);
  const originalAcquire = CursorAgentPlatform.prototype.acquireLocalExecutor;
  const executorReleased = deferred<void>();
  let releaseStarted = false;
  t.mock.method(CursorAgentPlatform.prototype, "acquireLocalExecutor", async function (this: CursorAgentPlatform, options: Parameters<typeof originalAcquire>[0]) {
    const lease = await originalAcquire.call(this, options);
    return { ...lease, release: async () => { releaseStarted = true; await executorReleased.promise; await lease.release(); } };
  });
  const manager = new SessionManager(makeTestConfig(), log);
  const handle = await manager.resolve(request("drain"));
  const run = await handle.agent.send("fixture");
  const control = sdk.controls.at(-1);
  assert.ok(control);
  handle.release();
  let finished = false;
  const shutdown = manager.shutdown().then(() => { finished = true; });
  await assert.rejects(manager.resolve(request("late")), /shutting down/);
  await control.checkpoint();
  assert.equal(finished, false);
  control.finish();
  await run.wait();
  await until(() => releaseStarted);
  assert.equal(finished, false);
  assert.ok(sqliteFds(handle.cwd).index > 0);
  executorReleased.resolve();
  await shutdown;
  await manager.shutdown();
  assert.deepEqual(sqliteFds(handle.cwd), { index: 0, store: 0 });
});

void test("B2 native resume is single-flight and round-trips the real checkpoint after cold reopen", async (t) => {
  const sdk = offlineCursor(t);
  const config = makeTestConfig();
  const helper = path.join(config.cursorWorkdirRoot, "inert.py");
  fs.writeFileSync(helper, "# never executed\n");
  config.cursorNativeRestartHelper = helper;
  const manager = new SessionManager(config, log);
  const first = await manager.resolve(request("seed"));
  const run = await first.agent.send("seed checkpoint");
  const seed = sdk.controls.at(-1);
  assert.ok(seed);
  seed.finish();
  await run.wait();
  first.release();
  manager.evict(first.key);
  await manager.drain();
  const resume = { ...request("unused"), metadata: { cursor_agent_id: first.agent.agentId } };
  const [a, b] = await Promise.all([manager.resolve(resume), manager.resolve(resume)]);
  assert.ok(a && b);
  assert.equal(a.agent, b.agent);
  assert.equal(a.cwd, first.cwd);
  assert.equal(a.isFirstTurn, false);
  const next = await a.agent.send("resume checkpoint");
  const resumed = sdk.controls.at(-1);
  assert.ok(resumed);
  assert.deepEqual(resumed.bytes, seed.bytes);
  resumed.finish();
  assert.equal((await next.wait()).status, "finished");
  a.release(); b.release();
  await manager.shutdown();
  assert.deepEqual(sqliteFds(first.cwd), { index: 0, store: 0 });
});

void test("B2 failed concurrent creation clears single-flight for retry; other keys/API keys stay isolated", async (t) => {
  offlineCursor(t);
  const create = Agent.create;
  let calls = 0;
  t.mock.method(Agent, "create", async (options?: AgentOptions) => {
    calls += 1;
    if (calls === 1) throw new Error("injected create rejection");
    return create(options ?? {});
  });
  const manager = new SessionManager(makeTestConfig(), log);
  const results = await Promise.allSettled([manager.resolve(request("retry")), manager.resolve(request("retry"))]);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
  assert.equal(calls, 1);
  assert.equal(manager.stats().ownedStores, 0);
  const handles = await Promise.all([manager.resolve(request("retry")), manager.resolve(request("other")), manager.resolve(request("retry", "other-api-key"))]);
  assert.equal(new Set(handles.map((handle) => handle.agent)).size, 3);
  assert.equal(new Set(handles.map((handle) => handle.cwd)).size, 3);
  for (const handle of handles) handle.release();
  await manager.shutdown();
  for (const handle of handles) assert.deepEqual(sqliteFds(handle.cwd), { index: 0, store: 0 });
});

void test("B2 same-key recreation waits for the retired owner instead of overlapping its workspace", async (t) => {
  const sdk = offlineCursor(t);
  const manager = new SessionManager(makeTestConfig(), log);
  const first = await manager.resolve(request("serialized-recreation"));
  const run = await first.agent.send("fixture");
  const control = sdk.controls.at(-1);
  assert.ok(control);
  manager.evict(first.key);
  first.release();
  let admitted = false;
  const second = manager.resolve(request("serialized-recreation")).then((handle) => { admitted = true; return handle; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(admitted, false);
  await control.checkpoint();
  control.finish();
  await run.wait();
  const next = await second;
  assert.equal(next.cwd, first.cwd);
  assert.notEqual(next.agent.agentId, first.agent.agentId);
  next.release();
  await manager.shutdown();
  assert.deepEqual(sqliteFds(first.cwd), { index: 0, store: 0 });
});

void test("B2 rejected concurrent native resumes release their store and permit a subsequent retry", async (t) => {
  offlineCursor(t);
  const config = makeTestConfig();
  config.cursorNativeRestartHelper = path.join(config.cursorWorkdirRoot, "inert.py");
  fs.writeFileSync(config.cursorNativeRestartHelper, "# never executed\n");
  const manager = new SessionManager(config, log);
  const first = await manager.resolve(request("resume-retry-seed"));
  first.release();
  manager.evict(first.key);
  await manager.drain();
  const resume = Agent.resume;
  let calls = 0;
  t.mock.method(Agent, "resume", async (id: string, options?: AgentOptions) => {
    calls += 1;
    if (calls === 1) throw new Error("injected resume rejection");
    return resume(id, options);
  });
  const params = { ...request("unused"), metadata: { cursor_agent_id: first.agent.agentId } };
  const outcomes = await Promise.allSettled([manager.resolve(params), manager.resolve(params)]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["rejected", "rejected"]);
  assert.equal(calls, 1);
  assert.deepEqual(sqliteFds(first.cwd), { index: 0, store: 0 });
  const retry = await manager.resolve(params);
  assert.equal(retry.agent.agentId, first.agent.agentId);
  retry.release();
  await manager.shutdown();
  assert.deepEqual(sqliteFds(first.cwd), { index: 0, store: 0 });
});

void test("shutdown during creation drains the late agent and never admits its handle", async (t) => {
  offlineCursor(t);
  const create = Agent.create;
  const gate = deferred<void>();
  let started = false;
  t.mock.method(Agent, "create", async (options?: AgentOptions) => {
    started = true;
    await gate.promise;
    return create(options ?? {});
  });
  const manager = new SessionManager(makeTestConfig(), log);
  const pending = manager.resolve(request("late-create"));
  const rejected = assert.rejects(pending, /shutting down/);
  await until(() => started);
  const shutdown = manager.shutdown();
  gate.resolve();
  await rejected;
  await shutdown;
  assert.equal(manager.stats().cachedAgents, 0);
  assert.equal(manager.stats().ownedStores, 0);
  assert.equal(manager.stats().retiringAgents, 0);
});
