import type { SDKAgent, Run } from "@cursor/sdk";
import type { Logger } from "../logger";

/** Cache membership is not ownership: requests, queued mutex users and SDK runs hold separate leases. */
export class SessionLifetime {
  readonly agent: SDKAgent;
  readonly done: Promise<void>;
  private complete: () => void = () => undefined;
  private reject: (error: Error) => void = () => undefined;
  private users = 0;
  private operations = 0;
  private readonly idleWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  private retired = false;
  private disposing = false;
  private failure: Error | undefined;

  constructor(
    private readonly raw: SDKAgent,
    private readonly cleanup: { releaseStore: () => Promise<void>; flushWrites: () => Promise<void> },
    private readonly log: Logger,
  ) {
    this.done = new Promise<void>((resolve, reject) => { this.complete = resolve; this.reject = reject; });
    // Retain a failed owner; callers of drain/shutdown still receive the rejection.
    void this.done.catch((err: unknown) => log.error({ err, agentId: raw.agentId }, "Cursor session disposal failed; owner quarantined"));
    this.agent = {
      agentId: raw.agentId,
      get model() { return raw.model; },
      send: async (message, options) => {
        if (this.failure) throw this.failure;
        if (this.disposing || (this.retired && this.users === 0)) throw new Error("Cursor session is retired");
        this.operations += 1;
        try {
          const run = await raw.send(message, options);
          this.operations += 1;
          // The SDK cancellation status precedes controller.done and late checkpoints.
          void this.observeRun(run);
          return run;
        } finally {
          this.operationCompleted();
        }
      },
      // SDK close is synchronous; done owns/logs the deferred disposal outcome.
      close: () => { void this.retire(); },
      [Symbol.asyncDispose]: () => this.retire(),
      reload: () => raw.reload(),
      listArtifacts: () => raw.listArtifacts(),
      downloadArtifact: (path) => raw.downloadArtifact(path),
    };
  }

  get failed(): boolean { return this.failure !== undefined; }
  get isRetired(): boolean { return this.retired; }

  retain(): () => void {
    if (this.failure) throw this.failure;
    if (this.disposing) throw new Error("Cursor session is retired");
    this.users += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.users -= 1;
      this.tryDispose();
    };
  }

  whenIdle(): Promise<void> {
    if (this.operations === 0) return this.failure ? Promise.reject(this.failure) : Promise.resolve();
    return new Promise<void>((resolve, reject) => { this.idleWaiters.add({ resolve, reject }); });
  }

  private operationCompleted(): void {
    this.operations -= 1;
    if (this.operations === 0) {
      for (const waiter of this.idleWaiters) {
        if (this.failure) waiter.reject(this.failure); else waiter.resolve();
      }
      this.idleWaiters.clear();
    }
    this.tryDispose();
  }

  retire(): Promise<void> {
    this.retired = true;
    this.tryDispose();
    return this.done;
  }

  private async observeRun(run: Run): Promise<void> {
    try {
      await run.wait();
      // SDK 1.0.22 flushes pending conversation steps after its terminal writes.
      if (run.supports("conversation")) await run.conversation();
      await this.cleanup.flushWrites();
    } catch (cause) {
      this.failure = new Error("Cannot establish Cursor run quiescence", { cause });
      this.log.error({ err: this.failure, runId: run.id }, "Cursor run owner quarantined");
    } finally {
      this.operationCompleted();
    }
  }

  private tryDispose(): void {
    if (!this.retired || this.users !== 0 || this.operations !== 0 || this.disposing) return;
    this.disposing = true;
    // Completion/rejection is owned by done, not an unobserved background promise.
    void this.dispose().then(this.complete, (cause: unknown) => {
      this.failure = new Error("Cursor session cleanup failed", { cause });
      this.reject(this.failure);
    });
  }

  private async dispose(): Promise<void> {
    if (this.failure) throw this.failure;
    // close():void releases the executor without waiting; asyncDispose actually joins it.
    await this.raw[Symbol.asyncDispose]();
    await this.cleanup.releaseStore();
  }
}
