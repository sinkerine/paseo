import { describe, expect, test } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendFile, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiExtensionHost } from "../index.js";
import { piSubagents } from "./index.js";
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
import { ProviderSubagentStore } from "../../../../provider-subagents/store.js";
import { streamPiHistory } from "../../history-mapper.js";
import type { PiExtensionEventOutput } from "../index.js";
import type { PiExtensionToolCall } from "../contract.js";
import type { PiAgentMessage } from "../../rpc-types.js";

const workflowRunId = "59a8fc66-dd1a-49cc-afc2-da8e82b90b9f";
const workflowId = `pi-subagents-workflow:${workflowRunId}`;
const workflowChildren = [
  { key: "T1-implement", title: "Implement T1", agent: "worker", group: "T1" },
  { key: "T1-review-1", title: "Review T1 round 1", agent: "reviewer", group: "T1" },
  { key: "T2.implement", title: "Implement T2", agent: "worker", group: "T2" },
  { key: "T2.review", title: "Review T2", agent: "reviewer", group: "T2" },
  { key: "cleanup", title: "Cleanup", agent: "worker", group: null },
];

interface WorkflowArtifacts {
  root: string;
  dir: string;
  childFiles: Map<string, string>;
}

async function workflowFixtureText(name: string, artifacts: WorkflowArtifacts): Promise<string> {
  let text = await readFile(new URL(`./fixtures/workflow/${name}`, import.meta.url), "utf8");
  text = text.replaceAll("__ASYNC_DIR__", JSON.stringify(artifacts.dir).slice(1, -1));
  text = text.replaceAll("__CAPTURE_ROOT__", JSON.stringify(artifacts.root).slice(1, -1));
  for (const [key, file] of artifacts.childFiles) {
    text = text.replaceAll(`__CHILD_SESSION_${key}__`, JSON.stringify(file).slice(1, -1));
  }
  return text;
}

async function seedWorkflowArtifacts(root: string): Promise<WorkflowArtifacts> {
  const dir = join(root, workflowRunId);
  const childFiles = new Map(
    workflowChildren.map(({ key }) => [key, join(root, `child-${key}.jsonl`)]),
  );
  const artifacts = { root, dir, childFiles };
  await mkdir(dir);
  for (const [key, file] of childFiles) {
    await writeFile(file, await workflowFixtureText(`child-${key}.jsonl`, artifacts));
  }
  await writeWorkflowStatus(artifacts, "complete");
  const decoyDir = join(root, "decoy-run");
  const decoyFile = join(root, "decoy-session.jsonl");
  await mkdir(decoyDir);
  await writeFile(
    decoyFile,
    '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"DECOY"}]}}\n',
  );
  await writeFile(
    join(decoyDir, "status.json"),
    JSON.stringify({
      runId: "decoy-run",
      mode: "workflow",
      state: "running",
      steps: [
        {
          workflowKey: "decoy",
          parentWorkflowRunId: "decoy-run",
          agent: "worker",
          sessionFile: decoyFile,
          status: "running",
        },
      ],
    }),
  );
  return artifacts;
}

async function writeWorkflowStatus(artifacts: WorkflowArtifacts, state: "running" | "complete") {
  await writeFile(
    join(artifacts.dir, "status.json"),
    JSON.stringify({
      ...JSON.parse(await workflowFixtureText(`status-${state}.json`, artifacts)),
      pid: process.pid,
    }),
  );
}

function applySubagentEvent(store: ProviderSubagentStore, event: AgentStreamEvent) {
  if (event.type === "provider_subagent") store.apply("parent", "pi", event.event);
}

function workflowStoreState(store: ProviderSubagentStore) {
  return store
    .list("parent")
    .map((descriptor) => ({
      id: descriptor.id,
      parentAgentId: descriptor.parentAgentId,
      parentSubagentId: descriptor.parentSubagentId,
      provider: descriptor.provider,
      title: descriptor.title,
      description: descriptor.description,
      status: descriptor.status,
      toolCallId: descriptor.toolCallId,
      cwd: descriptor.cwd,
      subtitle: descriptor.subtitle,
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function workflowTimeline(store: ProviderSubagentStore, id: string) {
  return store.fetchTimeline("parent", id, { limit: 0 }).rows.map((row) => row.item);
}

function expectCompletedWorkflow(store: ProviderSubagentStore) {
  const base = {
    parentAgentId: "parent",
    provider: "pi",
    description: null,
    status: "completed",
    toolCallId: null,
    cwd: null,
  };
  const expected = [
    {
      ...base,
      id: workflowId,
      parentSubagentId: null,
      title: "Workflow",
      subtitle: "2 of 2 groups done",
    },
    {
      ...base,
      id: `${workflowId}/group:T1`,
      parentSubagentId: workflowId,
      title: "T1",
      subtitle: "Review T1 round 1",
    },
    {
      ...base,
      id: `${workflowId}/group:T2`,
      parentSubagentId: workflowId,
      title: "T2",
      subtitle: "Review T2",
    },
    ...workflowChildren.map(({ key, title, agent, group }) => ({
      ...base,
      id: `${workflowId}/${key}`,
      parentSubagentId: group === null ? workflowId : `${workflowId}/group:${group}`,
      title,
      subtitle: agent,
    })),
  ].toSorted((left, right) => left.id.localeCompare(right.id));
  expect(workflowStoreState(store)).toEqual(expected);
  expect(workflowTimeline(store, workflowId)).toEqual([]);
  expect(workflowTimeline(store, `${workflowId}/group:T1`)).toEqual([]);
  expect(workflowTimeline(store, `${workflowId}/group:T2`)).toEqual([]);
  expect(JSON.stringify(workflowStoreState(store))).not.toContain("decoy");
}

async function workflowFixture(artifacts: WorkflowArtifacts) {
  const file = join(artifacts.root, "workflow-codemode.json");
  await writeFile(file, await workflowFixtureText("workflow-codemode.json", artifacts));
  return readSubagentFixture(pathToFileURL(file));
}

function workflowLaunch(dir: string): PiExtensionToolCall {
  return {
    callId: "scripted-workflow-codemode/1",
    toolName: "subagent",
    args: { workflowScript: "No script parsing is needed", async: true },
    status: "completed",
    result: { details: { mode: "workflow", runId: workflowRunId, asyncDir: dir } },
  };
}

function workflowTerminalNotice(dir: string): Extract<PiAgentMessage, { role: "custom" }> {
  return {
    role: "custom",
    customType: "subagent-notify",
    content: [
      "Background task completed: **workflow**",
      `Retention-managed async directory: ${dir}`,
      `Workflow run: ${workflowRunId}`,
    ].join("\n"),
  };
}

async function applyHostOutput(
  store: ProviderSubagentStore,
  output: PiExtensionEventOutput | undefined,
) {
  if (!output) throw new Error("Expected a workflow host mapping");
  for (const event of output.events) applySubagentEvent(store, event);
  for (const event of await output.hydration) applySubagentEvent(store, event);
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
  test("registers a retained single-worker resume for the subagent chip live and on replay", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-resume-"));
    const file = join(dir, "retained.jsonl");
    const host = createPiExtensionHost();
    const replay = createPiExtensionHost();
    const store = new ProviderSubagentStore();
    const replayStore = new ProviderSubagentStore();
    const call: PiExtensionToolCall = {
      callId: "resume-call",
      toolName: "subagent",
      args: { action: "resume", id: "previous-run", message: "Continue the repair" },
      status: "completed",
      result: {
        details: {
          mode: "single",
          runId: "resumed-run",
          asyncId: "resumed-run",
          asyncDir: dir,
          results: [],
        },
      },
    };
    try {
      const retainedMessages = Array.from({ length: 220 }, (_, index) =>
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Retained work ${index}` }],
          },
        }),
      );
      await writeFile(file, `${retainedMessages.join("\n")}\n`);
      const status = {
        runId: "resumed-run",
        revivedFrom: "previous-run",
        mode: "single",
        state: "running",
        pid: process.pid,
        steps: [{ agent: "worker", status: "running", sessionFile: file }],
      };
      await writeFile(join(dir, "status.json"), JSON.stringify(status));
      host.follow((event) => applySubagentEvent(store, event));
      await applyHostOutput(store, host.mapToolCall(call));
      expect(store.list("parent")).toEqual([
        expect.objectContaining({ id: "resume-call", title: "worker", status: "running" }),
      ]);
      await expect.poll(() => workflowTimeline(store, "resume-call").length).toBe(220);
      expect(JSON.stringify(workflowTimeline(store, "resume-call"))).toContain("Retained work 219");
      await applyHostOutput(replayStore, replay.mapToolCall(call));
      expect(workflowStoreState(replayStore)).toEqual(workflowStoreState(store));
      expect(workflowTimeline(replayStore, "resume-call")).toEqual(
        workflowTimeline(store, "resume-call"),
      );
      await appendFile(
        file,
        '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Continued work"}]}}\n',
      );
      await expect
        .poll(() => JSON.stringify(workflowTimeline(store, "resume-call")))
        .toContain("Continued work");
      await writeFile(
        join(dir, "status.json"),
        JSON.stringify({
          ...status,
          state: "complete",
          steps: [{ ...status.steps[0], status: "complete" }],
        }),
      );
      await expect.poll(() => store.get("parent", "resume-call")?.status).toBe("completed");
    } finally {
      host.close();
      replay.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("admits only successful resume receipts and waits for their exact named run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-resume-"));
    const session = piSubagents.createSession();
    const call: PiExtensionToolCall = {
      callId: "resume-call",
      toolName: "subagent",
      args: { action: "resume", id: "previous-run" },
      status: "completed",
      result: {
        details: { mode: "single", runId: "resumed-run", asyncDir: dir, results: [] },
      },
    };
    try {
      expect(session.mapToolCall?.({ ...call, status: "running" })).toBeUndefined();
      expect(session.mapToolCall?.({ ...call, status: "failed" })).toBeUndefined();
      expect(
        session.mapToolCall?.({ ...call, args: { action: "status", id: "previous-run" } }),
      ).toBeUndefined();
      expect(
        session.mapToolCall?.({ ...call, result: { details: { mode: "single", results: [] } } }),
      ).toBeUndefined();
      expect(session.poll?.()).toBeUndefined();
      expect(session.mapToolCall?.(call)).toEqual({
        subagents: [{ type: "upsert", id: "resume-call", status: "running" }],
      });
      const status = {
        mode: "single",
        state: "running",
        toolCallId: "original-call",
        pid: process.pid,
        steps: [{ agent: "worker", status: "running", sessionFile: join(dir, "retained.jsonl") }],
      };
      await writeFile(join(dir, "status.json"), JSON.stringify({ ...status, runId: "other-run" }));
      expect(session.poll?.()).toBeUndefined();
      await writeFile(
        join(dir, "status.json"),
        JSON.stringify({ ...status, runId: "resumed-run" }),
      );
      const mapped = session.poll?.();
      expect(mapped?.subagents).toEqual([
        {
          type: "upsert",
          id: "resume-call",
          toolCallId: "resume-call",
          title: "worker",
          description: undefined,
          status: "running",
        },
      ]);
      expect(mapped?.childSessions).toEqual([
        { id: "resume-call", file: join(dir, "retained.jsonl"), lifetime: "conversation" },
      ]);
      expect(session.poll?.()).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a resumed row can discover its already-read retained transcript on a later poll", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-resume-"));
    const file = join(dir, "retained.jsonl");
    const session = piSubagents.createSession();
    try {
      session.mapToolCall?.({
        callId: "original-call",
        toolName: "subagent",
        args: { agent: "worker", task: "Repair" },
        status: "completed",
        result: {
          details: {
            mode: "single",
            results: [{ agent: "worker", exitCode: 0, sessionFile: file }],
          },
        },
      });
      await writeFile(
        join(dir, "status.json"),
        JSON.stringify({
          runId: "resumed-run",
          mode: "single",
          state: "running",
          pid: process.pid,
          steps: [{ agent: "worker", status: "running" }],
        }),
      );
      const initial = session.mapToolCall?.({
        callId: "resume-call",
        toolName: "subagent",
        args: { action: "resume", id: "previous-run" },
        status: "completed",
        result: { details: { mode: "single", runId: "resumed-run", asyncDir: dir, results: [] } },
      });
      expect(initial?.childSessions).toEqual([]);
      await writeFile(
        join(dir, "status.json"),
        JSON.stringify({
          runId: "resumed-run",
          mode: "single",
          state: "running",
          pid: process.pid,
          steps: [{ agent: "worker", status: "running", sessionFile: file }],
        }),
      );
      expect(session.poll?.()?.childSessions).toEqual([
        { id: "resume-call", file, lifetime: "conversation" },
      ]);
      expect(session.poll?.()).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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
      log: "",
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

describe("pi-subagents workflows", () => {
  test("recovers a stopped workflow from a later mission snapshot live and on replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-pi-mission-"));
    try {
      const artifacts = await seedWorkflowArtifacts(root);
      const status = JSON.parse(await workflowFixtureText("status-complete.json", artifacts));
      await writeFile(
        join(artifacts.dir, "status.json"),
        JSON.stringify({ ...status, state: "stopped" }),
      );
      const notice: PiAgentMessage = {
        role: "custom",
        customType: "subagent-incremental-child-notify",
        content: `Workflow child completed: **T1-implement**\nWorkflow run: ${workflowRunId}`,
      };
      const details = {
        mode: "workflow",
        runId: "later-workflow",
        asyncDir: join(root, "later-workflow"),
        results: [],
        mission: {
          runs: [
            { mode: "single", runId: "single", asyncDir: join(root, "single") },
            { mode: "workflow", runId: "decoy-run", asyncDir: join(root, "decoy-run") },
            { mode: "workflow", runId: workflowRunId, asyncDir: artifacts.dir, status: "stopped" },
          ],
        },
      };
      const liveStore = new ProviderSubagentStore();
      const host = createPiExtensionHost();
      await applyHostOutput(liveStore, host.mapCustomMessage(notice));
      await applyHostOutput(
        liveStore,
        host.mapToolCall({
          callId: "later",
          toolName: "subagent",
          args: { workflowScript: "opaque", async: true },
          status: "completed",
          result: { details },
        }),
      );
      const replayStore = new ProviderSubagentStore();
      for await (const ev of streamPiHistory("pi", [
        notice,
        {
          role: "toolResult",
          toolCallId: "later",
          toolName: "subagent",
          content: [],
          details,
          isError: false,
        },
      ]))
        applySubagentEvent(replayStore, ev);
      expect(workflowStoreState(replayStore)).toEqual(workflowStoreState(liveStore));
      expect(liveStore.get("parent", workflowId)).toMatchObject({
        status: "canceled",
        subtitle: "2 of 2 groups done",
      });
      expect(liveStore.list("parent")).toHaveLength(9);
      for (const { key, agent, group } of workflowChildren) {
        expect(liveStore.get("parent", `${workflowId}/${key}`)).toMatchObject({
          subtitle: agent,
          parentSubagentId: group ? `${workflowId}/group:${group}` : workflowId,
        });
        expect(workflowTimeline(liveStore, `${workflowId}/${key}`)).toHaveLength(3);
        expect(workflowTimeline(replayStore, `${workflowId}/${key}`)).toHaveLength(3);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("maps the captured codemode workflow to the same real store tree and timelines live and on replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-pi-workflow-"));
    const pi = new FakePi();
    const client = new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime: pi });
    const session = await client.createSession({ provider: "pi", cwd: root });
    const liveStore = new ProviderSubagentStore();
    session.subscribe((event) => applySubagentEvent(liveStore, event));
    try {
      const artifacts = await seedWorkflowArtifacts(root);
      const fixture = await workflowFixture(artifacts);
      await session.startTurn("RUN_WORKFLOW");
      for (const event of fixture.events) pi.latestSession().emit(event);
      pi.latestSession().finishTurn();
      await expect.poll(() => liveStore.list("parent").length).toBe(8);
      await expect.poll(() => workflowTimeline(liveStore, `${workflowId}/cleanup`).length).toBe(3);
      const replayStore = new ProviderSubagentStore();
      for await (const event of streamPiHistory("pi", fixture.messages)) {
        applySubagentEvent(replayStore, event);
      }
      expectCompletedWorkflow(liveStore);
      expectCompletedWorkflow(replayStore);
      expect(workflowStoreState(liveStore)).toEqual(workflowStoreState(replayStore));
      await expect
        .poll(() => {
          const counts: number[] = [];
          for (const { key } of workflowChildren) {
            counts.push(workflowTimeline(liveStore, `${workflowId}/${key}`).length);
          }
          return counts;
        })
        .toEqual([3, 3, 3, 3, 3]);
      const liveCounts = workflowChildren.map(
        ({ key }) => workflowTimeline(liveStore, `${workflowId}/${key}`).length,
      );
      const replayCounts = workflowChildren.map(
        ({ key }) => workflowTimeline(replayStore, `${workflowId}/${key}`).length,
      );
      expect(liveCounts).toEqual([3, 3, 3, 3, 3]);
      expect(replayCounts).toEqual(liveCounts);
      for (const { key } of workflowChildren) {
        expect(JSON.stringify(workflowTimeline(liveStore, `${workflowId}/${key}`))).not.toContain(
          "DECOY",
        );
      }
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("streams T2.review while running and performs the final read as its group completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-pi-workflow-live-"));
    const pi = new FakePi();
    const client = new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime: pi });
    const session = await client.createSession({ provider: "pi", cwd: root });
    const store = new ProviderSubagentStore();
    const received: AgentStreamEvent[] = [];
    session.subscribe((event) => {
      received.push(event);
      applySubagentEvent(store, event);
    });
    const reviewId = `${workflowId}/T2.review`;
    const groupId = `${workflowId}/group:T2`;
    try {
      const artifacts = await seedWorkflowArtifacts(root);
      const fixture = await workflowFixture(artifacts);
      const reviewFile = artifacts.childFiles.get("T2.review");
      if (!reviewFile) throw new Error("Missing captured review transcript");
      const transcript = await readFile(reviewFile, "utf8");
      const rows = transcript.trimEnd().split("\n");
      // Hold the captured tool result and final text until terminal evidence arrives.
      await writeFile(reviewFile, `${rows.slice(0, -2).join("\n")}\n`);
      await writeWorkflowStatus(artifacts, "running");
      await session.startTurn("RUN_WORKFLOW");
      for (const event of fixture.events.slice(0, 4)) pi.latestSession().emit(event);
      expect(workflowStoreState(store)).toEqual([
        {
          id: workflowId,
          parentAgentId: "parent",
          parentSubagentId: null,
          provider: "pi",
          title: "Workflow",
          description: null,
          status: "running",
          toolCallId: null,
          cwd: null,
          subtitle: null,
        },
      ]);
      await expect.poll(() => workflowTimeline(store, reviewId).length).toBe(2);
      expect(store.get("parent", reviewId)?.status).toBe("running");
      expect(store.get("parent", groupId)?.status).toBe("running");
      expect(store.get("parent", `${workflowId}/group:T1`)?.status).toBe("completed");
      expect(store.get("parent", `${workflowId}/T2.implement`)?.status).toBe("completed");
      expect(workflowTimeline(store, reviewId)).toContainEqual(
        expect.objectContaining({
          type: "tool_call",
          name: "bash",
          status: "running",
        }),
      );
      expect(JSON.stringify(workflowTimeline(store, reviewId))).not.toContain(
        "PASEO_SCRIPTED_DONE:T2.review",
      );
      expect(store.get("parent", `${workflowId}/cleanup`)).toBeNull();
      await appendFile(reviewFile, `${rows.slice(-2).join("\n")}\n`);
      await writeWorkflowStatus(artifacts, "complete");
      await expect.poll(() => store.get("parent", reviewId)?.status).toBe("completed");
      await expect.poll(() => workflowTimeline(store, reviewId).length).toBe(3);
      expectCompletedWorkflow(store);
      expect(workflowTimeline(store, reviewId)).toContainEqual(
        expect.objectContaining({
          type: "assistant_message",
          text: "PASEO_SCRIPTED_DONE:T2.review",
        }),
      );
      const childStatuses = received.flatMap((event) =>
        event.type === "provider_subagent" &&
        event.event.type === "upsert" &&
        event.event.id === reviewId
          ? [event.event.status]
          : [],
      );
      const groupStatuses = received.flatMap((event) =>
        event.type === "provider_subagent" &&
        event.event.type === "upsert" &&
        event.event.id === groupId
          ? [event.event.status]
          : [],
      );
      expect(childStatuses.filter((status, index) => status !== childStatuses[index - 1])).toEqual([
        "running",
        "completed",
      ]);
      expect(groupStatuses.filter((status, index) => status !== groupStatuses[index - 1])).toEqual([
        "running",
        "completed",
      ]);
      const firstTimeline = received.findIndex(
        (event) =>
          event.type === "provider_subagent" &&
          event.event.type === "timeline" &&
          event.event.id === reviewId,
      );
      const completion = received.findIndex(
        (event) =>
          event.type === "provider_subagent" &&
          event.event.type === "upsert" &&
          event.event.id === reviewId &&
          event.event.status === "completed",
      );
      expect(firstTimeline).toBeGreaterThan(-1);
      expect(firstTimeline).toBeLessThan(completion);
      for (const event of fixture.events.slice(4)) pi.latestSession().emit(event);
      pi.latestSession().finishTurn();
      const replayStore = new ProviderSubagentStore();
      for await (const event of streamPiHistory("pi", fixture.messages))
        applySubagentEvent(replayStore, event);
      expect(workflowStoreState(store)).toEqual(workflowStoreState(replayStore));
      await expect
        .poll(() => {
          const counts: number[] = [];
          for (const { key } of workflowChildren) {
            counts.push(workflowTimeline(store, `${workflowId}/${key}`).length);
          }
          return counts;
        })
        .toEqual([3, 3, 3, 3, 3]);
      for (const { key } of workflowChildren) {
        expect(workflowTimeline(store, `${workflowId}/${key}`)).toHaveLength(3);
        expect(workflowTimeline(replayStore, `${workflowId}/${key}`)).toHaveLength(3);
      }
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rebuilds only the two completed children proven by the real incremental notices", async () => {
    const RealNoticeCapture = z.object({
      excerpts: z.array(
        z
          .object({ customType: z.string(), content: z.string(), display: z.boolean() })
          .passthrough()
          .or(z.object({ nestedCalls: z.unknown() })),
      ),
    });
    const capture = RealNoticeCapture.parse(
      JSON.parse(
        await readFile(new URL("./fixtures/workflow/real-notices.json", import.meta.url), "utf8"),
      ),
    );
    const messages: PiAgentMessage[] = capture.excerpts.flatMap((excerpt) =>
      "customType" in excerpt
        ? [
            {
              role: "custom",
              customType: excerpt.customType,
              content: excerpt.content,
              display: excerpt.display,
            },
          ]
        : [],
    );
    const store = new ProviderSubagentStore();
    for await (const event of streamPiHistory("pi", messages)) applySubagentEvent(store, event);
    const id = "pi-subagents-workflow:38e069c4-1f41-46b2-a21a-8f947abe29cd";
    expect(workflowStoreState(store)).toEqual(
      [
        {
          id,
          title: "Workflow",
          subtitle: "2 of 2 runs done",
          status: "running",
          parentSubagentId: null,
        },
        {
          id: `${id}/T1-implement`,
          title: "T1-implement",
          subtitle: null,
          status: "completed",
          parentSubagentId: id,
        },
        {
          id: `${id}/T1-review-1`,
          title: "T1-review-1",
          subtitle: null,
          status: "completed",
          parentSubagentId: id,
        },
      ]
        .map(({ id: subagentId, title, subtitle, status, parentSubagentId }) => ({
          id: subagentId,
          title,
          subtitle,
          status,
          parentSubagentId,
          parentAgentId: "parent",
          provider: "pi",
          description: null,
          toolCallId: null,
          cwd: null,
        }))
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    );
    expect(store.get("parent", `${id}/T1-fix-1`)).toBeNull();
    for (const descriptor of store.list("parent"))
      expect(workflowTimeline(store, descriptor.id)).toEqual([]);
  });

  test("reads only named workflow artifacts and skips foreign and host steps", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-pi-workflow-scope-"));
    const host = createPiExtensionHost();
    const store = new ProviderSubagentStore();
    try {
      const artifacts = await seedWorkflowArtifacts(root);
      const status = z
        .object({ steps: z.array(z.unknown()) })
        .passthrough()
        .parse(JSON.parse(await readFile(join(artifacts.dir, "status.json"), "utf8")));
      status.steps.push(
        {
          workflowKey: "foreign",
          parentWorkflowRunId: "foreign-workflow",
          sessionFile: join(root, "decoy-session.jsonl"),
          agent: "worker",
          status: "completed",
        },
        {
          parentWorkflowRunId: workflowRunId,
          sessionFile: join(root, "decoy-session.jsonl"),
          agent: "worker",
          status: "completed",
        },
      );
      await writeFile(join(artifacts.dir, "status.json"), JSON.stringify(status));
      await applyHostOutput(store, host.mapCustomMessage(workflowTerminalNotice(artifacts.dir)));
      expectCompletedWorkflow(store);
      for (const { key } of workflowChildren) {
        expect(workflowTimeline(store, `${workflowId}/${key}`)).toHaveLength(3);
        expect(JSON.stringify(workflowTimeline(store, `${workflowId}/${key}`))).not.toContain(
          "DECOY",
        );
      }
      await applyHostOutput(store, host.mapCustomMessage(workflowTerminalNotice(artifacts.dir)));
      for (const { key } of workflowChildren)
        expect(workflowTimeline(store, `${workflowId}/${key}`)).toHaveLength(3);
      expect(
        host.mapCustomMessage(workflowTerminalNotice(join(root, "decoy-run"))),
      ).toBeUndefined();
    } finally {
      host.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    { name: "malformed JSON", status: "{" },
    {
      name: "mismatched run id",
      status: JSON.stringify({ runId: "foreign", mode: "workflow", state: "complete", steps: [] }),
    },
    {
      name: "mismatched mode",
      status: JSON.stringify({
        runId: workflowRunId,
        mode: "single",
        state: "complete",
        steps: [],
      }),
    },
  ])("isolates $name and keeps following valid workflows and direct calls", async ({ status }) => {
    const root = await mkdtemp(join(tmpdir(), "paseo-pi-workflow-invalid-"));
    const host = createPiExtensionHost();
    const store = new ProviderSubagentStore();
    host.follow((event) => applySubagentEvent(store, event));
    try {
      const artifacts = await seedWorkflowArtifacts(root);
      await writeFile(join(artifacts.dir, "status.json"), status);
      await applyHostOutput(store, host.mapToolCall(workflowLaunch(artifacts.dir)));
      await applyHostOutput(store, host.mapCustomMessage(workflowTerminalNotice(artifacts.dir)));
      expect(
        store.list("parent").map(({ id, status: lifecycle }) => ({ id, status: lifecycle })),
      ).toEqual([{ id: workflowId, status: "completed" }]);
      expect(
        host.mapCustomMessage({
          role: "custom",
          customType: "subagent-incremental-child-notify",
          content: "malformed",
        }),
      ).toBeUndefined();
      expect(
        host.mapCustomMessage({
          role: "custom",
          customType: "subagent-notify",
          content: "malformed",
        }),
      ).toBeUndefined();
      await writeWorkflowStatus(artifacts, "complete");
      await applyHostOutput(store, host.mapToolCall(workflowLaunch(artifacts.dir)));
      await expect.poll(() => store.list("parent").length).toBe(8);
      await expect.poll(() => workflowTimeline(store, `${workflowId}/cleanup`).length).toBe(3);
      expectCompletedWorkflow(store);
      const direct = host.mapToolCall({
        callId: "direct",
        toolName: "subagent",
        args: { agent: "worker", task: "Inspect" },
        status: "completed",
        result: { details: { mode: "single", results: [{ agent: "worker", exitCode: 0 }] } },
      });
      expect(direct?.subagents).toEqual([
        {
          type: "upsert",
          id: "direct",
          title: "worker",
          description: "Inspect",
          toolCallId: "direct",
          status: "completed",
        },
      ]);
    } finally {
      host.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("isolates malformed child transcripts and still hydrates valid siblings", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-pi-workflow-transcript-"));
    const host = createPiExtensionHost();
    const store = new ProviderSubagentStore();
    try {
      const artifacts = await seedWorkflowArtifacts(root);
      const badFile = artifacts.childFiles.get("T1-implement");
      if (!badFile) throw new Error("Missing captured implement transcript");
      await writeFile(badFile, "{invalid JSON}\n");
      await applyHostOutput(store, host.mapCustomMessage(workflowTerminalNotice(artifacts.dir)));
      expectCompletedWorkflow(store);
      expect(workflowTimeline(store, `${workflowId}/T1-implement`)).toEqual([]);
      expect(workflowTimeline(store, `${workflowId}/T1-review-1`)).toHaveLength(3);
      expect(workflowTimeline(store, `${workflowId}/cleanup`)).toHaveLength(3);
    } finally {
      host.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("combines workflow and direct polling and shares transcript registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-pi-workflow-direct-"));
    const host = createPiExtensionHost();
    const store = new ProviderSubagentStore();
    host.follow((event) => applySubagentEvent(store, event));
    try {
      const artifacts = await seedWorkflowArtifacts(root);
      await writeWorkflowStatus(artifacts, "running");
      const directDir = join(root, "direct");
      await mkdir(directDir);
      const sharedFile = artifacts.childFiles.get("T1-implement");
      if (!sharedFile) throw new Error("Missing shared child transcript");
      const direct = host.mapToolCall({
        callId: "direct",
        toolName: "subagent",
        args: { agent: "worker", task: "Inspect", async: true },
        status: "completed",
        result: {
          details: {
            mode: "single",
            runId: "direct-run",
            asyncId: "direct-run",
            asyncDir: directDir,
            results: [],
          },
        },
      });
      await applyHostOutput(store, direct);
      await writeFile(
        join(directDir, "status.json"),
        JSON.stringify({
          state: "running",
          steps: [{ agent: "worker", status: "running", sessionFile: sharedFile }],
        }),
      );
      await applyHostOutput(store, host.mapToolCall(workflowLaunch(artifacts.dir)));
      await expect.poll(() => workflowTimeline(store, "direct").length).toBe(3);
      await expect.poll(() => workflowTimeline(store, `${workflowId}/T2.review`).length).toBe(3);
      expect(workflowTimeline(store, `${workflowId}/T1-implement`)).toEqual([]);
      expect(store.get("parent", `${workflowId}/group:T2`)?.status).toBe("running");
      await writeFile(
        join(directDir, "status.json"),
        JSON.stringify({
          state: "complete",
          steps: [{ agent: "worker", status: "complete", sessionFile: sharedFile }],
        }),
      );
      await writeWorkflowStatus(artifacts, "complete");
      await expect.poll(() => store.get("parent", "direct")?.status).toBe("completed");
      await expect.poll(() => store.get("parent", workflowId)?.status).toBe("completed");
      expect(workflowTimeline(store, "direct")).toHaveLength(3);
    } finally {
      host.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("claims successful async workflow results before direct args without adding tool detail", () => {
    const host = createPiExtensionHost();
    try {
      const call = workflowLaunch("/missing/workflow");
      call.args = { agent: "worker", task: "Direct-looking workflow args" };
      const mapped = host.mapToolCall(call);
      expect(mapped?.detail).toBeUndefined();
      expect(mapped?.subagents).toEqual([
        {
          type: "upsert",
          id: workflowId,
          title: "Workflow",
          status: "running",
          hasTimeline: false,
        },
      ]);
      expect(
        host.mapToolCall({ ...workflowLaunch("/missing/workflow"), status: "failed" }),
      ).toBeUndefined();
      expect(
        host.mapToolCall({ ...workflowLaunch("/missing/workflow"), status: "running" }),
      ).toBeUndefined();
      expect(
        host.mapToolCall({
          ...workflowLaunch("/missing/workflow"),
          result: { details: { mode: "workflow", runId: workflowRunId } },
        }),
      ).toBeUndefined();
      expect(
        host.mapToolCall({ ...workflowLaunch("/missing/workflow"), toolName: "codemode" }),
      ).toBeUndefined();
    } finally {
      host.close();
    }
  });

  test("replays captured notices without retained artifacts as flat completed runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-pi-workflow-retention-"));
    try {
      const artifacts = await seedWorkflowArtifacts(root);
      const fixture = await workflowFixture(artifacts);
      await rm(artifacts.dir, { recursive: true, force: true });
      const store = new ProviderSubagentStore();
      for await (const event of streamPiHistory("pi", fixture.messages))
        applySubagentEvent(store, event);
      const descriptors = store.list("parent");
      expect(
        descriptors
          .map(({ id, parentSubagentId, title, subtitle, status }) => ({
            id,
            parentSubagentId,
            title,
            subtitle,
            status,
          }))
          .toSorted((left, right) => left.id.localeCompare(right.id)),
      ).toEqual(
        [
          {
            id: workflowId,
            parentSubagentId: null,
            title: "Workflow",
            subtitle: "5 of 5 runs done",
            status: "completed",
          },
          ...workflowChildren.map(({ key }) => ({
            id: `${workflowId}/${key}`,
            parentSubagentId: workflowId,
            title: key,
            subtitle: null,
            status: "completed",
          })),
        ].toSorted((left, right) => left.id.localeCompare(right.id)),
      );
      for (const { id } of descriptors) expect(workflowTimeline(store, id)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["parallel", "chain"])(
    "preserves call-id descriptors for direct %s results",
    (mode) => {
      const host = createPiExtensionHost();
      try {
        const output = host.mapToolCall({
          callId: "direct-multi",
          toolName: "subagent",
          args: { agent: "worker", task: "Inspect" },
          status: "completed",
          result: {
            details: {
              mode,
              results: [
                { agent: "worker", exitCode: 0 },
                { agent: "reviewer", exitCode: 1 },
              ],
            },
          },
        });
        expect(output?.subagents).toEqual([
          {
            type: "upsert",
            id: "direct-multi:0",
            title: "worker",
            description: "Inspect",
            toolCallId: "direct-multi",
            status: "completed",
          },
          {
            type: "upsert",
            id: "direct-multi:1",
            title: "reviewer",
            description: "Inspect",
            toolCallId: "direct-multi",
            status: "failed",
          },
        ]);
      } finally {
        host.close();
      }
    },
  );
});

test("workflow launch rejects an artifact owned by a different nested call", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-pi-workflow-owner-"));
  const host = createPiExtensionHost();
  const store = new ProviderSubagentStore();
  host.follow((event) => applySubagentEvent(store, event));
  try {
    const artifacts = await seedWorkflowArtifacts(root);
    await applyHostOutput(
      store,
      host.mapToolCall({ ...workflowLaunch(artifacts.dir), callId: "foreign/1" }),
    );
    expect(store.list("parent")).toEqual([]);
  } finally {
    host.close();
    await rm(root, { recursive: true, force: true });
  }
});
