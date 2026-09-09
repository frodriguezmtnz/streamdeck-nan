export interface PluginShutdownTarget {
  stop(): Promise<void>;
  stopImmediately(): void;
}

interface ProcessLifecycle {
  once(event: "beforeExit" | "exit" | NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
  exit(code: number): unknown;
}

export function installPluginShutdown(
  target: PluginShutdownTarget | readonly PluginShutdownTarget[],
  runtime: ProcessLifecycle = process,
  timeoutMs = 5_000,
): () => Promise<void> {
  const targets = Array.isArray(target) ? target : [target];
  let cleanupPromise: Promise<void> | undefined;
  let terminalSignal: NodeJS.Signals | undefined;
  const stopImmediately = (): void => {
    for (const entry of targets) {
      try { entry.stopImmediately(); } catch { /* Sigue limpiando los demas recursos. */ }
    }
  };
  const cleanup = (): Promise<void> => {
    if (!cleanupPromise) {
      const graceful = Promise.all(targets.map((entry) => Promise.resolve().then(() => entry.stop())))
        .then(() => undefined);
      cleanupPromise = withTimeout(graceful, timeoutMs).catch((error) => {
        stopImmediately();
        throw error;
      });
    }
    return cleanupPromise!;
  };
  const signalHandlers = {
    SIGINT: (): void => stopForSignal("SIGINT"),
    SIGTERM: (): void => stopForSignal("SIGTERM"),
  };
  const stopForSignal = (signal: NodeJS.Signals): void => {
    if (terminalSignal) return;
    terminalSignal = signal;
    void cleanup().catch(() => undefined).finally(() => {
      runtime.off("SIGINT", signalHandlers.SIGINT);
      runtime.off("SIGTERM", signalHandlers.SIGTERM);
      runtime.exit(signal === "SIGINT" ? 130 : 143);
    });
  };

  runtime.once("beforeExit", () => void cleanup().catch(() => undefined));
  runtime.once("exit", stopImmediately);
  runtime.once("SIGINT", signalHandlers.SIGINT);
  runtime.once("SIGTERM", signalHandlers.SIGTERM);
  return cleanup;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Plugin shutdown timed out")), Math.max(1, timeoutMs));
    void operation.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}
