import assert from "node:assert/strict";
import fs from "node:fs";
import type { TestContext } from "node:test";
import { Agent, CursorAgentPlatform, getDefaultSdkStateRoot } from "@cursor/sdk";
import type { AgentOptions, LocalAgentStore } from "@cursor/sdk";
import type { RunExecutor } from "@cursor/sdk/dist/cjs/executor-types.js";

export function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("uninitialized deferred"); };
  let reject: (error: Error) => void = () => { throw new Error("uninitialized deferred"); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function sqliteFds(cwd: string): { index: number; store: number } {
  const root = `${getDefaultSdkStateRoot(cwd)}/`;
  const counts = { index: 0, store: 0 };
  for (const fd of fs.readdirSync("/proc/self/fd")) {
    let target: string;
    try { target = fs.readlinkSync(`/proc/self/fd/${fd}`); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (!target.startsWith(root)) continue;
    if (/\/index\.db(?:-|$)/.test(target)) counts.index += 1;
    if (/\/store\.db(?:-|$)/.test(target)) counts.store += 1;
  }
  return counts;
}

export async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "condition did not settle within 2s");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

export function request(id: string, apiKey = "offline-fixture") {
  return { apiKey, model: { id: "composer-2.5" }, messages: [{ role: "user" as const, content: "fixture" }], metadata: { session_id: id } };
}

/** Only the executor and model validation are substituted: SDK send, stream, checkpoints and SQLite are real. */
export function offlineCursor(t: TestContext) {
  // SDK resolveLocalModelSelection falls back to process.env.CURSOR_API_KEY when
  // options.apiKey is absent and then calls get_models over the network.
  // Mock validation to identity so tests stay fully offline without rate limits.
  t.mock.method(CursorAgentPlatform.prototype, "resolveLocalModelSelection", async (selection: { id: string }) => selection);
  const stores = new Map<string, LocalAgentStore>();
  const controls: Array<{
    finish: () => void;
    fail: () => void;
    checkpoint: () => Promise<void>;
    bytes: Uint8Array;
    aborted: boolean;
  }> = [];
  const originalCreate = Agent.create;
  const originalResume = Agent.resume;
  function offline(options?: AgentOptions): AgentOptions {
    const copy = { ...options };
    delete copy.apiKey;
    return copy;
  }
  t.mock.method(Agent, "create", async (options?: AgentOptions) => {
    const agent = await originalCreate(offline(options));
    if (options?.local?.store) stores.set(agent.agentId, options.local.store);
    return agent;
  });
  t.mock.method(Agent, "resume", async (id: string, options?: AgentOptions) => {
    const agent = await originalResume(id, offline(options));
    if (options?.local?.store) stores.set(agent.agentId, options.local.store);
    return agent;
  });
  const run: RunExecutor = async (_input, options, sink) => {
    const done = deferred<void>();
    const state = options.initialState;
    const persist = options.onCheckpoint;
    assert.ok(state);
    assert.ok(persist);
    const control = {
      finish: () => done.resolve(),
      fail: () => done.reject(new Error("offline executor failure")),
      checkpoint: async () => { await persist(state); },
      bytes: state.toBinary(),
      aborted: false,
    };
    controls.push(control);
    await control.checkpoint();
    await sink.sendUpdate({ type: "text-delta", text: "offline stream fixture" });
    return { done: done.promise, abort: () => { control.aborted = true; } };
  };
  t.mock.method(CursorAgentPlatform.prototype, "acquireLocalExecutor", async () => ({
    cacheMiss: true,
    release: async () => undefined,
    handle: { run },
  }));
  return { stores, controls };
}
