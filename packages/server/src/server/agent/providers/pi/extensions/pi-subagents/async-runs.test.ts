import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  isOwnerAlive,
  projectRun,
  readAsyncStatus,
  resolveAsyncDir,
  runState,
  stepStatus,
  type AsyncRun,
  type AsyncStatus,
  type AsyncStep,
} from "./async-runs.js";

function run(workflow = true): AsyncRun {
  return {
    dir: "unused",
    owner: "call/1",
    toolCallId: "call",
    workflow,
    polling: true,
    emitted: new Map(),
  };
}
function status(state: AsyncStatus["state"] = "running", steps: AsyncStep[] = []): AsyncStatus {
  return { state, pid: process.pid, mode: "workflow", steps };
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

  test("keeps workflow ids stable as steps grow and suppresses unchanged rows", () => {
    const registered = run();
    const sessions = new Set<string>();
    const first: AsyncStep = { agent: "worker", workflowKey: "first", status: "running" };
    expect(projectRun(registered, status("running", [first]), sessions).subagents).toEqual([
      { type: "upsert", id: "call/1", toolCallId: "call", title: "workflow", status: "running" },
      {
        type: "upsert",
        id: "call/1:first",
        toolCallId: "call",
        title: "worker",
        description: undefined,
        parentSubagentId: "call/1",
        status: "running",
      },
    ]);
    expect(projectRun(registered, status("running", [first]), sessions).subagents).toEqual([]);
    first.status = "completed";
    const second: AsyncStep = { agent: "worker", workflowKey: "second", status: "running" };
    const grown = projectRun(registered, status("running", [first, second]), sessions);
    expect(grown.subagents.map((row) => row.id)).toEqual(["call/1:first", "call/1:second"]);
    expect(grown.subagents).toMatchObject([{ status: "completed" }, { status: "running" }]);
    second.sessionFile = "child.jsonl";
    expect(projectRun(registered, status("running", [first, second]), sessions)).toEqual({
      subagents: [],
      childSessions: [{ id: "call/1:second", file: "child.jsonl" }],
      state: "active",
    });
    expect(
      projectRun(registered, status("running", [first, second]), sessions).childSessions,
    ).toEqual([]);
    second.agent = "reviewer";
    second.label = "Review";
    expect(
      projectRun(registered, status("running", [first, second]), sessions).subagents,
    ).toMatchObject([{ id: "call/1:second", title: "reviewer", description: "Review" }]);
  });

  test("paused workflows keep polling and resume", () => {
    const registered = run();
    const steps: AsyncStep[] = [{ agent: "worker", status: "running" }];
    const paused = projectRun(registered, status("paused", steps), new Set());
    expect(paused.state).toBe("paused");
    expect(paused.subagents).toMatchObject([{ status: "canceled" }, { status: "canceled" }]);
    expect(registered.polling).toBe(true);
    expect(projectRun(registered, status("running", steps), new Set()).subagents).toMatchObject([
      { status: "running" },
      { status: "running" },
    ]);
  });

  test("re-registers unchanged child session files when paused rows resume", () => {
    const registered = run();
    const sessions = new Set<string>();
    const step: AsyncStep = {
      agent: "worker",
      workflowKey: "first",
      status: "running",
      sessionFile: "child.jsonl",
    };
    const snapshot = status("running", [step]);
    const childSessions = [{ id: "call/1:first", file: "child.jsonl" }];
    expect(projectRun(registered, snapshot, sessions).childSessions).toEqual(childSessions);
    snapshot.state = "paused";
    expect(projectRun(registered, snapshot, sessions).childSessions).toEqual([]);
    expect(projectRun(registered, snapshot, sessions).childSessions).toEqual([]);
    snapshot.state = "running";
    step.label = "Resumed worker";
    const resumed = projectRun(registered, snapshot, sessions);
    expect(resumed.childSessions).toEqual(childSessions);
    expect(resumed.subagents).toMatchObject([
      { id: "call/1", status: "running" },
      { id: "call/1:first", description: "Resumed worker", status: "running" },
    ]);
    expect(projectRun(registered, snapshot, sessions)).toEqual({
      state: "active",
      subagents: [],
      childSessions: [],
    });
  });

  for (const state of ["complete", "failed", "partial", "stopped", "rejected"] as const) {
    test(`${state} settles the workflow and stops polling`, () => {
      const registered = run();
      const projected = projectRun(
        registered,
        status(state, [{ agent: "worker", status: "running" }]),
        new Set(),
      );
      expect(projected.subagents).toMatchObject([
        { status: expectedByRun[state] },
        { status: expectedByRun[state] },
      ]);
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
    expect(projectRun(run(false), snapshot, new Set()).subagents).toMatchObject([
      { id: "call/1:0", status: "completed" },
      { id: "call/1:1", status: "canceled" },
      { id: "call/1", status: "canceled" },
    ]);
  });

  test("pauses and resumes the owner of an ordinary multi-step run", () => {
    const registered = run(false);
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
    const registered = run(false);
    expect(projectRun(registered, snapshot, new Set()).subagents).toMatchObject([
      { id: "call/1", title: "worker", status: "running" },
    ]);
    snapshot.state = "complete";
    expect(projectRun(registered, snapshot, new Set()).subagents).toMatchObject([
      { id: "call/1", title: "worker", status: "completed" },
    ]);
    expect(
      projectRun(run(false), { state: "stopped", steps: [] }, new Set()).subagents,
    ).toMatchObject([{ id: "call/1", status: "canceled" }]);
  });

  test("replays the stopped 38e069c4 workflow shape without running rows", () => {
    const steps: AsyncStep[] = Array.from({ length: 17 }, (_, index) => ({
      agent: "worker",
      workflowKey: `step-${index}`,
      status: "completed",
    }));
    steps.push({ agent: "worker", workflowKey: "step-17", status: "stopped" });
    const projected = projectRun(run(), status("stopped", steps), new Set());
    expect(projected.subagents).toHaveLength(19);
    expect(projected.subagents).toMatchObject([
      { id: "call/1", status: "canceled" },
      ...steps
        .slice(0, 17)
        .map((step) => ({ id: `call/1:${step.workflowKey}`, status: "completed" })),
      { id: "call/1:step-17", status: "canceled" },
    ]);
  });

  test("falls back from workflow keys to run ids and indexes", () => {
    expect(
      projectRun(
        run(),
        status("running", [{ agent: "a", runId: "child" }, { agent: "b" }]),
        new Set(),
      ).subagents.map((row) => row.id),
    ).toEqual(["call/1", "call/1:child", "call/1:1"]);
  });
});

const uidIdentity = {
  getuid: () => 42,
  userInfo: () => ({ username: "os-user" }),
  homedir: () => "os-home",
};
const noUidIdentity = {
  getuid: undefined,
  userInfo: () => ({ username: null }),
  homedir: () => "",
};
function unavailableIdentity(): never {
  throw new Error("OS identity unavailable");
}

describe("async status files", () => {
  test("uses bridge directories before configured and default roots", () => {
    expect(
      resolveAsyncDir("run", new Map([["run", "bridge"]]), {
        PI_SUBAGENTS_TEMP_ROOT: "configured",
      }),
    ).toBe("bridge");
    expect(resolveAsyncDir("run", new Map(), { PI_SUBAGENTS_TEMP_ROOT: "configured" })).toBe(
      resolve("configured", "async-subagent-runs", "run"),
    );
    expect(resolveAsyncDir("run", new Map(), {}, uidIdentity)).toBe(
      join(tmpdir(), "pi-subagents-uid-42", "async-subagent-runs", "run"),
    );
  });

  test("matches Pi's trimmed, absolute temp-root resolution", () => {
    const defaultDir = join(tmpdir(), "pi-subagents-uid-42", "async-subagent-runs", "run");
    expect(resolveAsyncDir("run", new Map(), { PI_SUBAGENTS_TEMP_ROOT: "" }, uidIdentity)).toBe(
      defaultDir,
    );
    expect(
      resolveAsyncDir("run", new Map(), { PI_SUBAGENTS_TEMP_ROOT: "  \t " }, uidIdentity),
    ).toBe(defaultDir);
    expect(
      resolveAsyncDir("run", new Map(), { PI_SUBAGENTS_TEMP_ROOT: "  .dev/pi-async-root  " }),
    ).toBe(resolve(".dev/pi-async-root", "async-subagent-runs", "run"));
    expect(resolveAsyncDir("run", new Map(), { PI_SUBAGENTS_TEMP_ROOT: `  ${tmpdir()}  ` })).toBe(
      join(tmpdir(), "async-subagent-runs", "run"),
    );
  });

  test.each([
    {
      name: "UID precedes usernames and preserves zero",
      env: { USERNAME: "windows-user", USER: "unix-user", LOGNAME: "login-user" },
      identity: { ...uidIdentity, getuid: () => 0 },
      scope: "uid-0",
    },
    {
      name: "USERNAME precedes USER and LOGNAME",
      env: { USERNAME: "windows-user", USER: "unix-user", LOGNAME: "login-user" },
      identity: noUidIdentity,
      scope: "user-windows-user",
    },
    {
      name: "USER precedes LOGNAME",
      env: { USERNAME: "", USER: "unix-user", LOGNAME: "login-user" },
      identity: noUidIdentity,
      scope: "user-unix-user",
    },
    {
      name: "LOGNAME precedes OS username",
      env: { LOGNAME: "login-user" },
      identity: { ...noUidIdentity, userInfo: () => ({ username: "os-user" }) },
      scope: "user-login-user",
    },
    {
      name: "OS username precedes home environment",
      env: { USERPROFILE: "profile-home", HOME: "env-home" },
      identity: { ...noUidIdentity, userInfo: () => ({ username: "os-user" }) },
      scope: "user-os-user",
    },
    {
      name: "USERPROFILE precedes HOME after OS username failure",
      env: { USERPROFILE: "C:\\Users\\Example User", HOME: "env-home" },
      identity: { ...noUidIdentity, userInfo: unavailableIdentity },
      scope: "home-C-Users-Example-User",
    },
    {
      name: "HOME precedes OS home",
      env: { HOME: "/home/example" },
      identity: { ...noUidIdentity, homedir: () => "os-home" },
      scope: "home-home-example",
    },
    {
      name: "empty USERPROFILE uses OS home rather than HOME",
      env: { USERPROFILE: "", HOME: "env-home" },
      identity: { ...noUidIdentity, homedir: () => "/os/home" },
      scope: "home-os-home",
    },
    {
      name: "OS home follows absent username and home environment",
      env: {},
      identity: { ...noUidIdentity, homedir: () => "/os/home" },
      scope: "home-os-home",
    },
    {
      name: "unavailable OS identity uses shared scope",
      env: {},
      identity: { ...noUidIdentity, userInfo: unavailableIdentity, homedir: unavailableIdentity },
      scope: "shared",
    },
    {
      name: "empty OS identity uses shared scope",
      env: {},
      identity: noUidIdentity,
      scope: "shared",
    },
    {
      name: "username sanitization preserves dots underscores and internal hyphens",
      env: { USERNAME: "  --Example ._ User--  " },
      identity: noUidIdentity,
      scope: "user-Example-._-User",
    },
    {
      name: "whitespace username sanitizes to unknown without trying USER",
      env: { USERNAME: " \t ", USER: "unix-user" },
      identity: noUidIdentity,
      scope: "user-unknown",
    },
    {
      name: "OS username uses the same sanitization",
      env: {},
      identity: { ...noUidIdentity, userInfo: () => ({ username: "---???---" }) },
      scope: "user-unknown",
    },
    {
      name: "unusable home scope sanitizes to unknown",
      env: { HOME: "---???---" },
      identity: noUidIdentity,
      scope: "home-unknown",
    },
  ])("matches Pi temp scope: $name", ({ env, identity, scope }) => {
    expect(resolveAsyncDir("run", new Map(), env, identity)).toBe(
      join(tmpdir(), `pi-subagents-${scope}`, "async-subagent-runs", "run"),
    );
  });

  test("bridge and configured roots bypass identity lookup", () => {
    const identity = {
      getuid: unavailableIdentity,
      userInfo: unavailableIdentity,
      homedir: unavailableIdentity,
    };
    const env = { PI_SUBAGENTS_TEMP_ROOT: "configured" };
    expect(resolveAsyncDir("run", new Map([["run", "bridge"]]), env, identity)).toBe("bridge");
    expect(resolveAsyncDir("run", new Map(), env, identity)).toBe(
      resolve("configured", "async-subagent-runs", "run"),
    );
  });

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
      const snapshot = status("running", [{ agent: "worker", workflowKey: "first" }]);
      writeFileSync(file, JSON.stringify({ ...snapshot, error: "extra external metadata" }));
      expect(readAsyncStatus(dir)).toEqual(snapshot);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
