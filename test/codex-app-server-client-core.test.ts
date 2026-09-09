import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient } from "../src/providers/codex/codex-app-server-client.ts";
import type { CodexAppServerTransport } from "../src/providers/codex/codex-app-server-transport.ts";

test("codex client initializes once before reading rate limits", async () => {
  const transport = new FakeTransport();
  const client = new CodexAppServerClient({ createTransport: async () => transport });

  assert.deepEqual(await client.readRateLimits(), { rateLimits: true });
  assert.deepEqual(await client.readRateLimits(), { rateLimits: true });
  assert.deepEqual(transport.methods, [
    "initialize",
    "initialized",
    "account/rateLimits/read",
    "account/rateLimits/read",
  ]);
});

class FakeTransport implements CodexAppServerTransport {
  readonly methods: string[] = [];
  private dataListener?: (chunk: string) => void;

  write(frame: string): void {
    const message = JSON.parse(frame) as { id?: number; method: string };
    this.methods.push(message.method);
    if (message.id !== undefined) {
      const result = message.method === "initialize" ? {} : { rateLimits: true };
      this.dataListener?.(`${JSON.stringify({ id: message.id, result })}\n`);
    }
  }

  onData(listener: (chunk: string) => void): () => void {
    this.dataListener = listener;
    return () => {
      this.dataListener = undefined;
    };
  }

  onExit(): () => void {
    return () => undefined;
  }

  async stop(): Promise<void> {}

  stopImmediately(): boolean {
    return true;
  }
}
