import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { PiRpcAgentClient } from "../agent/providers/pi/agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const model = process.env.PI_REAL_TEST_MODEL ?? "magpie/group/luna-fast";
const logger = pino({ level: "silent" });

async function integrity(file: string) {
  return {
    sha256: createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
    mtimeNs: (await stat(file, { bigint: true })).mtimeNs.toString(),
  };
}

function nativeFile(agent: AgentSnapshotPayload): string {
  const file = agent.persistence?.nativeHandle;
  if (!file) throw new Error("Missing native Pi file");
  return file;
}

async function ask(client: DaemonClient, agentId: string, prompt: string): Promise<void> {
  await client.sendMessage(agentId, prompt);
  expect((await client.waitForFinish(agentId, 120_000)).status).toBe("idle");
}

async function jsonl(file: string): Promise<Record<string, unknown>[]> {
  return (await readFile(file, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function verifyRestartedBranches(
  client: DaemonClient,
  source: AgentSnapshotPayload,
  fork: AgentSnapshotPayload,
) {
  const sourceFile = nativeFile(source);
  const forkFile = nativeFile(fork);
  const listed = await client.fetchAgents();
  expect(listed.entries.map((entry) => entry.agent.id)).toEqual(
    expect.arrayContaining([source.id, fork.id]),
  );
  const recovered = await client.fetchAgentTimeline(fork.id, { limit: 0 });
  expect(nativeFile(recovered.agent!)).toBe(forkFile);
  expect(JSON.stringify(recovered.entries)).toContain("FORK_ONLY");
  expect(JSON.stringify(recovered.entries)).not.toContain("SOURCE_ONLY");
  const recoveredSource = await client.fetchAgentTimeline(source.id, { limit: 0 });
  expect(nativeFile(recoveredSource.agent!)).toBe(sourceFile);
  expect(recoveredSource.agent?.persistence?.sessionId).toBe(source.persistence?.sessionId);
  expect(recovered.agent?.persistence?.sessionId).toBe(fork.persistence?.sessionId);
  expect(JSON.stringify(recoveredSource.entries)).toContain("SOURCE_BEFORE_RESTART");
  expect(JSON.stringify(recoveredSource.entries)).toContain("TURN_THREE_AFTER_COMPACTION");
  expect(JSON.stringify(recoveredSource.entries)).not.toContain("FORK_ONLY");
  expect(JSON.stringify(recovered.entries)).not.toContain("SOURCE_BEFORE_RESTART");
  await ask(client, fork.id, "Reply exactly FORK_AFTER_RESTART. Do not use any tools.");
  await ask(client, source.id, "Reply exactly SOURCE_AFTER_RESTART. Do not use any tools.");
  const continuedFork = await client.fetchAgentTimeline(fork.id, { limit: 0 });
  const continuedSource = await client.fetchAgentTimeline(source.id, { limit: 0 });
  expect(continuedFork.entries.map((row) => row.item)).toContainEqual(
    expect.objectContaining({ type: "assistant_message", text: "FORK_AFTER_RESTART" }),
  );
  expect(continuedSource.entries.map((row) => row.item)).toContainEqual(
    expect.objectContaining({ type: "assistant_message", text: "SOURCE_AFTER_RESTART" }),
  );
  const forkText = await readFile(forkFile, "utf8");
  const sourceText = await readFile(sourceFile, "utf8");
  for (const text of [forkText, JSON.stringify(continuedFork.entries)]) {
    expect(text).toContain("FORK_ONLY");
    expect(text).toContain("FORK_AFTER_RESTART");
    expect(text).not.toContain("SOURCE_BEFORE_RESTART");
    expect(text).not.toContain("SOURCE_AFTER_RESTART");
  }
  for (const text of [sourceText, JSON.stringify(continuedSource.entries)]) {
    expect(text).toContain("SOURCE_BEFORE_RESTART");
    expect(text).toContain("SOURCE_AFTER_RESTART");
    expect(text).not.toContain("FORK_ONLY");
    expect(text).not.toContain("FORK_AFTER_RESTART");
  }
  return {
    listedAgentIds: listed.entries.map((entry) => entry.agent.id),
    source: recoveredSource,
    fork: recovered,
    continuedSource,
    continuedFork,
    sourceFile,
    forkFile,
    sourceText,
    forkText,
  };
}

test("native Pi forks and clone retain independent native history across an isolated restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-real-native-fork-"));
  const cwd = path.join(root, "work");
  const piAgent = path.join(root, "pi-agent");
  await mkdir(cwd);
  await mkdir(piAgent);
  // Credentials and provider definitions are copied to disposable state, never changed in place.
  for (const file of ["auth.json", "models.json"])
    await copyFile(path.join(homedir(), ".pi", "agent", file), path.join(piAgent, file));
  const probe = path.join(root, "source-runtime-probe.ts");
  const runtimeEvents = path.join(root, "runtime-events.jsonl");
  await writeFile(runtimeEvents, "");
  await writeFile(
    probe,
    `import {appendFileSync} from "node:fs"; export default function(pi) {
    for (const type of ["session_start", "session_shutdown", "session_before_fork"]) pi.on(type, (event,ctx)=>appendFileSync(${JSON.stringify(runtimeEvents)},JSON.stringify({type,pid:process.pid,sessionId:ctx.sessionManager.getSessionId(),reason:event.reason})+"\\n"));
  }`,
  );
  const environment = {
    PI_CODING_AGENT_DIR: piAgent,
    PI_CODING_AGENT_SESSION_DIR: path.join(root, "native-sessions"),
  };
  const provider = () =>
    new PiRpcAgentClient({
      logger,
      runtimeSettings: {
        command: {
          mode: "replace",
          argv: [process.env.PASEO_PI_BINARY ?? "pi", "--extension", probe],
        },
        env: environment,
      },
    });
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;
  async function start() {
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot: path.join(root, "home"),
      staticDir: path.join(root, "static"),
      cleanup: false,
      agentClients: { pi: provider() },
      logger,
      mcpEnabled: false,
      pluginsEnabled: false,
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      reconnect: { enabled: false },
    });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    return client;
  }
  try {
    let active = await start();
    const workspace = await active.createWorkspace({ source: { kind: "directory", path: cwd } });
    if (!workspace.workspace) throw new Error(workspace.error ?? "Missing workspace");
    const source = await active.createAgent({
      provider: "pi",
      cwd,
      workspaceId: workspace.workspace.id,
      title: "Native source",
      model,
    });
    await ask(
      active,
      source.id,
      "Run bash with command printf NATIVE_TOOL, then reply exactly TURN_ONE.",
    );
    const first = await active.fetchAgentTimeline(source.id, { limit: 0 });
    const boundary = first.entries.findLast((row) => row.item.type === "assistant_message");
    if (!boundary) throw new Error("Missing first native assistant boundary");
    await ask(
      active,
      source.id,
      `FILLER_TURN_TWO. Ignore this filler: ${"lorem ipsum ".repeat(8_000)} Reply exactly TURN_TWO. Do not use tools.`,
    );
    await active.sendMessage(source.id, "/compact");
    await expect
      .poll(
        async () =>
          (await active.fetchAgentTimeline(source.id, { limit: 0 })).entries.some(
            (entry) => entry.item.type === "compaction" && entry.item.status === "completed",
          ),
        { timeout: 120_000 },
      )
      .toBe(true);
    await ask(
      active,
      source.id,
      "Reply exactly TURN_THREE_AFTER_COMPACTION. Do not use any tools.",
    );
    const beforeAgent = await active.fetchAgentTimeline(source.id, { limit: 0 });
    if (!beforeAgent.agent) throw new Error("Missing source snapshot");
    const sourceFile = nativeFile(beforeAgent.agent);
    const before = await integrity(sourceFile);
    const startsBefore = await jsonl(runtimeEvents);
    const sourcePid = startsBefore.find(
      (event) =>
        event.type === "session_start" &&
        event.sessionId === beforeAgent.agent!.persistence!.sessionId,
    )?.pid;
    expect(typeof sourcePid).toBe("number");
    const sourceRuntime = daemon!.daemon.agentManager.getAgent(source.id)?.session;
    const currentFirstBoundary = beforeAgent.entries.find(
      (entry) => entry.item.type === "assistant_message" && entry.item.text.includes("TURN_ONE"),
    );
    if (!currentFirstBoundary) throw new Error("Missing current first-turn footer boundary");
    const fork = await active.forkAgentSession(source.id, {
      target: "turn",
      boundaryCursor: { epoch: beforeAgent.epoch, seq: currentFirstBoundary.seqEnd },
    });
    const forkFile = nativeFile(fork);
    expect(fork.id).not.toBe(source.id);
    expect(fork.labels).toEqual({});
    expect(fork.workspaceId).toBe(source.workspaceId);
    expect(fork.cwd).toBe(cwd);
    expect(fork.title).toBe("Native source (fork)");
    expect(fork.model).toBe(model);
    expect(fork.persistence?.sessionId).not.toBe(beforeAgent.agent.persistence?.sessionId);
    expect(path.dirname(forkFile)).toBe(path.dirname(sourceFile));
    const sourceRecords = await jsonl(sourceFile);
    const forkRecords = await jsonl(forkFile);
    expect(forkRecords[0]).toMatchObject({
      parentSession: sourceFile,
      id: fork.persistence?.sessionId,
    });
    const secondUser = sourceRecords.findIndex(
      (entry) =>
        JSON.stringify(entry).includes('"role":"user"') &&
        JSON.stringify(entry).includes("TURN_TWO"),
    );
    expect(secondUser).toBeGreaterThan(0);
    expect(forkRecords.slice(1)).toEqual(sourceRecords.slice(1, secondUser));
    expect(await integrity(sourceFile)).toEqual(before);
    const eventsAfterFork = await jsonl(runtimeEvents);
    expect(
      eventsAfterFork.filter(
        (event) => event.sessionId === beforeAgent.agent!.persistence!.sessionId,
      ),
    ).toEqual(
      startsBefore.filter((event) => event.sessionId === beforeAgent.agent!.persistence!.sessionId),
    );
    expect(eventsAfterFork.some((event) => event.type === "session_before_fork")).toBe(false);
    expect(
      eventsAfterFork.find(
        (event) =>
          event.type === "session_start" && event.sessionId === fork.persistence!.sessionId,
      ),
    ).toMatchObject({ reason: "startup" });
    expect(daemon!.daemon.agentManager.getAgent(source.id)?.session).toBe(sourceRuntime);
    const afterAgent = await active.fetchAgentTimeline(source.id, { limit: 0 });
    expect(afterAgent.agent).toEqual(beforeAgent.agent);
    expect(afterAgent.entries).toEqual(beforeAgent.entries);
    const forkHistory = await active.fetchAgentTimeline(fork.id, { limit: 0 });
    expect(forkHistory.entries.some((row) => row.item.type === "tool_call")).toBe(true);
    expect(JSON.stringify(forkHistory.entries)).not.toContain("TURN_TWO");
    expect(forkHistory.entries.some((entry) => entry.item.type === "compaction")).toBe(false);
    const postCompactionFork = await active.forkAgentSession(source.id, { target: "latest" });
    const postCompactionRecords = await jsonl(nativeFile(postCompactionFork));
    expect(postCompactionRecords.slice(1)).toEqual(sourceRecords.slice(1));
    const nativeCompaction = sourceRecords.find((entry) => entry.type === "compaction");
    expect(nativeCompaction).toBeDefined();
    expect(postCompactionRecords.find((entry) => entry.type === "compaction")).toEqual(
      nativeCompaction,
    );
    expect(
      (await active.fetchAgentTimeline(postCompactionFork.id, { limit: 0 })).entries.some(
        (entry) => entry.item.type === "compaction",
      ),
    ).toBe(true);
    expect(await integrity(sourceFile)).toEqual(before);
    await ask(active, fork.id, "Reply exactly FORK_ONLY. Do not use any tools.");
    await ask(active, source.id, "Reply exactly SOURCE_ONLY. Do not use any tools.");
    expect(await readFile(sourceFile, "utf8")).not.toContain("FORK_ONLY");
    expect(await readFile(forkFile, "utf8")).not.toContain("SOURCE_ONLY");
    // A new fork of the imported branch uses its replayed exact native entry identities.
    const nested = await active.forkAgentSession(fork.id, {
      target: "turn",
      boundaryCursor: {
        epoch: forkHistory.epoch,
        seq: forkHistory.entries.findLast((row) => row.item.type === "assistant_message")!.seqEnd,
      },
    });
    expect(await readFile(nativeFile(nested), "utf8")).not.toContain("FORK_ONLY");
    const clone = await active.forkAgentSession(source.id, { target: "latest" });
    expect((await jsonl(nativeFile(clone))).slice(1)).toEqual((await jsonl(sourceFile)).slice(1));
    const beforeRewind = await active.fetchAgentTimeline(source.id, { limit: 0 });
    const lastUser = beforeRewind.entries.findLast(
      (entry) => entry.item.type === "user_message" && entry.item.text.includes("SOURCE_ONLY"),
    );
    if (!lastUser || lastUser.item.type !== "user_message" || !lastUser.item.messageId)
      throw new Error("Missing rewind user identity");
    await active.rewindAgent(source.id, lastUser.item.messageId, "conversation");
    const rewindBaseline = await integrity(sourceFile);
    const rewoundClone = await active.forkAgentSession(source.id, { target: "latest" });
    expect(await readFile(nativeFile(rewoundClone), "utf8")).not.toContain("SOURCE_ONLY");
    expect(await readFile(sourceFile, "utf8")).toContain("SOURCE_ONLY");
    expect(await integrity(sourceFile)).toEqual(rewindBaseline);
    await ask(active, source.id, "Reply exactly SOURCE_BEFORE_RESTART. Do not use any tools.");
    await active.close();
    await daemon!.close();
    active = await start();
    const { sourceText, forkText, ...restart } = await verifyRestartedBranches(
      active,
      beforeAgent.agent,
      fork,
    );
    const evidenceDir = process.env.PASEO_NATIVE_FORK_EVIDENCE_DIR;
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(path.join(evidenceDir, "restart-source-native.jsonl"), sourceText);
      await writeFile(path.join(evidenceDir, "restart-fork-native.jsonl"), forkText);
      await writeFile(
        path.join(evidenceDir, "native-real-result.json"),
        JSON.stringify(
          {
            source: beforeAgent.agent,
            fork,
            clone,
            nested,
            postCompactionFork,
            nativeCompaction,
            sourceIntegrity: before,
            sourceUnchangedAfterFork: true,
            sourcePid,
            runtimeEvents: eventsAfterFork,
            nativePrefixEqual: true,
            restart,
            isolatedRoot: root,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    await client?.close();
    await daemon?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);

// The actual installed goal-x extension owns files/scheduling. Only model output is local and deterministic.
test("native branching preserves installed goal-x source ownership and never wakes the destination", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-native-goal-owner-"));
  const cwd = path.join(root, "work");
  const piAgent = path.join(root, "pi-agent");
  await mkdir(cwd);
  await mkdir(piAgent);
  const calls = path.join(root, "calls.log");
  await writeFile(calls, "");
  const goalPackage =
    process.env.PASEO_PI_GOAL_PACKAGE ??
    "/nix/store/zvfvj7w6km54vjj7imwai1m591ddyxsp-pi-goal-x-0.34.1-unstable-2026-11-06/lib/node_modules/pi-goal-x";
  const goalExtension = path.join(goalPackage, "extensions/goal.ts");
  const scripted = new URL("./fixtures/pi-native-fork/goal-provider.ts", import.meta.url).pathname;
  const environment = {
    PI_CODING_AGENT_DIR: piAgent,
    PI_CODING_AGENT_SESSION_DIR: path.join(root, "sessions"),
    PI_GOAL_ROOT: path.join(root, "goals"),
    PASEO_NATIVE_GOAL_CALLS: calls,
    PASEO_NATIVE_GOAL_GATE: path.join(root, "gate"),
  };
  const clear = Object.keys(process.env).filter(
    (key) => key.startsWith("PI_") && !(key in environment),
  );
  const command: [string, ...string[]] = [
    "env",
    ...clear.flatMap((key) => ["-u", key]),
    process.env.PASEO_PI_BINARY ?? "pi",
    "--extension",
    scripted,
    "--extension",
    goalExtension,
  ];
  const provider = new PiRpcAgentClient({
    logger,
    runtimeSettings: { command: { mode: "replace", argv: command }, env: environment },
  });
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: path.join(root, "home"),
    staticDir: path.join(root, "static"),
    cleanup: false,
    agentClients: { pi: provider },
    logger,
    mcpEnabled: false,
    pluginsEnabled: false,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
    const workspace = await client.createWorkspace({ source: { kind: "directory", path: cwd } });
    if (!workspace.workspace) throw new Error(workspace.error ?? "Missing goal workspace");
    const source = await client.createAgent({
      provider: "pi",
      cwd,
      workspaceId: workspace.workspace.id,
      model: "native-fork-scripted/goal",
    });
    await ask(client, source.id, "NATIVE_GOAL_INITIAL");
    const first = await client.fetchAgentTimeline(source.id, { limit: 0 });
    const boundary = first.entries.findLast((row) => row.item.type === "assistant_message");
    if (!boundary) throw new Error("Missing pre-goal response boundary");
    await client.sendMessage(
      source.id,
      "/goal-direct Wait for the isolated native fork gate, preserving this goal until the user pauses it.",
    );
    await expect
      .poll(async () => (await readFile(calls, "utf8")).trim().split("\n").length, {
        timeout: 20_000,
      })
      .toBeGreaterThan(1);
    await expect
      .poll(() => daemon.daemon.agentManager.hasInFlightRun(source.id), { timeout: 20_000 })
      .toBe(true);
    const sourceSnapshot = (await client.fetchAgentTimeline(source.id, { limit: 0 })).agent;
    if (!sourceSnapshot) throw new Error("Missing goal source snapshot");
    const sourceFile = nativeFile(sourceSnapshot);
    const before = await integrity(sourceFile);
    const sourceRuntime = daemon.daemon.agentManager.getAgent(source.id)?.session;
    const evidenceDir = process.env.PASEO_NATIVE_FORK_EVIDENCE_DIR;
    if (evidenceDir) {
      await writeFile(
        path.join(evidenceDir, "native-goal-source-before.json"),
        JSON.stringify(
          {
            sourceSnapshot,
            persistence: daemon.daemon.agentManager.getAgent(source.id)?.persistence,
            entries: await jsonl(sourceFile),
            before,
          },
          null,
          2,
        ),
      );
    }
    const fork = await client.forkAgentSession(source.id, {
      target: "turn",
      boundaryCursor: { epoch: first.epoch, seq: boundary.seqEnd },
    });
    expect(await integrity(sourceFile)).toEqual(before);
    expect(daemon.daemon.agentManager.getAgent(source.id)?.session).toBe(sourceRuntime);
    expect(
      (await client.fetchAgentTimeline(source.id, { limit: 0 })).agent?.pendingPermissions,
    ).toEqual(sourceSnapshot.pendingPermissions);
    const sourceSession = sourceSnapshot.persistence!.sessionId;
    const forkSession = fork.persistence!.sessionId;
    expect(forkSession).not.toBe(sourceSession);
    const ownedCalls = () => readFile(calls, "utf8");
    // No destination model call is allowed while the source is held in its actual goal tool.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(
      (await ownedCalls())
        .trim()
        .split("\n")
        .every((id) => id === sourceSession),
    ).toBe(true);
    expect((await client.listProviderSubagents(fork.id)).subagents).toEqual([]);
    expect((await client.fetchAgentTimeline(fork.id, { limit: 0 })).agent?.status).toBe("idle");
    const { readdir } = await import("node:fs/promises");
    const goalFiles = (await readdir(environment.PI_GOAL_ROOT)).filter(
      (name) => name.startsWith("active_goal_") && name.endsWith(".md"),
    );
    expect(goalFiles).toHaveLength(1);
    const goalText = await readFile(path.join(environment.PI_GOAL_ROOT, goalFiles[0]!), "utf8");
    expect(goalText).toContain(`"owner": "${sourceSession}"`);
    expect(goalText).not.toContain(`"owner": "${forkSession}"`);
    expect(await readFile(nativeFile(fork), "utf8")).toContain("pi-goal");
    if (evidenceDir)
      await writeFile(
        path.join(evidenceDir, "native-goal-result.json"),
        JSON.stringify(
          { source: sourceSnapshot, fork, calls: await ownedCalls(), goalText, goalPackage },
          null,
          2,
        ),
      );
  } finally {
    await writeFile(environment.PASEO_NATIVE_GOAL_GATE, "open");
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
