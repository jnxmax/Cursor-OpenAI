import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { Agent } from "@cursor/sdk";
import type { AgentOptions } from "@cursor/sdk";
import { SessionManager } from "../src/cursor/sessionManager";
import { makeTestConfig, removeIsolatedCursorProjects, resolveIdleSession } from "./helpers/testConfig";

const silentLog = pino({ level: "silent" });

/**
 * SDK 1.0.22 keeps a process-wide SQLite store per workspace. `agent.close()`
 * releases the executor only. Stripping the model keeps this test offline while
 * still opening that real store.
 */
function withoutModelLookup(options: AgentOptions | undefined): AgentOptions {
  const next: AgentOptions = { ...options };
  delete next.apiKey;
  delete next.model;
  return next;
}

function projectDir(workspaceRef: string): string {
  const slug = workspaceRef.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return path.join(os.homedir(), ".cursor", "projects", slug);
}

function sqliteFdCount(workspaceRef: string): number {
  const root = projectDir(workspaceRef);
  const fdDir = `/proc/${process.pid}/fd`;
  let count = 0;
  for (const name of fs.readdirSync(fdDir)) {
    try {
      const target = fs.readlinkSync(path.join(fdDir, name));
      if (target.startsWith(`${root}/`) && target.includes(".db")) count += 1;
    } catch (error) {
      // Only a descriptor disappearing between readdir and readlink is expected.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return count;
}

function workspaceDirs(root: string): string[] {
  return fs.readdirSync(root).map((name) => path.join(root, name));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

void describe("local workspace SQLite retention", { concurrency: 1 }, () => {
  void test("a failed local create does not leave the workspace SQLite descriptors open", async (t) => {
    const originalCreate = Agent.create;
    Agent.create = (async (options?: AgentOptions) => {
      const agent = await originalCreate(withoutModelLookup(options));
      agent.close();
      throw new Error("opened real store then failed");
    }) as typeof Agent.create;
    t.after(() => {
      Agent.create = originalCreate;
    });

    const config = makeTestConfig();
    const manager = new SessionManager(config, silentLog);
    t.after(async () => {
      await manager.shutdown();
      removeIsolatedCursorProjects(config.cursorWorkdirRoot);
    });

    await assert.rejects(
      () => manager.resolve({
        apiKey: "k",
        model: { id: "composer-2.5" },
        messages: [{ role: "user", content: "hi" }],
        metadata: { session_id: "sqlite-fail" },
      }),
      /opened real store then failed/,
    );

    const [cwd] = workspaceDirs(config.cursorWorkdirRoot);
    assert.ok(cwd, "the session workspace should exist before Agent.create returns");
    await waitUntil(() => sqliteFdCount(cwd) === 0);
    assert.equal(sqliteFdCount(cwd), 0, "a failed create must close the workspace SQLite descriptors");
  });

  void test("evicting one local session closes only that workspace's SQLite descriptors", async (t) => {
    const originalCreate = Agent.create;
    Agent.create = (async (options?: AgentOptions) => originalCreate(withoutModelLookup(options))) as typeof Agent.create;
    t.after(() => {
      Agent.create = originalCreate;
    });

    const config = makeTestConfig();
    const manager = new SessionManager(config, silentLog);
    t.after(async () => {
      await manager.shutdown();
      removeIsolatedCursorProjects(config.cursorWorkdirRoot);
    });

    const model = { id: "composer-2.5" };
    const first = await resolveIdleSession(manager, {
      apiKey: "k",
      model,
      messages: [{ role: "user", content: "one" }],
      metadata: { session_id: "sqlite-one" },
    });
    const second = await resolveIdleSession(manager, {
      apiKey: "k",
      model,
      messages: [{ role: "user", content: "two" }],
      metadata: { session_id: "sqlite-two" },
    });
    assert.ok(sqliteFdCount(first.cwd) >= 5);
    assert.ok(sqliteFdCount(second.cwd) >= 5);

    const firstSession = manager.listSessions().find((session) => session.agentId === first.agent.agentId);
    assert.ok(firstSession);
    assert.equal(manager.evict(firstSession.id), true);
    await waitUntil(() => sqliteFdCount(first.cwd) === 0);
    assert.equal(sqliteFdCount(first.cwd), 0);
    assert.ok(sqliteFdCount(second.cwd) >= 5, "the other workspace store must stay open");

    const secondSession = manager.listSessions().find((session) => session.agentId === second.agent.agentId);
    assert.ok(secondSession);
    assert.equal(manager.evict(secondSession.id), true);
    await waitUntil(() => sqliteFdCount(second.cwd) === 0);
    assert.equal(sqliteFdCount(second.cwd), 0);
  });
});
