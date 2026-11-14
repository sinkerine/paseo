import pino from "pino";
import { expect, test } from "vitest";
import type { AgentStreamEvent } from "../../../../agent-sdk-types.js";
import { PiRpcAgentClient } from "../../agent.js";
import { PiHistoryMapper } from "../../history-mapper.js";
import type { PiAgentMessage } from "../../rpc-types.js";
import { FakePi } from "../../test-utils/fake-pi.js";
import type { PiExtensionToolCall } from "../contract.js";
import { createPiExtensionHost } from "../index.js";
import { piExtensions } from "../registry.js";
import { piGoalX } from "../pi-goal-x/index.js";
import { piGoal } from "./index.js";

function details(status = "active", statusReason?: string) {
  return {
    piGoal: 1,
    goal: {
      id: "goal-1",
      status,
      statusReason,
      objectivePreview: "Ship the adapter",
      ownerSessionId: "session-1",
      tokensUsed: 42,
      tokenBudget: 1000,
      wait: null,
    },
  };
}

function call(overrides: Partial<PiExtensionToolCall> = {}): PiExtensionToolCall {
  return {
    callId: "call-1",
    toolName: "create_goal",
    args: {},
    status: "completed",
    result: { content: [], details: details() },
    ...overrides,
  };
}

function todo(status = "in_progress", text = "Goal: Ship the adapter") {
  return {
    type: "todo",
    items: [{ id: "goal-1", text, status, completed: status === "completed" }],
  };
}

function notice(snapshot = details()): Extract<PiAgentMessage, { role: "custom" }> {
  return {
    role: "custom",
    customType: "pi-goal",
    content: "Hidden continuation instructions",
    display: true,
    details: snapshot,
  };
}

function timeline(events: AgentStreamEvent[]) {
  return events.flatMap((event) => (event.type === "timeline" ? [event.item] : []));
}

test.each(["create_goal", "get_goal", "update_goal", "adopt_goal", "clear_goal"])(
  "maps completed %s snapshots",
  (toolName) => {
    expect(piGoal.createSession().mapToolCall?.(call({ toolName }))).toEqual({
      timeline: [todo()],
    });
  },
);

test.each([
  ["active", "in_progress", "Goal: Ship the adapter"],
  ["complete", "completed", "Goal: Ship the adapter (complete: Evidence checked)"],
  ["paused", "pending", "Goal: Ship the adapter (paused: Evidence checked)"],
  ["blocked", "pending", "Goal: Ship the adapter (blocked: Evidence checked)"],
  ["budget_limited", "pending", "Goal: Ship the adapter (budget_limited: Evidence checked)"],
])("maps %s status and reason", (status, expectedStatus, text) => {
  expect(
    piGoal
      .createSession()
      .mapToolCall?.(
        call({ result: { content: [], details: details(status, "Evidence checked") } }),
      ),
  ).toEqual({ timeline: [todo(expectedStatus, text)] });
});

test("maps inactive status without a reason and accepts a public wait", () => {
  const snapshot = {
    ...details("paused"),
    goal: {
      ...details("paused").goal,
      statusReason: null,
      tokenBudget: null,
      wait: {
        reason: "Await review",
        deadline: "2026-11-14T12:00:00.000Z",
        message: { source_agent_id: "reviewer", prefix: "DONE" },
      },
    },
  };
  expect(
    piGoal.createSession().mapToolCall?.(call({ result: { content: [], details: snapshot } })),
  ).toEqual({ timeline: [todo("pending", "Goal: Ship the adapter (paused)")] });
});

test.each([
  call({ status: "running" }),
  call({ status: "failed" }),
  call({ toolName: "list_goals" }),
  call({ toolName: "other" }),
  call({ result: null }),
  call({ result: "goal created" }),
  call({ result: { content: [], details: { ...details(), piGoal: 2 } } }),
  call({ result: { content: [], details: { version: 3, goal: { taskList: { tasks: [] } } } } }),
  call({ result: { content: [], details: { piGoal: 1, goal: { id: "incomplete" } } } }),
])("declines unrelated, incomplete, or unsuccessful tool results %#", (input) => {
  expect(piGoal.createSession().mapToolCall?.(input)).toBeUndefined();
});

test("custom messages update and replay the latest todo without rendering continuation text", async () => {
  const host = createPiExtensionHost();
  const mapper = new PiHistoryMapper("pi", [], {}, host);
  const events = await mapper.mapMessages([
    notice(),
    { ...notice(details("blocked", "wait deadline expired")), display: false },
  ]);
  const latest = todo("pending", "Goal: Ship the adapter (blocked: wait deadline expired)");
  expect(timeline(events)).toEqual([todo(), latest]);
  expect(await mapper.hydrate()).toEqual([]);
  const replay = [];
  for await (const event of host.streamHistory()) replay.push(event);
  expect(replay).toEqual([{ type: "timeline", provider: "pi", item: latest }]);
  expect(piGoal.createSession().replay?.()).toBeUndefined();
});

test("tool snapshots replay and a cleared binding removes the goal todo", () => {
  const adapter = piGoal.createSession();
  adapter.mapToolCall?.(call());
  expect(adapter.replay?.()).toEqual({ subagents: [], timeline: [todo()] });
  expect(
    adapter.mapToolCall?.(
      call({ toolName: "clear_goal", result: { content: [], details: { piGoal: 1, goal: null } } }),
    ),
  ).toEqual({ timeline: [{ type: "todo", items: [] }] });
  expect(adapter.replay?.()).toEqual({ subagents: [], timeline: [{ type: "todo", items: [] }] });
});

test("declines foreign or malformed custom messages without changing replay state", () => {
  const adapter = piGoal.createSession();
  adapter.mapCustomMessage?.(notice());
  expect(adapter.mapCustomMessage?.({ ...notice(), customType: "other" })).toBeUndefined();
  expect(adapter.mapCustomMessage?.({ ...notice(), details: {} })).toBeUndefined();
  expect(adapter.replay?.()).toEqual({ subagents: [], timeline: [todo()] });
});

test("registry places pi-goal before pi-goal-x and keeps their result shapes separate", () => {
  expect(piExtensions.map((extension) => extension.id)).toEqual([
    "pi-btw",
    "pi-ask-user",
    "edxeth/pi-subagents",
    "pi-subagents",
    "@tintinweb/pi-subagents",
    "@gotgenes/pi-subagents",
    "pi-mcp-adapter",
    "rpiv-todo",
    "pi-example-todo",
    "pi-goal",
    "pi-goal-x",
    "rpiv-ask-user-question",
  ]);
  expect(piGoalX.createSession().mapToolCall?.(call())).toBeUndefined();
  expect(createPiExtensionHost().mapToolCall(call())?.timeline).toEqual([todo()]);
});

test("live tools and custom messages match reopened history", async () => {
  const pi = new FakePi();
  const client = new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime: pi });
  const session = await client.createSession({ provider: "pi", cwd: "/tmp/paseo-pi-goal" });
  const live: AgentStreamEvent[] = [];
  session.subscribe((event) => live.push(event));
  try {
    await session.startTurn("Create a goal");
    const runtime = pi.latestSession();
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "create_goal",
      args: {},
    });
    runtime.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "create_goal",
      result: { content: [], details: details() },
      isError: false,
    });
    runtime.emit({ type: "message_end", message: notice(details("paused", "user request")) });
    runtime.finishTurn();
    const history: PiAgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "create_goal", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "create_goal",
        content: [],
        details: details(),
      },
      notice(details("paused", "user request")),
    ];
    const replay = await new PiHistoryMapper("pi").mapMessages(history);
    const liveTodos = timeline(live).filter((item) => item.type === "todo");
    expect(liveTodos).toEqual([
      todo(),
      todo("pending", "Goal: Ship the adapter (paused: user request)"),
    ]);
    expect(timeline(replay).filter((item) => item.type === "todo")).toEqual(liveTodos);
    expect(timeline(live).filter((item) => item.type === "tool_call")).toHaveLength(2);
    expect(timeline(replay).filter((item) => item.type === "tool_call")).toHaveLength(2);
  } finally {
    await session.close();
  }
});

test("installed goal commands execute out of band during a running turn", async () => {
  const commands = ["goal-pause", "goal-resume", "goal-clear", "goal-list", "goal-adopt"];
  expect(piGoal.outOfBandCommands).toEqual(commands);
  const pi = new FakePi();
  pi.queueCommands(commands.map((name) => ({ name, source: "extension" })));
  const client = new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime: pi });
  const session = await client.createSession({ provider: "pi", cwd: "/tmp/paseo-pi-goal" });
  try {
    await session.startTurn("Main task");
    for (const name of commands) {
      const handler = session.tryHandleOutOfBand?.(`/${name} goal-1`);
      expect(handler).not.toBeNull();
      if (!handler) throw new Error(`Missing goal command ${name}`);
      await handler.run({ emit: () => undefined });
    }
    expect(session.tryHandleOutOfBand?.("/goal new objective")).toBeNull();
    expect(pi.latestSession().prompts.map(({ message }) => message)).toEqual([
      "Main task",
      ...commands.map((name) => `/${name} goal-1`),
    ]);
    expect(pi.latestSession().abortRequested).toBe(false);
    expect(pi.latestSession().steerCalls).toEqual([]);
    pi.latestSession().finishTurn();
  } finally {
    await session.close();
  }
});

test("uninstalled goal commands keep ordinary slash-command routing", async () => {
  const pi = new FakePi();
  const client = new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime: pi });
  const session = await client.createSession({ provider: "pi", cwd: "/tmp/paseo-pi-goal" });
  try {
    expect(session.tryHandleOutOfBand?.("/goal-pause")).toBeNull();
  } finally {
    await session.close();
  }
});
