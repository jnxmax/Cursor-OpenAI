import type { SDKAgent } from "@cursor/sdk";

/**
 * SDK 1.0.22 omits checkpointPersistChain from its cancelled-run completion path.
 * No public drain API exists: keep this version-sensitive adapter explicit and
 * fail closed if the installed SDK no longer exposes the verified chain.
 * Call only after run.wait()/conversation(), when the executor has stopped.
 */
export async function drainLocalAgentWrites(agent: SDKAgent): Promise<void> {
  if (!("checkpointPersistChain" in agent)) {
    throw new Error("Unsupported Cursor SDK local checkpoint drain contract");
  }
  for (;;) {
    const pending: unknown = agent.checkpointPersistChain;
    if (!(pending instanceof Promise)) {
      throw new Error("Unsupported Cursor SDK local checkpoint drain contract");
    }
    await pending;
    if (agent.checkpointPersistChain === pending) return;
  }
}
