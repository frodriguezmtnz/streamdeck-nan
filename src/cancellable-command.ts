export interface CancellableCommand<T> {
  readonly result: Promise<T>;
  cancel(): void;
}

export type CommandExecution<T> = Promise<T> | CancellableCommand<T>;

export function cancellableCommand<T>(execution: CommandExecution<T>): CancellableCommand<T> {
  return "result" in execution
    ? execution
    : { result: execution, cancel: () => undefined };
}

interface CommandSettler<T> {
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface KillableChild {
  kill(signal: NodeJS.Signals): unknown;
}

export function hardDeadlineCommand<T>(
  timeoutMs: number,
  start: (settler: CommandSettler<T>) => KillableChild,
): CancellableCommand<T> {
  let child: KillableChild | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let resolveResult!: (value: T) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const resolve = (value: T): void => {
    if (settled) return;
    settled = true;
    if (deadline) clearTimeout(deadline);
    resolveResult(value);
  };
  const reject = (error: unknown): void => {
    if (settled) return;
    settled = true;
    if (deadline) clearTimeout(deadline);
    rejectResult(error);
  };
  try {
    child = start({ resolve, reject });
  } catch (error) {
    reject(error);
  }
  if (!settled) {
    deadline = setTimeout(() => {
      try { child?.kill("SIGKILL"); } catch { /* El deadline sigue siendo terminal. */ }
      reject(Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT" }));
    }, Math.max(1, timeoutMs));
  }
  return {
    result,
    cancel: () => {
      if (settled) return;
      try { child?.kill("SIGKILL"); } catch { /* La cancelacion igualmente liquida la promesa. */ }
      reject(new Error("Command cancelled"));
    },
  };
}
