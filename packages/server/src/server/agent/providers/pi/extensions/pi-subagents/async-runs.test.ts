import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  isOwnerAlive,
  projectRun,
  readAsyncStatus,
  runState,
  stepStatus,
  type AsyncRun,
  type AsyncStatus,
  type AsyncStep,
} from "./async-runs.js";

function run(): AsyncRun {
  return {
    dir: "unused",
    owner: "call/1",
    toolCallId: "call",
    polling: true,
    emitted: new Map(),
  };
}
function status(state: AsyncStatus["state"] = "running", steps: AsyncStep[] = []): AsyncStatus {
  return { state, pid: process.pid, mode: "single", steps };
}

const states: AsyncStatus["state"][] = [
  "queued",
  "running",
  "paused",
  "complete",
  "failed",
  "partial",
  "stopped",
  "rejected",
];
const stepStatuses: AsyncStep["status"][] = [
  undefined,
  "pending",
  "queued",
  "running",
  "completed",
  "complete",
  "detached",
  "failed",
  "error",
  "rejected",
  "stopped",
  "paused",
];
const expectedByRun = {
  queued: "running",
  running: "running",
  paused: "canceled",
  complete: "completed",
  failed: "failed",
  partial: "failed",
  stopped: "canceled",
  rejected: "failed",
};
const finishedSteps: Partial<Record<NonNullable<AsyncStep["status"]>, string>> = {
  completed: "completed",
  complete: "completed",
  detached: "completed",
  failed: "failed",
  error: "failed",
  rejected: "failed",
  stopped: "canceled",
  paused: "canceled",
};

describe("async run lifecycle", () => {
  for (const state of states) {
    for (const step of stepStatuses) {
      test(`${state} run with ${step ?? "unspecified"} step`, () => {
        const finished = step === undefined ? undefined : finishedSteps[step];
        const expected = finished ?? expectedByRun[state];
        expect(stepStatus(runState(status(state)), state, { agent: "worker", status: step })).toBe(
          expected,
        );
      });
    }
  }

  test("re-registers unchanged child session files when paused rows resume", () => {
    const registered = run();
    const sessions = new Set<string>();
    const step: AsyncStep = {
      agent: "worker",
      status: "running",
      sessionFile: "child.jsonl",
    };
    const snapshot = status("running", [step]);
    const childSessions = [{ id: "call/1", file: "child.jsonl" }];
    expect(projectRun(registered, snapshot, sessions).childSessions).toEqual(childSessions);
    snapshot.state = "paused";
    expect(projectRun(registered, snapshot, sessions).childSessions).toEqual([]);
    expect(projectRun(registered, snapshot, sessions).childSessions).toEqual([]);
    snapshot.state = "running";
    step.label = "Resumed worker";
    const resumed = projectRun(registered, snapshot, sessions);
    expect(resumed.childSessions).toEqual(childSessions);
    expect(resumed.subagents).toMatchObject([
      { id: "call/1", description: "Resumed worker", status: "running" },
    ]);
    expect(projectRun(registered, snapshot, sessions)).toEqual({
      state: "active",
      subagents: [],
      childSessions: [],
    });
  });

  for (const state of ["complete", "failed", "partial", "stopped", "rejected"] as const) {
    test(`${state} settles the ordinary run and stops polling`, () => {
      const registered = run();
      const projected = projectRun(
        registered,
        status(state, [{ agent: "worker", status: "running" }]),
        new Set(),
      );
      expect(projected.subagents).toMatchObject([{ status: expectedByRun[state] }]);
      expect(projected.state).toBe("terminal");
      expect(registered.polling).toBe(false);
    });
  }

  test("a dead owner cancels active rows without a completion notice", async () => {
    const child = spawn(process.execPath, ["-e", ""]);
    await once(child, "exit");
    expect(typeof child.pid).toBe("number");
    expect(isOwnerAlive(child.pid)).toBe(false);
    const registered = run();
    const snapshot = {
      ...status("running", [{ agent: "worker", status: "pending" }]),
      pid: child.pid,
    };
    expect(projectRun(registered, snapshot, new Set()).subagents).toMatchObject([
      { status: "canceled" },
    ]);
    expect(registered.polling).toBe(false);
    expect(isOwnerAlive(process.pid)).toBe(true);
    expect(isOwnerAlive(undefined)).toBe(true);
  });

  test("settles the owner of a multi-step ordinary run", () => {
    const snapshot = {
      ...status("stopped", [
        { agent: "a", status: "completed" },
        { agent: "b", status: "running" },
      ]),
      mode: "chain",
    };
    expect(projectRun(run(), snapshot, new Set()).subagents).toMatchObject([
      { id: "call/1:0", status: "completed" },
      { id: "call/1:1", status: "canceled" },
      { id: "call/1", status: "canceled" },
    ]);
  });

  test("pauses and resumes the owner of an ordinary multi-step run", () => {
    const registered = run();
    const snapshot: AsyncStatus = {
      ...status("running", [
        { agent: "a", status: "completed" },
        { agent: "b", status: "running" },
      ]),
      mode: "chain",
    };
    projectRun(registered, snapshot, new Set());
    snapshot.state = "paused";
    expect(projectRun(registered, snapshot, new Set()).subagents).toMatchObject([
      { id: "call/1:1", status: "canceled" },
      { id: "call/1", status: "canceled" },
    ]);
    expect(registered.polling).toBe(true);
    expect(projectRun(registered, snapshot, new Set()).subagents).toEqual([]);
    snapshot.state = "running";
    expect(projectRun(registered, snapshot, new Set()).subagents).toMatchObject([
      { id: "call/1:1", status: "running" },
      { id: "call/1", status: "running" },
    ]);
  });

  test("preserves ordinary single step ids and settles empty runs", () => {
    const snapshot = {
      ...status("running", [{ agent: "worker", status: "running" }]),
      mode: "single",
    };
    const registered = run();
    expect(projectRun(registered, snapshot, new Set()).subagents).toMatchObject([
      { id: "call/1", title: "worker", status: "running" },
    ]);
    snapshot.state = "complete";
    expect(projectRun(registered, snapshot, new Set()).subagents).toMatchObject([
      { id: "call/1", title: "worker", status: "completed" },
    ]);
    expect(projectRun(run(), { state: "stopped", steps: [] }, new Set()).subagents).toMatchObject([
      { id: "call/1", status: "canceled" },
    ]);
  });
});

describe("async status files", () => {
  test("validates external files and skips missing, malformed and unknown states", () => {
    mkdirSync(".dev", { recursive: true });
    const dir = mkdtempSync(join(".dev", "pi-async-status-"));
    const file = join(dir, "status.json");
    try {
      expect(readAsyncStatus(dir)).toBeUndefined();
      writeFileSync(file, "{");
      expect(readAsyncStatus(dir)).toBeUndefined();
      for (const invalid of [
        { state: "unknown", steps: [] },
        { state: "running", steps: [{ agent: "" }] },
        { state: "running", pid: -1, steps: [] },
        { state: "running", steps: [{ agent: "worker", status: "unknown" }] },
      ]) {
        writeFileSync(file, JSON.stringify(invalid));
        expect(readAsyncStatus(dir)).toBeUndefined();
      }
      const snapshot = status("running", [{ agent: "worker" }]);
      writeFileSync(file, JSON.stringify({ ...snapshot, error: "extra external metadata" }));
      expect(readAsyncStatus(dir)).toEqual(snapshot);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
