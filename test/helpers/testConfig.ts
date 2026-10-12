import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../../src/config";
import type { SessionManager, SessionHandle } from "../../src/cursor/sessionManager";

/** Cache-only tests finish the request reservation without starting an SDK run. */
export async function resolveIdleSession(manager: SessionManager, params: Parameters<SessionManager["resolve"]>[0]): Promise<SessionHandle> {
  const handle = await manager.resolve(params);
  handle.release();
  return handle;
}

/** Builds a fully-populated `AppConfig` for tests, with sane defaults and a fresh, uniquely-named scratch data dir per call (isolating any ConfigStore settings.json writes too - see ConfigStore's constructor). */
export function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-gw-test-"));
  const workdirRoot = path.join(dataDir, "workspaces");
  fs.mkdirSync(workdirRoot, { recursive: true });
  return {
    cursorApiKey: "test-key",
    cursorKeyMode: "server",
    port: 0,
    host: "127.0.0.1",
    nodeEnv: "test",
    authKey: undefined,
    corsOrigin: "*",
    cursorRuntime: "local",
    cursorWorkdirRoot: workdirRoot,
    cursorAgentMode: "agent",
    defaultModel: "composer-2.5",
    includeThinking: true,
    sessionsEnabled: true,
    autoSessionEnabled: true,
    sessionTtlMs: 1_800_000,
    maxCachedAgents: 50,
    maxConcurrentRuns: 8,
    requestTimeoutMs: 300_000,
    toolBridgeEnabled: true,
    toolBridgeMode: "hold",
    toolResultTimeoutMs: 900_000,
    rateLimitWindowMs: 60_000,
    rateLimitMax: 120,
    logLevel: "silent",
    logPretty: false,
    autoOpenBrowser: false,
    adminAllowRemote: false,
    jsonBodyLimitMb: 25,
    modelListMode: "canonical",
    allowedModels: "",
    ...overrides,
  };
}

function projectSlug(workspaceRef: string): string {
  return workspaceRef.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

/** Deletes only SDK project dirs created for an isolated `cursor-gw-test` workspace. */
export function removeIsolatedCursorProjects(workdirRoot: string): void {
  const dataDir = path.dirname(workdirRoot);
  if (!path.basename(dataDir).startsWith("cursor-gw-test-")) return;
  if (fs.existsSync(workdirRoot)) {
    for (const name of fs.readdirSync(workdirRoot)) {
      const slug = projectSlug(path.join(workdirRoot, name));
      if (!slug.includes("cursor-gw-test")) continue;
      fs.rmSync(path.join(os.homedir(), ".cursor", "projects", slug), { recursive: true, force: true });
    }
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}
