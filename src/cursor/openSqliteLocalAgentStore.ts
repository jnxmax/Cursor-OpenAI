import { createRequire } from "node:module";
import type { SqliteLocalAgentStore } from "@cursor/sdk/dist/cjs/sqlite.js";

const requireSdk = createRequire(__filename);

interface SqliteStoreModule {
  readonly SqliteLocalAgentStore: {
    open(options: { readonly workspaceRef: string }): Promise<SqliteLocalAgentStore>;
  };
}

function isSqliteStoreModule(value: unknown): value is SqliteStoreModule {
  if (typeof value !== "object" || value === null || !("SqliteLocalAgentStore" in value)) return false;
  const ctor: unknown = value.SqliteLocalAgentStore;
  if (typeof ctor !== "function" || !("open" in ctor)) return false;
  return typeof ctor.open === "function";
}

/** Loads `@cursor/sdk/sqlite`, the export Node resolves and this tsconfig cannot name directly. */
export function openSqliteLocalAgentStore(workspaceRef: string): Promise<SqliteLocalAgentStore> {
  const loaded: unknown = requireSdk("@cursor/sdk/sqlite");
  if (!isSqliteStoreModule(loaded)) {
    throw new Error("Cursor SDK sqlite store is unavailable");
  }
  return loaded.SqliteLocalAgentStore.open({ workspaceRef });
}
