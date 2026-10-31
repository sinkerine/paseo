import { describe, expect, test, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiExtensionHost } from "../index.js";
import {
  parseToolArgs,
  parseToolResult,
  type PiToolResult,
  type PiTrackedToolCall,
} from "../../tool-call-mapper.js";
import { mapPiChildSession } from "../child-session.js";
import { readSubagentFixture, verifySubagentFixture } from "../subagent-fixture-test.js";
import pino from "pino";
import { PiRpcAgentClient } from "../../agent.js";
import { FakePi } from "../../test-utils/fake-pi.js";
import type { AgentStreamEvent } from "../../../../agent-sdk-types.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { streamPiHistory } from "../../history-mapper.js";
import { piSubagents } from "./index.js";
import { PI_SUBAGENTS_ASYNC_STARTED_MARKER, piSubagentsRuntimeBridge } from "./runtime-bridge.js";

const Snapshots = z.object({
  statusSnapshots: z.object({
    running: z.record(z.string(), z.unknown()),
    mid: z.record(z.string(), z.unknown()),
    complete: z.record(z.string(), z.unknown()),
  }),
});

async function workflowFixture(kind: "direct" | "codemode", root: string) {
  const url = new URL(`./fixtures/workflow-${kind}.json`, import.meta.url);
  const fixture = readSubagentFixture(url, { from: "<CAPTURE_ROOT>", to: root });
  const { statusSnapshots } = Snapshots.parse(
    JSON.parse(readFileSync(url, "utf8").replaceAll("<CAPTURE_ROOT>", root)),
  );
  const started = fixture.events.find(
    (event) => event.type === "extension_ui_request" && event.method === "notify",
  );
  if (!started || started.type !== "extension_ui_request" || !started.message)
    throw new Error("Missing bridge event");
  const discovery = z
    .object({ id: z.string(), asyncDir: z.string() })
    .parse(JSON.parse(started.message.slice(PI_SUBAGENTS_ASYNC_STARTED_MARKER.length + 1)));
  await mkdir(discovery.asyncDir, { recursive: true });
  async function advance(snapshot: Record<string, unknown>) {
    await writeFile(
      join(discovery.asyncDir, "status.json"),
      JSON.stringify({ ...snapshot, pid: process.pid }),
    );
  }
  return { fixture, statusSnapshots, discovery, advance };
}

function rowStatuses(events: AgentStreamEvent[]) {
  const rows = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "provider_subagent") continue;
    if (event.event.type === "remove") rows.delete(event.event.id);
    if (event.event.type === "upsert" && event.event.status)
      rows.set(event.event.id, event.event.status);
  }
  return [...rows.values()];
}

function mapping(toolCall: PiTrackedToolCall, result: PiToolResult) {
  return createPiExtensionHost().mapToolCall({
    callId: "test-call",
    toolName: toolCall.toolName,
    args: toolCall.args,
    status: result ? "completed" : "running",
    result,
  });
}
function mapToolDetail(toolCall: PiTrackedToolCall, result: PiToolResult) {
  return mapping(toolCall, result)?.detail;
}

function hasChildTimeline(events: AgentStreamEvent[]) {
  return events.some(
    (event) => event.type === "provider_subagent" && event.event.type === "timeline",
  );
}

function hasCompletedChild(events: AgentStreamEvent[]) {
  return events.some(
    (event) =>
      event.type === "provider_subagent" &&
      event.event.type === "upsert" &&
      event.event.status === "completed",
  );
}

describe("pi-subagents adapter", () => {
  test("follows async status and transcript without bg_wait", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-async-"));
    const file = join(dir, "child.jsonl");
    const received: AgentStreamEvent[] = [];
    const host = createPiExtensionHost();
    try {
      host.follow((event) => received.push(event));
      host.mapToolCall({
        callId: "call-1",
        toolName: "subagent",
        args: { agent: "scout", task: "Inspect", async: true },
        status: "completed",
        result: {
          details: { mode: "single", runId: "run-1", asyncId: "run-1", asyncDir: dir, results: [] },
        },
      });
      await writeFile(
        file,
        '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"BEGIN"}]}}\n',
      );
      await writeFile(
        join(dir, "status.json"),
        JSON.stringify({
          state: "running",
          steps: [{ agent: "scout", status: "running", sessionFile: file }],
        }),
      );
      await expect.poll(() => hasChildTimeline(received)).toBe(true);
      await writeFile(
        join(dir, "status.json"),
        JSON.stringify({
          state: "complete",
          steps: [{ agent: "scout", status: "complete", sessionFile: file }],
        }),
      );
      await expect.poll(() => hasCompletedChild(received)).toBe(true);
    } finally {
      host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("settles an async run and reads its transcript from the completion notice on replay", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-async-"));
    const file = join(dir, "child.jsonl");
    try {
      await writeFile(
        file,
        '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"DONE"}]}}\n',
      );
      const host = createPiExtensionHost();
      host.mapToolCall({
        callId: "call-1",
        toolName: "subagent",
        args: { agent: "scout", task: "Inspect", async: true },
        status: "completed",
        result: {
          details: { mode: "single", runId: "run-1", asyncId: "run-1", asyncDir: dir, results: [] },
        },
      });
      const notice = host.mapCustomMessage({
        role: "custom",
        customType: "subagent-notify",
        content: [
          "Background task completed: **scout**",
          "",
          "Session file: /tmp/not-the-session-line.jsonl",
          "",
          `Retention-managed async directory: ${dir}`,
          "",
          `Session file: ${file}`,
        ].join("\n"),
      });
      expect(notice?.subagents).toEqual([{ type: "upsert", id: "call-1", status: "completed" }]);
      expect(hasChildTimeline(await notice!.hydration)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("maps completed subagent calls with task input to sub-agent detail", () => {
    const toolCall = parseToolArgs("subagent", {
      agent: "reviewer",
      task: "Review the Pi mapper change",
    });
    const result = parseToolResult({
      content: [{ type: "text", text: "The mapper change preserves provider status." }],
    });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "sub_agent",
      subAgentType: "reviewer",
      description: "Review the Pi mapper change",
      log: "The mapper change preserves provider status.",
    });
  });

  test("maps the captured foreground run and child Pi timeline live and on replay", async () => {
    const raw = readSubagentFixture(new URL("./fixtures/foreground.json", import.meta.url));
    const result = raw.events.find(
      (event) =>
        event.type === "tool_execution_end" &&
        event.toolName === "subagent" &&
        event.result &&
        typeof event.result === "object" &&
        "details" in event.result &&
        Array.isArray(event.result.details?.results) &&
        event.result.details.results.length > 0,
    );
    if (!result || result.type !== "tool_execution_end")
      throw new Error("Missing captured child session");
    const original = (result.result as { details: { results: Array<{ sessionFile: string }> } })
      .details.results[0].sessionFile;
    const fixture = readSubagentFixture(new URL("./fixtures/foreground.json", import.meta.url), {
      from: original,
      to: fileURLToPath(new URL("./fixtures/child-session.jsonl", import.meta.url)),
    });
    const events = await verifySubagentFixture(fixture);
    expect(
      events
        .filter((event) => event.event.type === "upsert")
        .map((event) => (event.event.type === "upsert" ? event.event.status : null)),
    ).toContain("completed");
    expect(events.filter((event) => event.event.type === "timeline").length).toBeGreaterThan(0);
  });

  test("settles captured async runs from the completion notice live and on replay", async () => {
    const fixture = readSubagentFixture(new URL("./fixtures/background.json", import.meta.url));
    const events = await verifySubagentFixture(fixture);
    expect(events.findLast((event) => event.event.type === "upsert")?.event).toEqual(
      expect.objectContaining({ status: "completed" }),
    );
  });

  test("maps bg_wait completion to the original async child", async () => {
    const raw = readSubagentFixture(new URL("./fixtures/wait.json", import.meta.url));
    const wait = raw.events.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "bg_wait",
    );
    if (!wait || wait.type !== "tool_execution_end")
      throw new Error("Missing captured bg_wait result");
    const original = (
      wait.result as {
        details: { completions: Array<{ results: Array<{ sessionFile: string }> }> };
      }
    ).details.completions[0].results[0].sessionFile;
    const fixture = readSubagentFixture(new URL("./fixtures/wait.json", import.meta.url), {
      from: original,
      to: fileURLToPath(new URL("./fixtures/child-session.jsonl", import.meta.url)),
    });
    const events = await verifySubagentFixture(fixture);
    const upserts = events
      .filter((event) => event.event.type === "upsert")
      .map((event) => (event.event.type === "upsert" ? event.event : null));
    // bg_wait settles the child; the later completion notice repeats it.
    expect(upserts.map((event) => event?.status)).toEqual([
      "running",
      "running",
      "completed",
      "completed",
    ]);
    expect(new Set(upserts.map((event) => event?.id)).size).toBe(1);
    expect(events.filter((event) => event.event.type === "timeline").length).toBeGreaterThan(0);
  });

  test("missing child file produces no timeline", async () => {
    expect(await mapPiChildSession("child", "/does-not-exist/pi-child.jsonl")).toEqual([]);
  });

  test("does not emit child timeline after session close", async () => {
    const raw = readSubagentFixture(new URL("./fixtures/foreground.json", import.meta.url));
    const completion = raw.events.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "subagent",
    );
    if (!completion || completion.type !== "tool_execution_end") throw new Error("No completion");
    const original = (completion.result as { details: { results: Array<{ sessionFile: string }> } })
      .details.results[0].sessionFile;
    const fixture = readSubagentFixture(new URL("./fixtures/foreground.json", import.meta.url), {
      from: original,
      to: fileURLToPath(new URL("./fixtures/child-session.jsonl", import.meta.url)),
    });
    const pi = new FakePi();
    const client = new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime: pi });
    const session = await client.createSession({
      provider: "pi",
      cwd: "/tmp/paseo-pi-child-close",
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.startTurn("Delegate work");
    for (const event of fixture.events) pi.latestSession().emit(event);
    await session.close();
    expect(
      events.some((event) => event.type === "provider_subagent" && event.event.type === "upsert"),
    ).toBe(true);
    expect(
      events.some((event) => event.type === "provider_subagent" && event.event.type === "timeline"),
    ).toBe(false);
  });

  test("a failed spawn without result rows finishes its descriptor", () => {
    const host = createPiExtensionHost();
    const args = { agent: "scout", task: "Inspect" };
    host.mapToolCall({
      callId: "failed",
      toolName: "subagent",
      args,
      status: "running",
      result: null,
    });
    expect(
      host.mapToolCall({
        callId: "failed",
        toolName: "subagent",
        args,
        status: "failed",
        result: { content: [{ type: "text", text: "spawn failed" }] },
      })?.subagents,
    ).toEqual([
      {
        type: "upsert",
        id: "failed",
        title: "scout",
        description: "Inspect",
        toolCallId: "failed",
        status: "failed",
      },
    ]);
  });
});

describe("Pi workflow tracking", () => {
  for (const kind of ["direct", "codemode"] as const) {
    test(`${kind} captured workflow follows steps after parent idle and settles without notice`, async () => {
      const root = await mkdtemp(join(process.cwd(), "../../.dev/pi-workflow-test-"));
      const pi = new FakePi();
      const client = new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime: pi });
      const session = await client.createSession({ provider: "pi", cwd: root });
      const received: AgentStreamEvent[] = [];
      const other = createPiExtensionHost();
      const unrelated: AgentStreamEvent[] = [];
      try {
        const capture = await workflowFixture(kind, root);
        await capture.advance(capture.statusSnapshots.running);
        session.subscribe((event) => received.push(event));
        other.follow((event) => unrelated.push(event));
        await session.startTurn("Delegate workflow");
        for (const event of capture.fixture.events) {
          if (
            event.type === "message_start" ||
            event.type === "message_end" ||
            event.type === "message_update"
          )
            continue;
          pi.latestSession().emit(event);
        }
        pi.latestSession().finishTurn();
        expect(rowStatuses(received)).toEqual(["running", "running"]);
        await capture.advance(capture.statusSnapshots.mid);
        await expect.poll(() => rowStatuses(received)).toEqual(["running", "completed", "running"]);
        await capture.advance(capture.statusSnapshots.complete);
        await expect
          .poll(() => rowStatuses(received))
          .toEqual(["completed", "completed", "completed"]);
        expect(unrelated).toEqual([]);
        const owners = received.flatMap((event) =>
          event.type === "provider_subagent" &&
          event.event.type === "upsert" &&
          event.event.title === "workflow"
            ? [event.event]
            : [],
        );
        expect(new Set(owners.map((row) => row.id)).size).toBe(1);
        if (kind === "codemode")
          expect(owners.at(-1)?.toolCallId).toBe(
            String(capture.statusSnapshots.running.toolCallId).split("/")[0],
          );
      } finally {
        other.close();
        await session.close();
        await rm(root, { recursive: true, force: true });
      }
    });

    test(`${kind} captured completed workflow maps live and replay consistently`, async () => {
      const root = await mkdtemp(join(process.cwd(), "../../.dev/pi-workflow-test-"));
      try {
        const capture = await workflowFixture(kind, root);
        await capture.advance(capture.statusSnapshots.complete);
        // Supply replay discovery through the same configured root Pi uses.
        const replay = join(root, "replay");
        const dir = join(replay, "async-subagent-runs", capture.discovery.id);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "status.json"), JSON.stringify(capture.statusSnapshots.complete));
        vi.stubEnv("PI_SUBAGENTS_TEMP_ROOT", replay);
        // Direct tool results persist asyncDir; codemode replay resolves the configured root.
        if (kind === "direct") {
          const events = await verifySubagentFixture(capture.fixture);
          expect(rowStatuses(events)).toEqual(["completed", "completed", "completed"]);
        } else {
          const events: AgentStreamEvent[] = [];
          for await (const event of streamPiHistory("pi", capture.fixture.messages))
            events.push(event);
          expect(rowStatuses(events)).toEqual(["completed", "completed", "completed"]);
        }
      } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  test.each(["failed", "stopped", "running"] as const)(
    "replays %s workflow without phantom running rows",
    async (state) => {
      const root = await mkdtemp(join(process.cwd(), "../../.dev/pi-workflow-test-"));
      try {
        const capture = await workflowFixture("direct", root);
        await writeFile(
          join(capture.discovery.asyncDir, "status.json"),
          JSON.stringify({ ...capture.statusSnapshots.mid, state, pid: 2147483647 }),
        );
        const messages = capture.fixture.messages.filter((message) => message.role !== "custom");
        const events: AgentStreamEvent[] = [];
        for await (const event of streamPiHistory("pi", messages)) events.push(event);
        const outcome = state === "failed" ? "failed" : "canceled";
        expect(rowStatuses(events)).toEqual([outcome, "completed", outcome]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.each([
    "missing",
    "invalid JSON",
    "invalid schema",
    "missing toolCallId",
    "mismatched toolCallId",
  ])("removes unverified direct workflow with %s status live and on replay", async (statusFile) => {
    const root = await mkdtemp(join(process.cwd(), "../../.dev/pi-workflow-test-"));
    try {
      const capture = await workflowFixture("direct", root);
      const file = join(capture.discovery.asyncDir, "status.json");
      switch (statusFile) {
        case "invalid JSON":
          await writeFile(file, "{");
          break;
        case "invalid schema":
          await capture.advance({ ...capture.statusSnapshots.running, steps: "invalid" });
          break;
        case "missing toolCallId":
          await capture.advance({ ...capture.statusSnapshots.running, toolCallId: undefined });
          break;
        case "mismatched toolCallId":
          await capture.advance({
            ...capture.statusSnapshots.running,
            toolCallId: `${capture.statusSnapshots.running.toolCallId}/1`,
          });
          break;
      }
      const fixture = {
        ...capture.fixture,
        events: capture.fixture.events.filter((event) => event.type !== "message_end"),
        messages: capture.fixture.messages.filter((message) => message.role !== "custom"),
      };
      const events = await verifySubagentFixture(fixture);
      expect(events.map((event) => event.event)).toEqual([
        expect.objectContaining({
          type: "upsert",
          id: capture.statusSnapshots.running.toolCallId,
          title: "workflow",
          status: "running",
        }),
        { type: "remove", id: capture.statusSnapshots.running.toolCallId },
      ]);
      expect(rowStatuses(events)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects codemode ids without verified ownership and claims bridge notifications without rows", async () => {
    const root = await mkdtemp(join(process.cwd(), "../../.dev/pi-workflow-test-"));
    try {
      const capture = await workflowFixture("codemode", root);
      await capture.advance({ ...capture.statusSnapshots.running, toolCallId: "another-agent/1" });
      const adapter = piSubagents.createSession();
      expect(
        adapter.mapRuntimeNotification?.(
          `${PI_SUBAGENTS_ASYNC_STARTED_MARKER} ${JSON.stringify(capture.discovery)}`,
        ),
      ).toEqual({ subagents: [] });
      expect(adapter.poll?.()).toBeUndefined();
      const end = capture.fixture.events.findLast(
        (event) => event.type === "tool_execution_end" && event.toolName === "codemode",
      );
      if (!end || end.type !== "tool_execution_end") throw new Error("Missing codemode result");
      expect(
        adapter.mapToolCall?.({
          callId: end.toolCallId,
          toolName: "codemode",
          args: {},
          status: "completed",
          result: parseToolResult(end.result),
        }),
      ).toBeUndefined();
      expect(adapter.poll?.()).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["workflowScript", "workflowScriptPath", "workflow"])(
    "maps %s workflow start and failure",
    (field) => {
      const host = createPiExtensionHost();
      const call = {
        callId: "workflow-call",
        toolName: "subagent",
        args: { [field]: "example" },
        result: null,
      };
      try {
        expect(host.mapToolCall({ ...call, status: "running" })?.subagents).toEqual([
          {
            type: "upsert",
            id: "workflow-call",
            title: "workflow",
            description: undefined,
            toolCallId: "workflow-call",
            status: "running",
          },
        ]);
        expect(host.mapToolCall({ ...call, status: "failed" })?.subagents).toEqual([
          {
            type: "upsert",
            id: "workflow-call",
            title: "workflow",
            description: undefined,
            toolCallId: "workflow-call",
            status: "failed",
          },
        ]);
      } finally {
        host.close();
      }
    },
  );

  test("codemode-only replay verifies ownership from the configured async root", async () => {
    const root = await mkdtemp(join(process.cwd(), "../../.dev/pi-workflow-test-"));
    try {
      const capture = await workflowFixture("codemode", root);
      vi.stubEnv("PI_SUBAGENTS_TEMP_ROOT", join(root, "codemode/tmp"));
      await capture.advance(capture.statusSnapshots.mid);
      const messages = capture.fixture.messages.filter((message) => message.role !== "custom");
      const events: AgentStreamEvent[] = [];
      for await (const event of streamPiHistory("pi", messages)) events.push(event);
      expect(rowStatuses(events)).toEqual(["running", "completed", "running"]);
      const rows = events.flatMap((event) =>
        event.type === "provider_subagent" && event.event.type === "upsert" ? [event.event] : [],
      );
      expect(rows.map((row) => row.toolCallId)).toEqual(
        Array(3).fill(String(capture.statusSnapshots.mid.toolCallId).split("/")[0]),
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["parallel", "chain"])("retains ordinary foreground %s row identities", (mode) => {
    const adapter = piSubagents.createSession();
    const mapped = adapter.mapToolCall?.({
      callId: "ordinary",
      toolName: "subagent",
      args: { agent: "worker", task: "Inspect" },
      status: "completed",
      result: {
        details: {
          mode,
          results: [
            { agent: "scout", exitCode: 0 },
            { agent: "reviewer", exitCode: 0 },
          ],
        },
      },
    });
    expect(mapped?.subagents).toEqual([
      {
        type: "upsert",
        id: "ordinary:0",
        title: "scout",
        description: "Inspect",
        toolCallId: "ordinary",
        status: "completed",
      },
      {
        type: "upsert",
        id: "ordinary:1",
        title: "reviewer",
        description: "Inspect",
        toolCallId: "ordinary",
        status: "completed",
      },
    ]);
  });

  test("bridge forwards top-level async starts and filters workflow children", () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const notices: unknown[] = [];
    const pi = {
      on: (name: string, handler: (...args: unknown[]) => void) => handlers.set(name, handler),
      events: {
        on: (name: string, handler: (...args: unknown[]) => void) => handlers.set(name, handler),
      },
    };
    new Function("pi", piSubagentsRuntimeBridge)(pi);
    handlers.get("session_start")?.(
      {},
      { ui: { notify: (...args: unknown[]) => notices.push(args) } },
    );
    const started = handlers.get("subagent:async-started")!;
    started(null);
    started({ id: 1, asyncDir: "/scratch" });
    started({ id: "child", asyncDir: "/scratch", parentWorkflowRunId: "parent" });
    started({ id: "parent", asyncDir: "/scratch" });
    expect(notices).toEqual([
      [`${PI_SUBAGENTS_ASYNC_STARTED_MARKER} {"id":"parent","asyncDir":"/scratch"}`, "info"],
    ]);
  });
});
