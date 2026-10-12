import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { SessionManager } from "../src/cursor/sessionManager";
import { HeldRunManager } from "../src/cursor/heldRunManager";
import { HeldToolGate } from "../src/cursor/heldToolGate";
import { ModelCatalog } from "../src/cursor/modelCatalog";
import { ResponseStore } from "../src/cursor/responseStore";
import { ActivityLog } from "../src/observability/activityLog";
import { Semaphore } from "../src/utils/concurrency";
import { executeGatewayTurn, prepareGatewayTurn, type GatewayDeps } from "../src/gateway/orchestrator";
import { makeTestConfig } from "./helpers/testConfig";
import { offlineCursor, sqliteFds, until } from "./helpers/offlineCursor";

const log = pino({ level: "silent" });
function setup(t: TestContext) {
  const sdk = offlineCursor(t);
  const config = makeTestConfig({ maxCachedAgents: 1, maxConcurrentRuns: 1, requestTimeoutMs: 10_000 });
  const modelCatalog = new ModelCatalog(log);
  t.mock.method(modelCatalog, "resolveModelSelection", async () => ({ id: "composer-2.5" }));
  const deps: GatewayDeps = {
    config, log, modelCatalog, sessionManager: new SessionManager(config, log), heldRunManager: new HeldRunManager(log),
    semaphore: new Semaphore(1), activityLog: new ActivityLog(), responseStore: new ResponseStore(config),
  };
  return { sdk, deps };
}
const params = {
  apiKey: "offline-fixture", endpoint: "/v1/chat/completions" as const, requestedModelId: "composer-2.5",
  rawMessages: [{ role: "user" as const, content: "fixture" }], metadata: { session_id: "held" }, requestId: "offline-request",
  tools: [{ type: "function" as const, function: { name: "fixture", parameters: {} } }],
};

for (const ending of ["continue", "abandon", "abort", "shutdown"] as const) {
  void test(`held ${ending} retains SQLite across requests and delayed cancellation completion`, async (t) => {
    const { sdk, deps } = setup(t);
    const prepared = await prepareGatewayTurn(deps, params);
    const abort = new AbortController();
    const running = executeGatewayTurn(deps, prepared, { sink: undefined, abortSignal: abort.signal, streaming: false });
    await until(() => sdk.controls.length === 1);
    const control = sdk.controls[0];
    const tool = prepared.customTools?.["fixture"];
    assert.ok(control && tool);
    const result = tool.execute({}, { toolCallId: "call-fixture" });
    const parked = await running;
    assert.equal(parked.finishReason, "tool_calls");
    assert.equal(deps.semaphore.inUse, 1);
    deps.sessionManager.evict(prepared.handle.key);
    await control.checkpoint();
    assert.deepEqual(sqliteFds(prepared.handle.cwd), { index: 5, store: 3 });
    if (ending === "continue") {
      const continuation = await prepareGatewayTurn(deps, { ...params, rawMessages: [{ role: "tool", tool_call_id: "call-fixture", content: "done" }] });
      const resumed = executeGatewayTurn(deps, continuation, { sink: undefined, abortSignal: undefined, streaming: false });
      await result;
      control.finish();
      assert.equal((await resumed).finishReason, "stop");
      continuation.releaseSemaphore();
    } else {
      if (ending === "abandon") deps.heldRunManager.abandon(parked.agentId, "fixture");
      if (ending === "abort") abort.abort();
      if (ending === "shutdown") deps.heldRunManager.shutdown();
      await result;
      await until(() => control.aborted);
      assert.equal(deps.semaphore.inUse, 1, "SDK work still running must retain its admission slot");
      await control.checkpoint();
      assert.deepEqual(sqliteFds(prepared.handle.cwd), { index: 5, store: 3 }, "early held release must not close the active SDK run");
      control.finish();
    }
    prepared.releaseSemaphore();
    await deps.sessionManager.shutdown();
    assert.equal(deps.semaphore.inUse, 0);
    assert.equal(deps.heldRunManager.heldCount, 0);
    assert.deepEqual(sqliteFds(prepared.handle.cwd), { index: 0, store: 0 });
  });
}

void test("held shutdown also cancels a pumping run that has not parked yet", async (t) => {
  const { sdk, deps } = setup(t);
  let started = false;
  const prepared = await prepareGatewayTurn(deps, params);
  t.mock.method(prepared.log, "info", (_context: unknown, message: string) => { if (message === "cursor run started (hold mode)") started = true; });
  const abort = new AbortController();
  const running = executeGatewayTurn(deps, prepared, { sink: undefined, abortSignal: abort.signal, streaming: false });
  await until(() => sdk.controls.length === 1);
  const control = sdk.controls[0];
  assert.ok(control);
  t.after(async () => {
    abort.abort(); control.finish();
    await running;
    prepared.releaseSemaphore();
    await deps.sessionManager.shutdown();
  });
  await until(() => started);
  deps.heldRunManager.shutdown();
  await until(() => control.aborted);
  assert.equal(deps.semaphore.inUse, 1, "SDK cancellation has not completed yet");
});

void test("preparation rejection after resolve releases both the session reservation and semaphore", async (t) => {
  const { deps } = setup(t);
  t.mock.method(HeldToolGate.prototype, "buildCustomTools", () => { throw new Error("injected preparation failure"); });
  await assert.rejects(prepareGatewayTurn(deps, params), /preparation failure/);
  assert.equal(deps.semaphore.inUse, 0);
  await deps.sessionManager.shutdown();
  assert.equal(deps.sessionManager.stats().ownedStores, 0);
});
