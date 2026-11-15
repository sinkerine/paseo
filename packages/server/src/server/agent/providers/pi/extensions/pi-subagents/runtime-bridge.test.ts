import { expect, test } from "vitest";
import { piExtensionRuntimeBridge } from "../index.js";

interface BridgeContext {
  sessionManager: {
    getSessionFile(): string | undefined;
    getSessionId(): string;
  };
  ui: { notify(message: string, level: string): void };
}

test("forwards only this session's workflow starts, including ones before session start", () => {
  const sessionHandlers: Array<(event: unknown, ctx: BridgeContext) => void> = [];
  const eventHandlers = new Map<string, Array<(event: unknown) => void>>();
  const notifications: string[] = [];
  const pi = {
    on(name: string, handler: (event: unknown, ctx: BridgeContext) => void) {
      if (name === "session_start") sessionHandlers.push(handler);
    },
    events: {
      emit(name: string, event: unknown) {
        for (const handler of eventHandlers.get(name) ?? []) handler(event);
      },
      on(name: string, handler: (event: unknown) => void) {
        const handlers = eventHandlers.get(name) ?? [];
        handlers.push(handler);
        eventHandlers.set(name, handlers);
      },
    },
    registerCommand() {},
  };
  new Function("pi", piExtensionRuntimeBridge)(pi);
  function emit(event: unknown) {
    for (const handler of eventHandlers.get("subagent:async-started") ?? []) handler(event);
  }
  function start(file: string | undefined, id: string) {
    const ctx: BridgeContext = {
      sessionManager: { getSessionFile: () => file, getSessionId: () => id },
      ui: { notify: (message, level) => notifications.push(`${level}:${message}`) },
    };
    for (const handler of sessionHandlers) handler({ reason: "startup" }, ctx);
  }
  const event = {
    mode: "workflow",
    id: "resumed-run",
    asyncDir: "/tmp/resumed-run",
    sessionId: "/tmp/parent.jsonl",
  };
  emit(event);
  emit({ ...event, sessionId: "/tmp/foreign.jsonl" });
  expect(notifications).toEqual([]);
  start("/tmp/parent.jsonl", "parent-id");
  const report =
    'info:PASEO_PI_SUBAGENTS_WORKFLOW_STARTED {"runId":"resumed-run","asyncDir":"/tmp/resumed-run"}';
  expect(notifications).toEqual([report]);
  emit(event);
  expect(notifications).toEqual([report, report]);
  for (const invalid of [
    undefined,
    { ...event, mode: "single" },
    { ...event, sessionId: "parent-id" },
    { ...event, sessionId: "/tmp/foreign.jsonl" },
    { ...event, id: undefined },
    { ...event, asyncDir: undefined },
    { ...event, sessionId: undefined },
  ])
    emit(invalid);
  expect(notifications).toEqual([report, report]);
  start(undefined, "new-session-id");
  emit(event);
  emit({ ...event, sessionId: "new-session-id" });
  expect(notifications).toEqual([report, report, report]);
});
