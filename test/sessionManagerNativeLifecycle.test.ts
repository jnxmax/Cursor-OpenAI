import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { Agent } from "@cursor/sdk";
import type { AgentOptions, SDKAgent } from "@cursor/sdk";
import type { AppConfig } from "../src/config";
import type { ChatCompletionMessage } from "../src/types/openai";
import { SessionManager } from "../src/cursor/sessionManager";
import { makeTestConfig, removeIsolatedCursorProjects, resolveIdleSession } from "./helpers/testConfig";

function fakeAgent(agentId = "native-test-agent"): SDKAgent {
  return {
    agentId, model: undefined,
    send: () => Promise.reject(new Error("No live sends in lifecycle tests")),
    close: () => undefined, reload: () => Promise.resolve(),
    [Symbol.asyncDispose]: () => Promise.resolve(),
    listArtifacts: () => Promise.resolve([]),
    downloadArtifact: () => Promise.resolve(Buffer.alloc(0)),
  };
}

function fixture(t: TestContext, overrides: Partial<AppConfig> = {}) {
  const config = makeTestConfig(overrides);
  const helper = path.join(config.cursorWorkdirRoot, "restart helper.py");
  fs.writeFileSync(helper, "# harmless fixture, never executed\n");
  const log = pino({ level: "silent" });
  return { config, helper, log };
}

function assertInstalled(options: Partial<AgentOptions>) {
  const local = options.local;
  assert.ok(local);
  assert.equal(typeof local.cwd, "string");
  if (typeof local.cwd !== "string") throw new Error("Expected a single controlled cwd");
  assert.deepEqual(local.settingSources, ["project"]);
  assert.equal(local.enableAgentRetries, true);
  assert.equal(local.autoReview, false);
  assert.deepEqual(local.sandboxOptions, { enabled: false });
  const raw = fs.readFileSync(path.join(local.cwd, ".cursor", "hooks.json"), "utf8");
  const hooks: unknown = JSON.parse(raw);
  assert.ok(hooks && typeof hooks === "object");
  assert.match(raw, /cursor-native-lifecycle-router\.py/);
  assert.match(raw, /\/usr\/bin\/python3/);
  assert.match(raw, /"timeout": 3/);
  assert.match(raw, /"failClosed": false/);
  return raw;
}

for (const operation of ["create", "resume"]) {
  void test(`${operation} has project hook and full-bypass options before SDK invocation`, async (t) => {
    const { config, helper, log } = fixture(t);
    const manager = new SessionManager({ ...config, cursorNativeRestartHelper: helper }, log);
    t.after(async () => { await manager.shutdown(); removeIsolatedCursorProjects(config.cursorWorkdirRoot); });
    let calls = 0;
    const check = (options: Partial<AgentOptions> = {}) => {
      calls += 1;
      assert.equal(options.apiKey, "test");
      assert.deepEqual(options.model, { id: "test-model" });
      assert.equal(options.mode, config.cursorAgentMode);
      assert.match(assertInstalled(options), /restart helper\.py/);
      return Promise.resolve(fakeAgent("persisted-agent"));
    };
    t.mock.method(Agent, "create", check);
    t.mock.method(Agent, "resume", (id: string, options?: Partial<AgentOptions>) => {
      assert.equal(id, "persisted-agent");
      return check(options);
    });
    if (operation === "resume") {
      await resolveIdleSession(manager, { apiKey: "test", model: { id: "test-model" }, messages: [], metadata: { session_id: "seed" } });
      calls = 0;
    }
    await resolveIdleSession(manager, { apiKey: "test", model: { id: "test-model" }, messages: [],
      metadata: operation === "resume" ? { cursor_agent_id: "persisted-agent" } : undefined });
    assert.equal(calls, 1);
  });
}

void test("cold lifecycle resume keeps the original SDK workspace", async (t) => {
  const { config, helper, log } = fixture(t);
  const configured = { ...config, cursorNativeRestartHelper: helper };
  const request = { apiKey: "test", model: { id: "test-model" }, messages: [] };
  t.mock.method(Agent, "create", () => Promise.resolve(fakeAgent()));
  const original = new SessionManager(configured, log);
  const created = await resolveIdleSession(original, { ...request, metadata: { session_id: "stable" } });
  await original.shutdown();
  t.mock.method(Agent, "resume", (_id: string, options?: Partial<AgentOptions>) => {
    assert.equal(options?.local?.cwd, created.cwd);
    assertInstalled(options ?? {});
    return Promise.resolve(fakeAgent());
  });
  const cold = new SessionManager(configured, log);
  t.after(async () => { await cold.shutdown(); removeIsolatedCursorProjects(config.cursorWorkdirRoot); });
  const resumed = await resolveIdleSession(cold, { ...request, metadata: { cursor_agent_id: created.agent.agentId } });
  assert.equal(resumed.cwd, created.cwd);
});

void test("unknown or other-key lifecycle resumes preserve SDK defaults", async (t) => {
  const { config, helper, log } = fixture(t);
  const configured = { ...config, cursorNativeRestartHelper: helper };
  const manager = new SessionManager(configured, log);
  t.after(async () => { await manager.shutdown(); removeIsolatedCursorProjects(config.cursorWorkdirRoot); });
  t.mock.method(Agent, "create", () => Promise.resolve(fakeAgent()));
  const request = { apiKey: "test", model: { id: "test-model" }, messages: [] };
  await resolveIdleSession(manager, { ...request, metadata: undefined });
  t.mock.method(Agent, "resume", (_id: string, options?: Partial<AgentOptions>) => {
    assert.deepEqual(options, { apiKey: "other-key" });
    return Promise.resolve(fakeAgent());
  });
  await resolveIdleSession(manager, { ...request, apiKey: "other-key", metadata: { cursor_agent_id: "native-test-agent" } });
});

for (const runtime of ["local", "cloud"] satisfies AppConfig["cursorRuntime"][]) {
  void test(`${runtime} disabled lifecycle preserves existing create and resume options`, async (t) => {
    const { config, helper, log } = fixture(t, { cursorRuntime: runtime });
    const manager = new SessionManager({ ...config, cursorNativeRestartHelper: runtime === "cloud" ? helper : undefined }, log);
    t.after(async () => { await manager.shutdown(); removeIsolatedCursorProjects(config.cursorWorkdirRoot); });
    t.mock.method(Agent, "create", (options: AgentOptions) => {
      if (runtime === "local") {
        assert.deepEqual(options.local?.settingSources, []);
        assert.equal(options.local?.autoReview, undefined);
        assert.equal(options.local?.sandboxOptions, undefined);
      } else {
        assert.equal(options.local, undefined);
        assert.deepEqual(options.cloud, {});
      }
      return Promise.resolve(fakeAgent());
    });
    t.mock.method(Agent, "resume", (_id: string, options?: Partial<AgentOptions>) => {
      assert.deepEqual(options, { apiKey: "test" });
      return Promise.resolve(fakeAgent());
    });
    const request = { apiKey: "test", model: { id: "test-model" }, messages: [] };
    const created = await resolveIdleSession(manager, { ...request, metadata: undefined });
    const resumed = await resolveIdleSession(manager, { ...request, metadata: { cursor_agent_id: "persisted-agent" } });
    for (const handle of [created, resumed]) assert.equal(fs.existsSync(path.join(handle.cwd, ".cursor")), false);
  });
}

void test("auto cache repairs deleted hook in original cwd after key changes without recreating agent", async (t) => {
  const { config, helper, log } = fixture(t);
  const manager = new SessionManager({ ...config, cursorNativeRestartHelper: helper }, log);
  t.after(async () => { await manager.shutdown(); removeIsolatedCursorProjects(config.cursorWorkdirRoot); });
  const create = t.mock.method(Agent, "create", () => Promise.resolve(fakeAgent()));
  const messages: ChatCompletionMessage[] = [{ role: "user", content: "hi" }];
  const request = { apiKey: "test", model: { id: "test-model" }, metadata: undefined };
  const first = await resolveIdleSession(manager, { ...request, messages });
  const hooksPath = path.join(first.cwd, ".cursor", "hooks.json");
  assert.ok(fs.existsSync(hooksPath));
  const original = fs.readFileSync(hooksPath, "utf8");
  fs.unlinkSync(hooksPath);
  const history: ChatCompletionMessage[] = [...messages, { role: "assistant", content: "hello" }];
  manager.remember({ ...request, messages: history, handle: first });
  const cached = await resolveIdleSession(manager, { ...request, messages: [...history, { role: "user", content: "more" }] });
  assert.notEqual(cached.key, first.key);
  assert.equal(cached.cwd, first.cwd);
  assert.equal(cached.agent, first.agent);
  assert.equal(fs.readFileSync(hooksPath, "utf8"), original);
  assert.equal(create.mock.callCount(), 1);
});

void test("foreign hooks survive and project settings stay disabled with warning", async (t) => {
  const { config, helper, log } = fixture(t);
  const request = { apiKey: "test", model: { id: "test-model" }, messages: [], metadata: { session_id: "same" } };
  t.mock.method(Agent, "create", () => Promise.resolve(fakeAgent()));
  const baseline = new SessionManager(config, log);
  const first = await resolveIdleSession(baseline, request);
  await baseline.shutdown();
  const hookDir = path.join(first.cwd, ".cursor");
  fs.mkdirSync(hookDir);
  const foreign = '{"version":1,"hooks":{"preToolUse":[{"command":"foreign"}]}}';
  fs.writeFileSync(path.join(hookDir, "hooks.json"), foreign);
  const warn = t.mock.method(log, "warn", () => undefined);
  t.mock.method(Agent, "create", (options: AgentOptions) => {
    assert.deepEqual(options.local?.settingSources, []);
    return Promise.resolve(fakeAgent());
  });
  const manager = new SessionManager({ ...config, cursorNativeRestartHelper: helper }, log);
  t.after(async () => { await manager.shutdown(); removeIsolatedCursorProjects(config.cursorWorkdirRoot); });
  await resolveIdleSession(manager, request);
  assert.equal(fs.readFileSync(path.join(hookDir, "hooks.json"), "utf8"), foreign);
  assert.equal(warn.mock.callCount(), 1);
});
