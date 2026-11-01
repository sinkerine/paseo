import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderSubagentInputEvent,
  ProviderSubagentStatus,
} from "../../../../provider-subagents/store.js";
import { ProviderSubagentStore } from "../../../../provider-subagents/store.js";
import type { PiExtensionCustomMapping } from "../contract.js";
import {
  customMessageText,
  noticeStatus,
  parseWorkflowChildNotice,
  parseWorkflowTerminalNotice,
  type PiCustomMessage,
} from "./notice.js";
import {
  createPiWorkflowTracker,
  resolveWorkflowGroup,
  WorkflowLaunchDetails,
  workflowSubagentId,
  workflowRunSubagentId,
  workflowGroupSubagentId,
} from "./workflow.js";

const runId = "38e069c4-1f41-46b2-a21a-8f947abe29cd";
const rootId = workflowSubagentId(runId);
const childId = workflowRunSubagentId(runId, "T1-implement");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "paseo-workflow-"));
  roots.push(root);
  const asyncDir = join(root, runId);
  mkdirSync(asyncDir);
  const readSessions = new Set<string>();
  const tracker = createPiWorkflowTracker({ readSessions });
  function writeStatus(changes: Record<string, unknown> = {}) {
    writeFileSync(
      join(asyncDir, "status.json"),
      JSON.stringify({
        runId,
        mode: "workflow",
        state: "running",
        steps: [],
        ...changes,
      }),
    );
  }
  function launch() {
    return tracker.launch({ mode: "workflow", runId, asyncDir });
  }
  return { root, asyncDir, tracker, readSessions, writeStatus, launch };
}

function step(changes: Record<string, unknown> = {}) {
  return {
    workflowKey: "T1-implement",
    parentWorkflowRunId: runId,
    label: "Implement T1",
    agent: "worker",
    status: "running",
    ...changes,
  };
}

function incremental(
  content = `Workflow child completed: **T1-implement**
Workflow run: ${runId}
Child run: 3e0c2d2d-be37-4ec7-8d5d-25036e79e038
Output: /tmp/report.md
Status: workflow still running`,
): PiCustomMessage {
  return { role: "custom", customType: "subagent-incremental-child-notify", content };
}

function terminal(
  asyncDir: string,
  children = "T1-implement=3e0c2d2d-be37-4ec7-8d5d-25036e79e038 (completed)",
): PiCustomMessage {
  return {
    role: "custom",
    customType: "subagent-notify",
    content: `Background task completed: **workflow**
Workflow receipt: ${asyncDir}/workflow-receipt.json

Workflow completed with 1 child run(s).

Retention-managed async directory: ${asyncDir}
Workflow run: ${runId}
Child runs: ${children}`,
  };
}

function event(
  mapping: PiExtensionCustomMapping | undefined,
  id: string,
): ProviderSubagentInputEvent | undefined {
  return mapping?.subagents.find((item) => item.id === id);
}
function apply(store: ProviderSubagentStore, mapping: PiExtensionCustomMapping | undefined) {
  for (const item of mapping?.subagents ?? []) store.apply("parent", "pi", item);
}

// This suite exercises the tracker directly; index.ts integration belongs to S3.
describe("workflow notice parsers", () => {
  test("reads custom string and text blocks and ignores image-only messages", () => {
    expect(customMessageText(incremental("hello"))).toBe("hello");
    expect(
      customMessageText({
        role: "custom",
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      }),
    ).toBe("one\ntwo");
    expect(
      customMessageText({
        role: "custom",
        content: [{ type: "image", data: "", mimeType: "image/png" }],
      }),
    ).toBeUndefined();
  });
  test.each([
    ["Background tasks completed (2): scout, worker", "completed"],
    ["Background task completed: **workflow**", "completed"],
    ["Background task failed: **workflow**", "failed"],
    ["Detached foreground task stopped: **workflow**", "canceled"],
    ["Background task paused: **workflow**", undefined],
    ["unknown", undefined],
  ])("maps notice header %s", (header, expected) => {
    expect(noticeStatus(header)).toBe(expected);
  });
  test.each(["completed", "failed", "paused (needs attention)", "stopped"])(
    "parses child outcome %s",
    (outcome) => {
      expect(
        parseWorkflowChildNotice(
          `Workflow child ${outcome}: **T1-implement**\nWorkflow run: ${runId}`,
        ),
      ).toEqual({
        workflowRunId: runId,
        childKey: "T1-implement",
        outcome: outcome.startsWith("paused") ? "paused" : outcome,
      });
    },
  );
  test("parses terminal correlation and optional child status from the captured format", () => {
    expect(
      parseWorkflowTerminalNotice(
        customMessageText(
          terminal(`/tmp/${runId}`, "T1-implement=child-1 (completed), T2.review=child-2"),
        ) ?? "",
      ),
    ).toEqual({
      workflowRunId: runId,
      asyncDir: `/tmp/${runId}`,
      status: "completed",
      children: [
        { childKey: "T1-implement", childRunId: "child-1", status: "completed" },
        { childKey: "T2.review", childRunId: "child-2" },
      ],
    });
  });
  test("rejects incomplete, malformed and uncorrelated notices", () => {
    for (const text of [
      "",
      "Workflow child completed: **key**",
      `Workflow child unknown: **key**\nWorkflow run: ${runId}`,
    ]) {
      expect(parseWorkflowChildNotice(text)).toBeUndefined();
    }
    for (const text of [
      "",
      `Background task completed: **workflow**\nWorkflow run: ${runId}`,
      customMessageText(terminal("/tmp/other")) ?? "",
      customMessageText(terminal(`/tmp/${runId}`, "broken")) ?? "",
    ]) {
      expect(parseWorkflowTerminalNotice(text)).toBeUndefined();
    }
  });
});

describe("Pi workflow tracker", () => {
  test("validates launch details and emits only a running Workflow on repeated launch", () => {
    const fixture = setup();
    expect(
      WorkflowLaunchDetails.safeParse({ mode: "workflow", runId: " ", asyncDir: "/tmp" }).success,
    ).toBe(false);
    const expected = {
      subagents: [
        { type: "upsert", id: rootId, title: "Workflow", status: "running", hasTimeline: false },
      ],
    };
    expect(fixture.launch()).toEqual(expected);
    fixture.writeStatus({ steps: [step()] });
    fixture.tracker.poll();
    expect(fixture.launch()).toEqual(expected);
  });
  test("grows runs by key, keeps reruns distinct, and deduplicates shared transcripts", () => {
    const fixture = setup();
    fixture.launch();
    const sessionFile = join(fixture.root, "session.jsonl");
    writeFileSync(sessionFile, "malformed transcript is handled by the host");
    fixture.writeStatus({ steps: [step({ sessionFile })] });
    const first = fixture.tracker.poll();
    expect(first?.childSessions).toEqual([{ id: childId, file: sessionFile }]);
    expect(event(first, childId)).toEqual({
      type: "upsert",
      id: childId,
      title: "Implement T1",
      subtitle: "worker",
      parentSubagentId: rootId,
      status: "running",
    });
    fixture.writeStatus({
      steps: [
        step({ status: "completed", sessionFile }),
        step({ workflowKey: "T1-review-1", label: "Review T1", status: "queued", sessionFile }),
      ],
    });
    const store = new ProviderSubagentStore();
    apply(store, first);
    apply(store, fixture.tracker.poll());
    const repeated = fixture.tracker.poll();
    apply(store, repeated);
    expect(repeated?.childSessions).toEqual([]);
    expect(store.list("parent").map((row) => row.id)).toEqual([
      rootId,
      childId,
      workflowRunSubagentId(runId, "T1-review-1"),
    ]);
    expect(fixture.readSessions).toEqual(new Set([sessionFile]));
    expect(event(repeated, rootId)).toMatchObject({ subtitle: "1 of 2 runs done" });
    const shared = createPiWorkflowTracker({ readSessions: fixture.readSessions });
    shared.launch({ runId, mode: "workflow", asyncDir: fixture.asyncDir });
    expect(shared.poll()?.childSessions).toEqual([]);
  });
  test("resolves lane before phase without inferring groups from keys", () => {
    const status = {
      runId,
      mode: "workflow",
      state: "running",
      steps: [],
      workflowGraph: { phases: [{ title: "Lane", nodeIds: ["T1-implement"] }], nodes: [] },
    };
    expect(resolveWorkflowGroup(status, { workflowKey: "T1-implement", phase: "Phase" })).toBe(
      "Lane",
    );
    expect(resolveWorkflowGroup(status, { workflowKey: "T1-review-1", phase: "Phase" })).toBe(
      "Phase",
    );
    expect(resolveWorkflowGroup(status, { workflowKey: "T1-review-1" })).toBeUndefined();
  });
  test("reparents a run, removes its empty group and preserves creation order for group subtitle", () => {
    const fixture = setup();
    fixture.launch();
    fixture.writeStatus({ steps: [step({ phase: "Old" })] });
    expect(event(fixture.tracker.poll(), childId)).toMatchObject({
      parentSubagentId: workflowGroupSubagentId(runId, "Old"),
    });
    fixture.writeStatus({
      steps: [
        step({ phase: "New" }),
        step({ workflowKey: "review", label: "Review T1", phase: "New" }),
      ],
    });
    const mapping = fixture.tracker.poll();
    expect(event(mapping, workflowGroupSubagentId(runId, "Old"))).toEqual({
      type: "remove",
      id: workflowGroupSubagentId(runId, "Old"),
    });
    expect(event(mapping, childId)).toMatchObject({
      parentSubagentId: workflowGroupSubagentId(runId, "New"),
    });
    expect(event(mapping, workflowGroupSubagentId(runId, "New"))).toMatchObject({
      subtitle: "Review T1",
    });
    fixture.writeStatus({
      steps: [
        step({ workflowKey: "review", label: "Review T1", phase: "New" }),
        step({ phase: "New" }),
      ],
    });
    expect(event(fixture.tracker.poll(), workflowGroupSubagentId(runId, "New"))).toMatchObject({
      subtitle: "Review T1",
    });
    fixture.writeStatus({ steps: [step({ workflowKey: "review" }), step()] });
    const ungrouped = fixture.tracker.poll();
    expect(event(ungrouped, workflowGroupSubagentId(runId, "New"))).toEqual({
      type: "remove",
      id: workflowGroupSubagentId(runId, "New"),
    });
    expect(event(ungrouped, childId)).toMatchObject({ parentSubagentId: rootId });
  });

  test.each([
    { name: "creation timestamps", startedA: 1, startedB: 2, expected: "B" },
    { name: "timestamps before artifact order", startedA: 2, startedB: 1, expected: "A" },
    { name: "absent timestamps", startedA: undefined, startedB: undefined, expected: "B" },
    { name: "equal timestamps", startedA: 1, startedB: 1, expected: "B" },
    { name: "zero timestamps", startedA: 0, startedB: 0, expected: "B" },
    { name: "one absent timestamp", startedA: 1, startedB: undefined, expected: "A" },
  ])(
    "matches live and reverse-completion replay group subtitles using $name",
    ({ startedA, startedB, expected }) => {
      const fixture = setup();
      const liveStore = new ProviderSubagentStore();
      const replayStore = new ProviderSubagentStore();
      const replay = createPiWorkflowTracker({ readSessions: new Set() });
      const steps = [
        step({ workflowKey: "A", label: "A", phase: "T1", startedAt: startedA }),
        step({ workflowKey: "B", label: "B", phase: "T1", startedAt: startedB }),
      ];
      apply(liveStore, fixture.launch());
      fixture.writeStatus({ steps });
      apply(liveStore, fixture.tracker.poll());
      const groupId = workflowGroupSubagentId(runId, "T1");
      expect(liveStore.get("parent", groupId)?.subtitle).toBe(expected);
      for (const key of ["B", "A"]) {
        const notice = incremental(`Workflow child completed: **${key}**\nWorkflow run: ${runId}`);
        apply(liveStore, fixture.tracker.mapNotice(notice));
        apply(replayStore, replay.mapNotice(notice));
      }
      fixture.writeStatus({
        state: "complete",
        steps: steps.map((child) => Object.assign(child, { status: "completed" })),
      });
      const notice = terminal(fixture.asyncDir, "B=child-b (completed), A=child-a (completed)");
      apply(liveStore, fixture.tracker.mapNotice(notice));
      apply(replayStore, replay.mapNotice(notice));
      expect(liveStore.get("parent", groupId)?.subtitle).toBe(expected);
      expect(replayStore.get("parent", groupId)?.subtitle).toBe(expected);
      const liveRows = liveStore
        .list("parent")
        .map(({ createdAt: _createdAt, updatedAt: _updatedAt, ...row }) => row);
      const replayRows = replayStore
        .list("parent")
        .map(({ createdAt: _createdAt, updatedAt: _updatedAt, ...row }) => row);
      liveRows.sort((left, right) => left.id.localeCompare(right.id));
      replayRows.sort((left, right) => left.id.localeCompare(right.id));
      expect(replayRows).toEqual(liveRows);
      expect(liveRows).toHaveLength(4);
    },
  );

  test.each<[string, ProviderSubagentStatus | undefined]>([
    ["queued", "running"],
    ["running", "running"],
    ["complete", "completed"],
    ["failed", "failed"],
    ["partial", "failed"],
    ["rejected", "failed"],
    ["stopped", "canceled"],
    ["paused", undefined],
    ["unknown", undefined],
  ])("maps workflow state %s and polls only nonterminal states", (state, expected) => {
    const fixture = setup();
    fixture.launch();
    fixture.writeStatus({ state });
    const root = event(fixture.tracker.poll(), rootId);
    expect(root).toMatchObject({ type: "upsert", id: rootId });
    expect(root && "status" in root ? root.status : undefined).toBe(expected);
    fixture.writeStatus({ state: "running" });
    const terminalState = expected !== undefined && expected !== "running";
    expect(fixture.tracker.poll() === undefined).toBe(terminalState);
  });
  test.each<[string, ProviderSubagentStatus | undefined]>([
    ["pending", "running"],
    ["queued", "running"],
    ["running", "running"],
    ["completed", "completed"],
    ["complete", "completed"],
    ["failed", "failed"],
    ["error", "failed"],
    ["stopped", "canceled"],
    ["paused", undefined],
    ["unknown", undefined],
  ])("maps step and terminal child status %s", (status, expected) => {
    const fixture = setup();
    fixture.launch();
    fixture.writeStatus({ steps: [step({ status })] });
    const polled = event(fixture.tracker.poll(), childId);
    expect(polled && "status" in polled ? polled.status : undefined).toBe(expected);
    const fresh = createPiWorkflowTracker({ readSessions: new Set() });
    const mapped = event(
      fresh.mapNotice(terminal(`/missing/${runId}`, `T1-implement=child (${status})`)),
      childId,
    );
    expect(mapped && "status" in mapped ? mapped.status : undefined).toBe(expected);
  });
  test.each<[string[], ProviderSubagentStatus]>([
    [["completed", "running", "failed"], "running"],
    [["completed", "failed", "stopped"], "failed"],
    [["completed", "stopped"], "canceled"],
    [["completed", "complete"], "completed"],
  ])("derives group status from %j", (statuses, expected) => {
    const fixture = setup();
    fixture.launch();
    fixture.writeStatus({
      steps: statuses.map((status, index) =>
        step({ workflowKey: `run-${index}`, status, phase: "T1" }),
      ),
    });
    const mapping = fixture.tracker.poll();
    expect(event(mapping, workflowGroupSubagentId(runId, "T1"))).toMatchObject({
      status: expected,
    });
    expect(event(mapping, rootId)).toMatchObject({
      subtitle: `${expected === "running" ? 0 : 1} of 1 groups done`,
    });
  });
  test("keeps a lane running while graph stages are pending or running", () => {
    const fixture = setup();
    fixture.launch();
    for (const status of ["pending", "running", "completed"]) {
      fixture.writeStatus({
        steps: [step({ status: "completed" })],
        workflowGraph: {
          phases: [{ title: "T1", nodeIds: ["T1-implement", "review"] }],
          nodes: [
            { id: "T1-implement", status: "completed" },
            { id: "review", status },
          ],
        },
      });
      const expected = status === "completed" ? "completed" : "running";
      expect(event(fixture.tracker.poll(), workflowGroupSubagentId(runId, "T1"))).toMatchObject({
        status: expected,
      });
    }
  });
  test("ignores foreign steps and host steps including their transcripts", () => {
    const fixture = setup();
    fixture.launch();
    fixture.writeStatus({
      steps: [
        step({ parentWorkflowRunId: "foreign", sessionFile: "/decoy" }),
        { status: "running", sessionFile: "/host" },
        step({
          workflowKey: "no-parent",
          parentWorkflowRunId: undefined,
          sessionFile: "/missing-parent",
        }),
      ],
    });
    expect(fixture.tracker.poll()).toEqual({
      subagents: [
        {
          type: "upsert",
          id: rootId,
          title: "Workflow",
          hasTimeline: false,
          status: "running",
          subtitle: "0 of 0 runs done",
        },
      ],
      childSessions: [],
    });
    expect(fixture.readSessions.size).toBe(0);
  });
  test("ignores missing, malformed, mismatched run and mismatched mode status files", () => {
    const fixture = setup();
    fixture.launch();
    expect(fixture.tracker.poll()).toBeUndefined();
    writeFileSync(join(fixture.asyncDir, "status.json"), "{");
    expect(fixture.tracker.poll()).toBeUndefined();
    for (const changes of [
      { runId: "foreign" },
      { mode: "single" },
      { steps: "broken" },
      { steps: [step({ startedAt: "invalid" })] },
      { steps: [step({ startedAt: -1 })] },
      { workflowGraph: { phases: [] } },
    ]) {
      fixture.writeStatus(changes);
      expect(fixture.tracker.poll()).toBeUndefined();
    }
  });
  test.each<[string, ProviderSubagentStatus | undefined]>([
    ["completed", "completed"],
    ["failed", "failed"],
    ["stopped", "canceled"],
    ["paused (needs attention)", undefined],
  ])("maps incremental %s on replay without assigning workflow status", (outcome, expected) => {
    const tracker = createPiWorkflowTracker({ readSessions: new Set() });
    const mapping = tracker.mapNotice(
      incremental(
        `Workflow child ${outcome}: **T1-implement**\nWorkflow run: ${runId}\nOutput: /tmp/output.md\nStatus: workflow still running`,
      ),
    );
    const root = event(mapping, rootId);
    expect(root).not.toHaveProperty("status");
    expect(event(mapping, childId)).toMatchObject({
      parentSubagentId: rootId,
      title: "T1-implement",
    });
    const child = event(mapping, childId);
    expect(child && "status" in child ? child.status : undefined).toBe(expected);
    expect(mapping?.childSessions).toEqual([]);
    expect(tracker.poll()).toBeUndefined();
  });
  test("output paths and workflow terminal state never infer child lifecycle", () => {
    const fixture = setup();
    fixture.launch();
    writeFileSync(join(fixture.root, "report.md"), "done");
    fixture.writeStatus({
      state: "complete",
      steps: [
        step({ status: undefined, output: join(fixture.root, "report.md") }),
        step({ workflowKey: "other", status: "running" }),
      ],
    });
    const mapping = fixture.tracker.poll();
    expect(event(mapping, childId)).not.toHaveProperty("status");
    expect(event(mapping, workflowRunSubagentId(runId, "other"))).toMatchObject({
      status: "running",
    });
  });
  test("terminal notice settles statuses, reparents matching steps and deduplicates sessions", () => {
    const fixture = setup();
    const sessionFile = join(fixture.root, "session.jsonl");
    fixture.tracker.mapNotice(incremental());
    fixture.writeStatus({ state: "running", steps: [step({ phase: "T1", sessionFile })] });
    const mapping = fixture.tracker.mapNotice(terminal(fixture.asyncDir));
    expect(event(mapping, rootId)).toMatchObject({ status: "completed" });
    expect(event(mapping, childId)).toMatchObject({
      status: "completed",
      parentSubagentId: workflowGroupSubagentId(runId, "T1"),
      subtitle: "worker",
    });
    expect(event(mapping, workflowGroupSubagentId(runId, "T1"))).toMatchObject({
      status: "completed",
    });
    expect(mapping?.childSessions).toEqual([{ id: childId, file: sessionFile }]);
    expect(fixture.tracker.mapNotice(terminal(fixture.asyncDir))?.childSessions).toEqual([]);
    expect(fixture.tracker.poll()).toBeUndefined();
  });
  test.each(["", " (paused)", " (unknown)"])(
    "terminal child entry %j preserves explicit status from its matching step",
    (suffix) => {
      const fixture = setup();
      fixture.writeStatus({ state: "complete", steps: [step({ status: "completed" })] });
      const mapping = fixture.tracker.mapNotice(
        terminal(fixture.asyncDir, `T1-implement=child${suffix}`),
      );
      expect(event(mapping, childId)).toEqual({
        type: "upsert",
        id: childId,
        title: "Implement T1",
        subtitle: "worker",
        parentSubagentId: rootId,
        status: "completed",
      });
      const store = new ProviderSubagentStore();
      apply(store, mapping);
      expect(store.list("parent").find((row) => row.id === childId)?.status).toBe("completed");
    },
  );
  test("a missing terminal directory still settles without groups or sessions", () => {
    const fixture = setup();
    const mapping = fixture.tracker.mapNotice(terminal(join(fixture.root, "missing", runId)));
    expect(event(mapping, rootId)).toMatchObject({ status: "completed" });
    expect(event(mapping, childId)).toMatchObject({
      status: "completed",
      parentSubagentId: rootId,
    });
    expect(mapping?.subagents.length).toBe(2);
    expect(mapping?.childSessions).toEqual([]);
  });
  test("ignores invalid or unrelated custom messages without creating state", () => {
    const fixture = setup();
    for (const message of [
      incremental("broken"),
      terminal("/tmp/foreign"),
      { role: "custom", customType: "other", content: "anything" } satisfies PiCustomMessage,
    ]) {
      expect(fixture.tracker.mapNotice(message)).toBeUndefined();
    }
    expect(fixture.tracker.poll()).toBeUndefined();
  });
});

describe("workflow timeline capability", () => {
  test("marks synthetic roots and groups without changing run timelines live and on replay", () => {
    const fixture = setup();
    expect(event(fixture.launch(), rootId)).toMatchObject({ hasTimeline: false });
    fixture.writeStatus({ state: "complete", steps: [step({ phase: "T1", status: "completed" })] });
    const live = fixture.tracker.poll();
    const replay = createPiWorkflowTracker({ readSessions: new Set() }).mapNotice(
      terminal(fixture.asyncDir),
    );
    for (const mapping of [live, replay]) {
      expect(event(mapping, rootId)).toMatchObject({ hasTimeline: false });
      expect(event(mapping, workflowGroupSubagentId(runId, "T1"))).toMatchObject({
        hasTimeline: false,
      });
      expect(event(mapping, childId)).not.toHaveProperty("hasTimeline");
    }
  });
});

describe("workflow mission recovery", () => {
  test.each([
    null,
    {},
    { runs: "broken" },
    { runs: [null, {}, { mode: "single", runId, asyncDir: `/tmp/${runId}` }] },
    { runs: [{ mode: "workflow", runId }] },
    { runs: [{ mode: "workflow", runId: " ", asyncDir: "/tmp/other" }] },
    { runs: [{ mode: "workflow", runId, asyncDir: "/tmp/other" }] },
  ])("ignores malformed mission evidence %j", (mission) => {
    const fixture = setup();
    fixture.tracker.mapNotice(incremental());
    expect(fixture.tracker.recoverMission(mission)).toBeUndefined();
    expect(fixture.tracker.poll()).toBeUndefined();
    expect(fixture.readSessions.size).toBe(0);
  });

  test.each([{ runId: "foreign" }, { mode: "single" }, { steps: "broken" }])(
    "rejects mission artifacts with %j without registering their handle",
    (changes) => {
      const fixture = setup();
      fixture.tracker.mapNotice(incremental());
      fixture.writeStatus({ state: "stopped", ...changes });
      const mission = { runs: [{ mode: "workflow", runId, asyncDir: fixture.asyncDir }] };
      expect(fixture.tracker.recoverMission(mission)).toBeUndefined();
      expect(fixture.tracker.poll()).toBeUndefined();
      fixture.writeStatus({
        state: "stopped",
        steps: [step({ status: "stopped", sessionFile: "/child" })],
      });
      const recovered = fixture.tracker.recoverMission(mission);
      expect(event(recovered, rootId)).toMatchObject({ status: "canceled" });
      expect(recovered?.childSessions).toEqual([{ id: childId, file: "/child" }]);
      expect(fixture.tracker.recoverMission(mission)).toBeUndefined();
    },
  );

  test("ignores unknown workflows, known handles and settled workflows", () => {
    const fixture = setup();
    fixture.writeStatus({ state: "running", pid: process.pid, steps: [step()] });
    const mission = {
      runs: [{ mode: "workflow", runId, asyncDir: fixture.asyncDir, status: "stopped" }],
    };
    expect(fixture.tracker.recoverMission(mission)).toBeUndefined();
    fixture.launch();
    expect(fixture.tracker.recoverMission(mission)).toBeUndefined();
    const replay = createPiWorkflowTracker({ readSessions: new Set() });
    replay.mapNotice(terminal(join(fixture.root, "missing", runId)));
    expect(replay.recoverMission(mission)).toBeUndefined();
    expect(replay.poll()).toBeUndefined();
  });

  test("uses artifact lifecycle rather than mission status and polls recovered active workflows", () => {
    const fixture = setup();
    fixture.tracker.mapNotice(incremental());
    fixture.writeStatus({ state: "running", pid: process.pid, steps: [step()] });
    const mission = {
      runs: [{ mode: "workflow", runId, asyncDir: fixture.asyncDir, status: "stopped" }],
    };
    expect(event(fixture.tracker.recoverMission(mission), rootId)).toMatchObject({
      status: "running",
    });
    fixture.writeStatus({ state: "stopped", steps: [step({ status: "stopped" })] });
    expect(event(fixture.tracker.poll(), rootId)).toMatchObject({ status: "canceled" });
    expect(fixture.tracker.recoverMission(mission)).toBeUndefined();
    expect(fixture.tracker.poll()).toBeUndefined();
  });
});

describe("workflow owner liveness", () => {
  async function deadPid() {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const child = spawn(process.execPath, ["-e", ""]);
    await once(child, "exit");
    return child.pid;
  }

  test.each(["running", "paused", "complete"])(
    "dead owner settles unfinished children in %s artifacts",
    async (state) => {
      const fixture = setup();
      const pid = await deadPid();
      fixture.writeStatus({
        state,
        pid,
        steps: [
          step(),
          step({ workflowKey: "done", status: "completed" }),
          step({ workflowKey: "failed", status: "failed" }),
        ],
      });
      const mapped = fixture.launch();
      expect(event(mapped, rootId)).toMatchObject({ status: "canceled" });
      expect(event(mapped, childId)).toMatchObject({ status: "canceled" });
      expect(event(mapped, workflowRunSubagentId(runId, "done"))).toMatchObject({
        status: "completed",
      });
      expect(event(mapped, workflowRunSubagentId(runId, "failed"))).toMatchObject({
        status: "failed",
      });
      expect(fixture.tracker.poll()).toBeUndefined();
    },
  );

  test("dead-owner terminal replay cancels notice entries that still say running", async () => {
    const fixture = setup();
    fixture.writeStatus({ state: "complete", pid: await deadPid(), steps: [step()] });
    const mapped = fixture.tracker.mapNotice(
      terminal(fixture.asyncDir, "T1-implement=child (running)"),
    );
    expect(event(mapped, rootId)).toMatchObject({ status: "canceled" });
    expect(event(mapped, childId)).toMatchObject({ status: "canceled" });
    expect(fixture.tracker.poll()).toBeUndefined();
  });

  test("a stale terminal running snapshot preserves an earlier final incremental notice", () => {
    const fixture = setup();
    fixture.tracker.mapNotice(incremental());
    fixture.writeStatus({ state: "complete", pid: process.pid, steps: [step()] });
    const mapped = fixture.tracker.mapNotice(
      terminal(fixture.asyncDir, "T1-implement=child (running)"),
    );
    expect(event(mapped, childId)).toMatchObject({ status: "completed" });
    expect(fixture.tracker.poll()).toBeUndefined();
  });

  test("explicit terminal child completion precedes dead-owner cleanup", async () => {
    const fixture = setup();
    fixture.writeStatus({ state: "complete", pid: await deadPid(), steps: [step()] });
    const mapped = fixture.tracker.mapNotice(terminal(fixture.asyncDir));
    expect(event(mapped, rootId)).toMatchObject({ status: "completed" });
    expect(event(mapped, childId)).toMatchObject({ status: "completed" });
    expect(fixture.tracker.poll()).toBeUndefined();
  });

  test("closed dispatch keeps children live until a notice settles them", () => {
    const fixture = setup();
    fixture.writeStatus({ state: "complete", pid: process.pid, steps: [step()] });
    const mapped = fixture.launch();
    expect(event(mapped, rootId)).toMatchObject({ status: "completed" });
    expect(event(mapped, childId)).toMatchObject({ status: "running" });
    expect(event(fixture.tracker.mapNotice(incremental()), childId)).toMatchObject({
      status: "completed",
    });
    expect(event(fixture.tracker.poll(), childId)).toMatchObject({ status: "completed" });
    expect(fixture.tracker.poll()).toBeUndefined();
  });

  test("closed dispatch keeps checking owner liveness without inferring child completion", async () => {
    const fixture = setup();
    fixture.writeStatus({ state: "complete", pid: process.pid, steps: [step()] });
    fixture.launch();
    expect(event(fixture.tracker.poll(), childId)).toMatchObject({ status: "running" });
    fixture.writeStatus({ state: "complete", pid: await deadPid(), steps: [step()] });
    const mapped = fixture.tracker.poll();
    expect(event(mapped, rootId)).toMatchObject({ status: "canceled" });
    expect(event(mapped, childId)).toMatchObject({ status: "canceled" });
    expect(fixture.tracker.poll()).toBeUndefined();
  });

  test("rejects a launch whose artifact belongs to another tool call", () => {
    const fixture = setup();
    fixture.writeStatus({ toolCallId: "other", steps: [step({ sessionFile: "/decoy" })] });
    expect(
      fixture.tracker.launch({ mode: "workflow", runId, asyncDir: fixture.asyncDir }, "mine"),
    ).toEqual({ subagents: [{ type: "remove", id: "mine" }] });
    expect(fixture.tracker.poll()).toBeUndefined();
    expect(fixture.readSessions.size).toBe(0);
  });
});
