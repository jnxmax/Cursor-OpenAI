import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Agent } from "@cursor/sdk";
import type { SDKAgent, ModelSelection, LocalAgentOptions } from "@cursor/sdk";
import type { SqliteLocalAgentStore } from "@cursor/sdk/dist/cjs/sqlite.js";
import type { AppConfig } from "../config";
import type { Logger } from "../logger";
import type { ChatCompletionMessage, ChatCompletionRequestMetadata } from "../types/openai";
import { computeNewSuffix, hashMessages, modelSelectionKey } from "../utils/hash";
import { Mutex } from "../utils/concurrency";
import { findNativeWorkspace, installNativeLifecycleHook, rememberNativeWorkspace } from "./nativeLifecycle";
import { openSqliteLocalAgentStore } from "./openSqliteLocalAgentStore";
import { SessionLifetime } from "./sessionLifetime";
import { drainLocalAgentWrites } from "./drainLocalAgentWrites";

export interface SessionHandle {
  /** Release the request reservation, including time spent waiting for the mutex. Idempotent. */
  release(): void;
  /** Joins SDK writes independently of the request reservation or cancellation acknowledgement. */
  whenIdle(): Promise<void>;
  agent: SDKAgent;
  mutex: Mutex;
  cwd: string;
  key: string;
  /** True the first time this agent handle is used (nothing has been sent to it yet through this gateway). */
  isFirstTurn: boolean;
  /** The subset of the request's `messages[]` this turn should actually send - see {@link computeNewSuffix}. */
  newMessages: ChatCompletionMessage[];
}

export interface SessionSummary {
  id: string;
  type: "explicit" | "resume" | "auto" | "fresh";
  agentId: string;
  model: string | undefined;
  messageCount: number;
  createdAt: number;
  lastUsedAt: number;
}

interface SessionEntry {
  lifetime: SessionLifetime;
  key: string;
  agent: SDKAgent;
  mutex: Mutex;
  cwd: string;
  lastUsedAt: number;
  createdAt: number;
  /** Full message array (client-visible turns, our reply included) this agent was last known to be in sync with. */
  lastMessages: ChatCompletionMessage[];
}

interface OwnedLocalStore {
  readonly store: SqliteLocalAgentStore;
  users: number;
  closing?: Promise<void>;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isStableKey(key: string): boolean {
  return key.startsWith("explicit:") || key.startsWith("resume:");
}

/**
 * Owns the mapping from an OpenAI-style conversation to a live Cursor
 * `SDKAgent`, so multi-turn conversations can reuse native agent context
 * instead of paying to replay full history on every request.
 *
 * Three ways a request can be associated with an existing agent, checked in
 * priority order:
 *
 * 1. `metadata.cursor_agent_id` - resume a specific Cursor agent by id.
 * 2. `metadata.session_id` - an opaque id the client controls and always
 *    reuses for one logical conversation. Kept under a stable key forever
 *    (never re-hashed/evicted-by-rename) since the client depends on being
 *    able to look that exact id back up on every subsequent turn.
 * 3. Auto-session - hash `messages[0..-2]` and look for a cached agent that
 *    was last left with exactly that prefix. Enabled by default; this is
 *    what makes plain, session-unaware OpenAI clients "just work" across
 *    turns as long as they resend full history (the normal OpenAI pattern).
 *
 * Regardless of which path resolves a session, {@link computeNewSuffix}
 * figures out exactly which of the request's messages are actually new to
 * this agent - correctly handling both clients that resend full history and
 * clients that send only the new message(s) per turn under an explicit id.
 */
export class SessionManager {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly stores = new Map<string, Promise<OwnedLocalStore>>();
  private readonly pendingEntries = new Map<string, Promise<SessionEntry>>();
  private readonly retiring = new Set<SessionEntry>();
  private readonly handles = new WeakMap<SessionHandle, SessionEntry>();
  private shutdownPromise: Promise<void> | undefined;
  private closing = false;
  private storeReleases: Promise<void> = Promise.resolve();
  private readonly storeFailures = new Map<string, Error>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly log: Logger,
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), Math.min(config.sessionTtlMs, 60_000));
    this.sweepTimer.unref();
  }

  async resolve(params: {
    apiKey: string;
    model: ModelSelection;
    messages: ChatCompletionMessage[];
    metadata: ChatCompletionRequestMetadata | undefined;
  }): Promise<SessionHandle> {
    if (this.closing) throw new Error("Cursor sessions are shutting down");
    const { apiKey, model, messages, metadata } = params;
    const apiKeyPart = shortHash(apiKey);

    const resumeId = metadata?.["cursor_agent_id"] ?? metadata?.["cursorAgentId"];
    if (typeof resumeId === "string" && resumeId.length > 0) {
      const key = `resume:${apiKeyPart}:${resumeId}`;
      const cached = this.entries.get(key);
      if (cached) return this.reuseHandle(key, cached, messages);

      return this.resolveHandle(key, messages, () => this.resumeEntry({ apiKey, model, key, resumeId }), false);
    }

    const explicitSessionId = metadata?.["session_id"] ?? metadata?.["sessionId"];
    if (this.config.sessionsEnabled && typeof explicitSessionId === "string" && explicitSessionId.length > 0) {
      const key = `explicit:${apiKeyPart}:${explicitSessionId}`;
      const cached = this.entries.get(key);
      if (cached) return this.reuseHandle(key, cached, messages);
      return this.resolveHandle(key, messages, () => this.createEntry(apiKey, model, key), true);
    }

    if (this.config.sessionsEnabled && this.config.autoSessionEnabled && messages.length > 1) {
      const prefix = messages.slice(0, -1);
      const modelKey = modelSelectionKey(model);
      const autoKey = `auto:${apiKeyPart}:${modelKey}:${hashMessages(modelKey, prefix)}`;
      const cached = this.entries.get(autoKey);
      if (cached) return this.reuseHandle(autoKey, cached, messages);
    }

    const freshKey = `fresh:${apiKeyPart}:${shortHash(`${Date.now()}:${Math.random()}`)}`;
    return this.resolveHandle(freshKey, messages, () => this.createEntry(apiKey, model, freshKey), true);
  }

  private async resolveHandle(key: string, messages: ChatCompletionMessage[], create: () => Promise<SessionEntry>, first: boolean): Promise<SessionHandle> {
    let pending = this.pendingEntries.get(key);
    if (!pending) {
      pending = (async () => {
        // A retired same-key owner must finish before re-opening its workspace.
        await Promise.all([...this.retiring].filter((entry) => entry.key === key).map((entry) => entry.lifetime.done));
        if (this.closing) throw new Error("Cursor sessions are shutting down");
        return create();
      })();
      this.pendingEntries.set(key, pending);
    }
    try {
      const entry = await pending;
      if (this.closing) {
        this.retire(entry);
        throw new Error("Cursor sessions are shutting down");
      }
      if (!entry.lifetime.isRetired) this.entries.set(key, entry);
      return this.toHandle(key, entry, messages, first);
    } finally {
      if (this.pendingEntries.get(key) === pending) this.pendingEntries.delete(key);
    }
  }

  private async resumeEntry(params: { apiKey: string; model: ModelSelection; key: string; resumeId: string }): Promise<SessionEntry> {
    const { apiKey, model, key, resumeId } = params;
    const nativeCwd = this.config.cursorRuntime === "local" && this.config.cursorNativeRestartHelper
      ? findNativeWorkspace(this.nativeWorkspaceAlias(apiKey, resumeId), this.log) : undefined;
    if (!nativeCwd && this.config.cursorRuntime === "local" && this.config.cursorNativeRestartHelper) {
      this.log.warn("Unknown native resume workspace; retaining SDK defaults without hook guarantee");
    }
    const cwd = nativeCwd ?? this.ensureCwd(key);
    const store = nativeCwd ? await this.acquireStore(nativeCwd) : undefined;
    let agent: SDKAgent;
    try {
      agent = await Agent.resume(resumeId,
        nativeCwd
          ? { apiKey, model, mode: this.config.cursorAgentMode, local: this.localOptions(nativeCwd, store) }
          : { apiKey });
    } catch (error) {
      if (store) return this.releaseFailedCreation(cwd, error);
      throw error;
    }
    // A resumed agent already has real history on Cursor's side even
    // though we've never seen it locally - treat every message the client
    // sends as new content for this turn rather than "cold replay" history.
    return this.newEntry({ agent, cwd, key, hasStore: store !== undefined });
  }

  /** Refreshes bookkeeping for this conversation's cache entry once a turn completes successfully. */
  remember(params: { apiKey: string; model: ModelSelection; messages: ChatCompletionMessage[]; handle: SessionHandle }): void {
    if (!this.config.sessionsEnabled) return;
    const { apiKey, model, messages, handle } = params;
    const entry = this.handles.get(handle);
    // Never resurrect an evicted owner or overwrite a newer same-key session.
    if (!entry || this.entries.get(entry.key) !== entry) return;

    if (isStableKey(handle.key)) {
      entry.lastMessages = messages;
      entry.lastUsedAt = Date.now();
      this.entries.set(handle.key, entry);
      this.enforceCapacity();
      return;
    }

    if (!this.config.autoSessionEnabled) return;

    const apiKeyPart = shortHash(apiKey);
    const modelKey = modelSelectionKey(model);
    const autoKey = `auto:${apiKeyPart}:${modelKey}:${hashMessages(modelKey, messages)}`;
    entry.lastMessages = messages;
    entry.lastUsedAt = Date.now();

    const displaced = this.entries.get(autoKey);
    if (displaced && displaced !== entry) this.disposeEntry(autoKey, displaced, "auto-session collision");
    if (entry.key !== autoKey) this.entries.delete(entry.key);
    entry.key = autoKey;
    this.entries.set(autoKey, entry);
    this.enforceCapacity();
  }

  stats() {
    return {
      cachedAgents: this.entries.size, maxCachedAgents: this.config.maxCachedAgents,
      retiringAgents: this.retiring.size, ownedStores: this.stores.size,
      failedStores: this.storeFailures.size,
      failedSessions: [...this.entries.values(), ...this.retiring].filter((entry) => entry.lifetime.failed).length,
    };
  }

  /** Snapshot of every cached session for the admin dashboard - newest-used first. Never exposes the agent object itself, only display-safe metadata. */
  listSessions(): SessionSummary[] {
    return [...this.entries.entries()]
      .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)
      .map(([key, entry]) => ({
        id: key,
        type: (key.split(":")[0] as SessionSummary["type"] | undefined) ?? "fresh",
        agentId: entry.agent.agentId,
        model: entry.agent.model?.id,
        messageCount: entry.lastMessages.length,
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt,
      }));
  }

  /** Evicts one cached session by its `id` (the same opaque string returned by `listSessions()`). Returns true if it existed. */
  evict(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.disposeEntry(id, entry, "manually evicted from admin dashboard");
    return true;
  }

  /** Evicts every cached session. Returns how many were removed. */
  evictAll(): number {
    const count = this.entries.size;
    for (const [key, entry] of [...this.entries]) {
      this.disposeEntry(key, entry, "manually cleared from admin dashboard");
    }
    return count;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    clearInterval(this.sweepTimer);
    this.evictAll();
    this.shutdownPromise = (async () => {
      await Promise.allSettled(this.pendingEntries.values());
      await this.drain();
    })();
    return this.shutdownPromise;
  }

  /** Waits for retired owners, not for still-cached idle agents. */
  async drain(): Promise<void> {
    const outcomes = await Promise.allSettled([...this.retiring].map((entry) => entry.lifetime.done));
    await this.storeReleases;
    const errors = outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason);
    errors.push(...this.storeFailures.values());
    if (errors.length > 0) throw new AggregateError(errors, "Cursor session drain failed");
  }

  private reuseHandle(key: string, entry: SessionEntry, messages: ChatCompletionMessage[]): SessionHandle {
    this.localOptions(entry.cwd);
    return this.toHandle(key, entry, messages);
  }

  private toHandle(key: string, entry: SessionEntry, messages: ChatCompletionMessage[], first = false): SessionHandle {
    entry.lastUsedAt = Date.now();
    const handle: SessionHandle = {
      release: entry.lifetime.retain(),
      whenIdle: () => entry.lifetime.whenIdle(),
      agent: entry.agent,
      mutex: entry.mutex,
      cwd: entry.cwd,
      key,
      isFirstTurn: first,
      newMessages: first ? messages : computeNewSuffix(entry.lastMessages, messages),
    };
    this.handles.set(handle, entry);
    this.enforceCapacity();
    return handle;
  }

  private newEntry(params: { agent: SDKAgent; cwd: string; key: string; hasStore: boolean }): SessionEntry {
    const { agent, cwd, key, hasStore } = params;
    const lifetime = new SessionLifetime(agent, {
      releaseStore: () => hasStore ? this.releaseStore(cwd) : Promise.resolve(),
      flushWrites: () => hasStore ? drainLocalAgentWrites(agent) : Promise.resolve(),
    }, this.log);
    return { lifetime, key, agent: lifetime.agent, mutex: new Mutex(), cwd, lastUsedAt: Date.now(), createdAt: Date.now(), lastMessages: [] };
  }

  private async createEntry(apiKey: string, model: ModelSelection, key: string): Promise<SessionEntry> {
    const cwd = this.ensureCwd(key);
    const store = await this.acquireStore(cwd);
    let agent: SDKAgent;
    try {
      agent = await Agent.create({
        apiKey,
        model,
        name: "cursor-openai-gateway",
        mode: this.config.cursorAgentMode,
        local: this.localOptions(cwd, store),
        cloud: this.config.cursorRuntime === "cloud" ? {} : undefined,
      });
    } catch (error) {
      if (store) return this.releaseFailedCreation(cwd, error);
      throw error;
    }
    if (this.config.cursorRuntime === "local" && this.config.cursorNativeRestartHelper) {
      rememberNativeWorkspace({ cwd, alias: this.nativeWorkspaceAlias(apiKey, agent.agentId), log: this.log });
    }
    return this.newEntry({ agent, cwd, key, hasStore: store !== undefined });
  }

  private nativeWorkspaceAlias(apiKey: string, agentId: string): string {
    return path.join(this.config.cursorWorkdirRoot, `.native-resume-${shortHash(`resume:${shortHash(apiKey)}:${agentId}`)}`);
  }

  private localOptions(cwd: string, store?: SqliteLocalAgentStore): LocalAgentOptions | undefined {
    if (this.config.cursorRuntime !== "local") return undefined;
    const installed = installNativeLifecycleHook({ cwd, helper: this.config.cursorNativeRestartHelper, log: this.log });
    return {
      cwd,
      settingSources: installed ? ["project"] : [],
      enableAgentRetries: true,
      ...(store ? { store } : {}),
      ...(installed ? { autoReview: false, sandboxOptions: { enabled: false } } : {}),
    };
  }

  /**
   * The default SDK store stays cached for the process lifetime and
   * `agent.close()` does not close it. Own one store per workspace instead.
   */
  private async acquireStore(cwd: string): Promise<SqliteLocalAgentStore | undefined> {
    if (this.config.cursorRuntime !== "local") return undefined;
    let pending = this.stores.get(cwd);
    if (!pending) {
      pending = openSqliteLocalAgentStore(cwd).then((store) => ({ store, users: 0 }));
      this.stores.set(cwd, pending);
    }
    const owned = await pending.catch((error: unknown) => {
      if (this.stores.get(cwd) === pending) this.stores.delete(cwd);
      throw error;
    });
    if (owned.closing) {
      // Do not hand out a partially closed store; failures remain quarantined.
      await owned.closing;
      return this.acquireStore(cwd);
    }
    owned.users += 1;
    return owned.store;
  }

  private async releaseStore(cwd: string): Promise<void> {
    const pending = this.stores.get(cwd);
    if (!pending) return;
    const owned = await pending;
    owned.users -= 1;
    if (owned.users > 0) return;
    owned.closing = (async () => {
      try {
        await owned.store.dispose();
        if (this.stores.get(cwd) === pending) this.stores.delete(cwd);
      } catch (cause) {
        const err = new Error("Cursor SQLite store cleanup failed", { cause });
        this.storeFailures.set(cwd, err);
        this.log.error({ err }, "Cursor SQLite store disposal failed; owner quarantined");
        throw err;
      }
    })();
    // One broken store must not prevent independent healthy stores from draining.
    this.storeReleases = Promise.allSettled([this.storeReleases, owned.closing]).then(() => undefined);
    await owned.closing;
  }

  private async releaseFailedCreation(cwd: string, error: unknown): Promise<never> {
    try {
      await this.releaseStore(cwd);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Cursor creation and cleanup failed");
    }
    throw error;
  }

  private ensureCwd(key: string): string {
    const dir = path.join(this.config.cursorWorkdirRoot, shortHash(key));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private enforceCapacity(): void {
    if (this.entries.size <= this.config.maxCachedAgents) return;
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    const excess = this.entries.size - this.config.maxCachedAgents;
    for (let i = 0; i < excess; i += 1) {
      const item = sorted[i];
      if (!item) continue;
      const [key, entry] = item;
      this.disposeEntry(key, entry, "capacity eviction");
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastUsedAt > this.config.sessionTtlMs) {
        this.disposeEntry(key, entry, "ttl expired");
      }
    }
  }

  private disposeEntry(key: string, entry: SessionEntry, reason: string): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    this.log.debug({ agentId: entry.agent.agentId, reason }, "retiring cached Cursor session");
    this.retire(entry);
  }

  private retire(entry: SessionEntry): void {
    if (this.retiring.has(entry)) return;
    this.retiring.add(entry);
    // Failures remain owned and are reported by SessionLifetime and drain().
    void entry.lifetime.retire().then(() => { this.retiring.delete(entry); }, () => undefined);
  }
}
