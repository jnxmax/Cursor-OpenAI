import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../logger";

/**
 * Shared quota state for subscription models served by this gateway
 * (cursor-abo: grok-4.7, gemini-3.8-flash, claude-opus-5-5).
 *
 * Two actors:
 * - Gateway runtime: on a quota-shaped run error for a subscription model,
 *   marks it exhausted and retries on the next model in the fallback chain.
 * - Telegram picker (via hermes-agent plugins/platforms/telegram/adapter.py
 *   `_cursor_quota()`): renders the exhausted state as a greyed
 *   "🔒 <label> · épuisée" row with no callback (Bot API 10.3), blocking taps
 *   until the model recovers.
 *
 * Recovery is two-fold:
 * - Optimistic: a marked model auto-unmarks when a run on it later completes
 *   successfully (only reachable for direct runs that bypass the pre-check).
 * - TTL-based: marks expire after QUOTA_TTL_HOURS (default 5h, Cursor's 5h
 *   usage window). On expiry the picker un-greys and the gateway tries the
 *   model again; if quota is still gone it re-marks and fails over. This is
 *   the retry cadence that guarantees eventual de-grey. Both the TS and the
 *   Python reader apply the same TTL so they can never disagree.
 */

export type QuotaState = {
  /** model id -> ISO timestamp when marked exhausted */
  exhausted_since: Record<string, string>;
  /** model id -> last error text that triggered exhaustion (for the picker) */
  last_error: Record<string, string>;
};

const EMPTY: QuotaState = { exhausted_since: {}, last_error: {} };

let state: QuotaState = { ...EMPTY, exhausted_since: {}, last_error: {} };
let loaded = false;

function statePath(): string {
  return process.env.QUOTA_STATE_PATH || "/home/max/.hermes/cron/state/cursor-quota.json";
}

function load(): QuotaState {
  if (loaded) return state;
  loaded = true;
  const path = statePath();
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<QuotaState>;
      state = {
        exhausted_since: raw.exhausted_since ?? {},
        last_error: raw.last_error ?? {},
      };
    }
  } catch {
    state = { ...EMPTY, exhausted_since: {}, last_error: {} };
  }
  return state;
}

function persist(): void {
  const path = statePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 1), { mode: 0o644 });
  } catch {
    // best-effort: picker still functions with in-memory state
  }
}

/** Mark a model as exhausted (quota gone). */
export function markExhausted(modelId: string, reason: string, log?: Logger): void {
  if (!modelId) return;
  const s = load();
  const wasAlready = Boolean(s.exhausted_since[modelId]);
  if (!wasAlready) {
    s.exhausted_since[modelId] = new Date().toISOString();
  }
  s.last_error[modelId] = reason.slice(0, 200);
  persist();
  log?.warn({ modelId, reason: s.last_error[modelId] }, wasAlready ? "model still exhausted (re-marked)" : "model marked EXHAUSTED");
}

/** Clear the exhausted flag after a successful run (optimistic recovery). */
export function markRecovered(modelId: string, log?: Logger): void {
  const s = load();
  if (s.exhausted_since[modelId]) {
    delete s.exhausted_since[modelId];
    delete s.last_error[modelId];
    persist();
    log?.info({ modelId }, "model quota RECOVERED — picker row un-greyed");
  }
}

/** How long an exhaustion mark stays authoritative before we re-probe. */
const QUOTA_TTL_MS = (() => {
  const hours = Number(process.env.QUOTA_TTL_HOURS ?? "5");
  return (Number.isFinite(hours) && hours > 0 ? hours : 5) * 3_600_000;
})();

function isFresh(since: string): boolean {
  const markedAt = Date.parse(since);
  if (!Number.isFinite(markedAt)) return false;
  return Date.now() - markedAt < QUOTA_TTL_MS;
}

/** Whether the model is currently marked exhausted (and the mark is fresh). */
export function isExhausted(modelId: string): boolean {
  const since = load().exhausted_since[modelId];
  return typeof since === "string" && isFresh(since);
}

/** Snapshot for the picker meta: id -> {disabled, since, reason}. */
export function pickerQuotaMeta(): Record<string, { disabled: boolean; since: string; reason: string }> {
  const s = load();
  const out: Record<string, { disabled: boolean; since: string; reason: string }> = {};
  for (const [modelId, since] of Object.entries(s.exhausted_since)) {
    if (!isFresh(since)) continue;
    out[modelId] = { disabled: true, since, reason: s.last_error[modelId] ?? "" };
  }
  return out;
}

/**
 * Best-effort classification of a Cursor run error as quota exhaustion.
 * Cursor surfaces "You've hit your monthly usage limit" style text; we keep
 * the patterns deliberately narrow to avoid grey-out on transient 429s.
 */
export function looksLikeQuotaError(message: unknown): boolean {
  const text = String(message ?? "").toLowerCase();
  if (!text) return false;
  const patterns = [
    "usage limit",
    "usage-based pricing limit",
    "out of quota",
    "quota exceeded",
    "quota exhausted",
    "insufficient",
    "monthly limit",
    "rate limit exceeded for your plan",
    "upgrade your plan",
    "reached your",
  ];
  return patterns.some((p) => text.includes(p));
}

/**
 * Fallback chain for subscription models served by this gateway.
 * Mirrors the Hermes fleet fallback chain documented in the picker contract.
 */
export function fallbackChainFor(requestedModelId: string): string[] {
  const chain = ["grok-4.7", "gemini-3.8-flash", "claude-opus-5-5"];
  const idx = chain.indexOf(requestedModelId);
  if (idx === -1) return [];
  const rest = chain.slice(idx + 1).filter((m) => !isExhausted(m));
  return rest;
}