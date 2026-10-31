import { execFile } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pino from "pino";
import { expect, test } from "vitest";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import { createPaseoDaemon, type PaseoDaemon } from "../bootstrap.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

const execute = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/pi-scripted-workflow/", import.meta.url));
const piBinary =
  process.env.PASEO_PI_BINARY ??
  "/nix/store/v86wfk7n5acr75lbhd5aa2qsfbf615rb-pi-coding-agent-1.4.0/bin/pi";
const subagentsPackage =
  process.env.PASEO_PI_SUBAGENTS_PACKAGE ??
  "/nix/store/spwn6yyrml8by6wpw6l4a0f0jhybs9m9-pi-subagents-0.84.0/lib/node_modules/pi-subagents";
const runDefinitions = [
  { key: "T1-implement", title: "Implement T1", subtitle: "worker", group: "T1" },
  { key: "T1-review-1", title: "Review T1 round 1", subtitle: "reviewer", group: "T1" },
  { key: "T2.implement", title: "Implement T2", subtitle: "worker", group: "T2" },
  { key: "T2.review", title: "Review T2", subtitle: "reviewer", group: "T2" },
  { key: "cleanup", title: "Cleanup", subtitle: "worker", group: null },
];

function isolatedPiCommand(): string[] {
  // An inherited Pi child context redirects even a configured wrapper to the current Pi package.
  const preserved = new Set([
    "PI_SKIP_VERSION_CHECK",
    "PI_TELEMETRY",
    "PI_GOAL_QUOTA_URL",
    "PI_CODING_AGENT_DIR",
    "PI_SUBAGENTS_TEMP_ROOT",
  ]);
  const inherited = Object.keys(process.env).filter(
    (key) => key.startsWith("PI_") && !preserved.has(key),
  );
  return ["env", ...inherited.flatMap((key) => ["-u", key]), piBinary];
}

interface DescriptorState {
  id: string;
  title: string | null;
  subtitle?: string | null;
  status: ProviderSubagentDescriptorPayload["status"];
  parentSubagentId?: string | null;
}

function descriptorState(descriptors: DescriptorState[]) {
  return descriptors
    .map(({ id, title, subtitle, status, parentSubagentId }) => ({
      id,
      title,
      subtitle,
      status,
      parentSubagentId,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function completedTree(workflowId: string) {
  return descriptorState([
    {
      status: "completed",
      id: workflowId,
      title: "Workflow",
      subtitle: "2 of 2 groups done",
      parentSubagentId: null,
    },
    ...["T1", "T2"].map((group) => ({
      status: "completed",
      id: `${workflowId}/group:${group}`,
      title: group,
      subtitle: group === "T1" ? "Review T1 round 1" : "Review T2",
      parentSubagentId: workflowId,
    })),
    ...runDefinitions.map(({ key, title, subtitle, group }) => ({
      status: "completed",
      id: `${workflowId}/${key}`,
      title,
      subtitle,
      parentSubagentId: group === null ? workflowId : `${workflowId}/group:${group}`,
    })),
  ]);
}

function killRootedProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

async function rootedProcesses(root: string) {
  // The root is filtered in this process, never interpolated into ps's command line.
  const { stdout } = await execute("ps", ["-eo", "pid=,args="]);
  return stdout
    .split("\n")
    .filter((line) => line.includes(root))
    .map((line) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match) throw new Error(`Unparseable process: ${line}`);
      return { pid: Number(match[1]), command: match[2] };
    })
    .filter(({ pid }) => pid !== process.pid);
}

async function createIsolatedWorkspace(client: DaemonClient, cwd: string): Promise<string> {
  const created = await client.createWorkspace({ source: { kind: "directory", path: cwd } });
  if (!created.workspace) throw new Error("Missing isolated workspace");
  return created.workspace.id;
}

async function runTimelines(client: DaemonClient, agentId: string, workflowId: string) {
  return Promise.all(
    runDefinitions.map(async ({ key }) => {
      const timeline = await client.fetchProviderSubagentTimeline(agentId, `${workflowId}/${key}`, {
        direction: "tail",
        limit: 0,
      });
      expect(timeline.hasOlder).toBe(false);
      expect(timeline.hasNewer).toBe(false);
      const items = timeline.rows.map(({ item }) => item);
      expect(items.length).toBeGreaterThan(0);
      expect(items).toContainEqual(
        expect.objectContaining({ type: "assistant_message", text: `PASEO_SCRIPTED_DONE:${key}` }),
      );
      expect(JSON.stringify(items)).not.toContain("DECOY");
      return { key, items };
    }),
  );
}

test("direct workflow streams its tree and child transcripts, then replays after isolated daemon restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-pi-workflow-e2e-"));
  const paseoHome = path.join(root, "paseo-home");
  const piAgent = path.join(root, "pi-agent");
  const subagentsTmp = path.join(root, "subagents-tmp");
  const cwd = path.join(root, "work");
  const gate = path.join(root, "gate");
  const diagnostics = fileURLToPath(new URL("../../../../../.dev/", import.meta.url));
  const evidenceFile = path.join(diagnostics, `${path.basename(root)}-journey.jsonl`);
  const failures: unknown[] = [];

  async function record(stage: string, evidence: unknown): Promise<void> {
    await mkdir(diagnostics, { recursive: true });
    await appendFile(evidenceFile, `${JSON.stringify({ stage, evidence })}\n`);
  }
  let daemon: PaseoDaemon | undefined;
  let client: DaemonClient | undefined;
  const log = pino.destination({ dest: path.join(root, "daemon.log"), sync: true });
  const logger = pino({ level: "debug" }, log);
  const command = isolatedPiCommand();

  async function start() {
    daemon = await createPaseoDaemon(
      {
        listen: "127.0.0.1:0",
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: false,
        mcpInjectIntoAgents: false,
        pluginsEnabled: false,
        staticDir: path.join(root, "static"),
        mcpDebug: false,
        agentClients: {},
        agentStoragePath: path.join(paseoHome, "agents"),
        relayEnabled: false,
        idleRuntimeCleanup: false,
        providerOverrides: {
          pi: {
            command,
            env: {
              PATH: `${path.dirname(piBinary)}${path.delimiter}${process.env.PATH}`,
              PI_CODING_AGENT_DIR: piAgent,
              PI_SUBAGENTS_TEMP_ROOT: subagentsTmp,
              PASEO_SCRIPTED_GATE: gate,
            },
          },
        },
      },
      logger,
    );
    await daemon.start();
    const target = daemon.getListenTarget();
    if (!target || target.type !== "tcp") throw new Error("No isolated TCP listener");
    client = new DaemonClient({ url: `ws://127.0.0.1:${target.port}/ws`, appVersion: "0.1.70" });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    return client;
  }

  try {
    const [executable, ...args] = command;
    const version = await execute(executable, [...args, "--version"]);
    expect(version.stdout.trim(), "NEEDS_CONTEXT: S1 harness requires Pi 1.4.0").toBe("1.4.0");
    const packageMetadata = JSON.parse(
      await readFile(path.join(subagentsPackage, "package.json"), "utf8"),
    );
    expect(packageMetadata.version, "NEEDS_CONTEXT: S1 harness requires pi-subagents 0.84.0").toBe(
      "0.84.0",
    );
    await record("environment", {
      root,
      piBinary,
      piVersion: version.stdout.trim(),
      subagentsPackage,
      subagentsVersion: packageMetadata.version,
      node: process.version,
    });
    await Promise.all(
      [
        paseoHome,
        piAgent,
        subagentsTmp,
        cwd,
        path.join(root, "static"),
        path.join(root, "decoy"),
      ].map((dir) => mkdir(dir, { recursive: true })),
    );
    await cp(path.join(fixture, "agents"), path.join(piAgent, "agents"), { recursive: true });
    const settings = (await readFile(path.join(fixture, "settings.json"), "utf8"))
      .replace('"__PI_SUBAGENTS_PACKAGE__"', () => JSON.stringify(subagentsPackage))
      .replace('"__SCRIPTED_WORKFLOW_PACKAGE__"', () => JSON.stringify(fixture));
    await writeFile(path.join(piAgent, "settings.json"), settings);
    const decoySession = path.join(root, "decoy", "session.jsonl");
    const decoyDir = path.join(subagentsTmp, "async-subagent-runs", "decoy-run");
    await mkdir(decoyDir, { recursive: true });
    await writeFile(
      decoySession,
      [
        {
          type: "session",
          version: 3,
          id: "decoy-session",
          timestamp: new Date().toISOString(),
          cwd,
        },
        {
          type: "message",
          id: "decoy-message",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "DECOY" }],
            timestamp: Date.now(),
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    await writeFile(
      path.join(decoyDir, "status.json"),
      JSON.stringify({
        runId: "decoy-run",
        mode: "workflow",
        state: "running",
        steps: [
          {
            workflowKey: "DECOY",
            label: "DECOY",
            agent: "worker",
            phase: "T1",
            status: "running",
            parentWorkflowRunId: "decoy-run",
            sessionFile: decoySession,
          },
        ],
      }),
    );

    let active = await start();
    const workspaceId = await createIsolatedWorkspace(active, cwd);
    const agent = await active.createAgent({
      provider: "pi",
      cwd,
      title: "Scripted workflow",
      model: "paseo-scripted/workflow",
      workspaceId,
    });
    await active.sendMessage(agent.id, "RUN_WORKFLOW");
    let workflowId = "";
    await expect
      .poll(
        async () => {
          const { subagents } = await active.listProviderSubagents(agent.id);
          const workflow = subagents.find(
            ({ title, parentSubagentId }) => title === "Workflow" && parentSubagentId === null,
          );
          if (!workflow) return null;
          workflowId = workflow.id;
          return descriptorState(subagents)
            .filter(({ id }) =>
              [
                workflowId,
                `${workflowId}/group:T1`,
                `${workflowId}/group:T2`,
                `${workflowId}/T2.implement`,
                `${workflowId}/T2.review`,
              ].includes(id),
            )
            .map(({ id, status }) => ({ id: id.slice(workflowId.length), status }));
        },
        { timeout: 60_000, interval: 100 },
      )
      .toEqual([
        { id: "", status: "running" },
        { id: "/group:T1", status: "completed" },
        { id: "/group:T2", status: "running" },
        { id: "/T2.implement", status: "completed" },
        { id: "/T2.review", status: "running" },
      ]);
    await expect
      .poll(
        async () => {
          const timeline = await active.fetchProviderSubagentTimeline(
            agent.id,
            `${workflowId}/T2.review`,
            { limit: 0 },
          );
          expect(JSON.stringify(timeline.rows)).not.toContain("PASEO_SCRIPTED_DONE:T2.review");
          return timeline.rows.map(({ item }) => item);
        },
        { timeout: 15_000, interval: 100 },
      )
      .toContainEqual(
        expect.objectContaining({ type: "tool_call", name: "bash", status: "running" }),
      );
    await record("before-gate", {
      descriptors: (await active.listProviderSubagents(agent.id)).subagents,
      timeline: await active.fetchProviderSubagentTimeline(agent.id, `${workflowId}/T2.review`, {
        limit: 0,
      }),
    });
    await expect
      .poll(async () => (await active.fetchAgentTimeline(agent.id, { limit: 0 })).agent?.status, {
        timeout: 15_000,
      })
      .toBe("idle");
    await expect
      .poll(
        async () =>
          (await active.fetchWorkspaces()).entries.find((entry) => entry.id === workspaceId)
            ?.status,
      )
      .toBe("running");
    const observerCwd = path.join(root, "observer");
    await mkdir(observerCwd);
    const observerWorkspace = await active.createWorkspace({
      source: { kind: "directory", path: observerCwd },
    });
    const observer = await active.createAgent({
      provider: "pi",
      cwd: observerCwd,
      workspaceId: observerWorkspace.workspace?.id,
      model: "paseo-scripted/workflow",
      title: "Isolated observer",
    });
    await active.sendMessage(observer.id, "OBSERVER_IDLE");
    await expect
      .poll(async () => (await active.fetchAgentTimeline(observer.id, { limit: 0 })).agent?.status)
      .toBe("idle");
    expect((await active.listProviderSubagents(observer.id)).subagents).toEqual([]);
    expect(
      (await active.fetchWorkspaces()).entries.find(
        (entry) => entry.id === observerWorkspace.workspace?.id,
      )?.status,
    ).not.toBe("running");
    await record("idle-parent-workspace-and-observer-isolation", {
      parentStatus: "idle",
      workspaceStatus: "running",
      observer: observer.id,
      observerSubagents: [],
    });
    await writeFile(gate, "open\n");
    const expected = completedTree(workflowId);
    await expect
      .poll(async () => descriptorState((await active.listProviderSubagents(agent.id)).subagents), {
        timeout: 60_000,
        interval: 100,
      })
      .toEqual(expected);
    let liveTimelines: Awaited<ReturnType<typeof runTimelines>> = [];
    await expect
      .poll(
        async () => {
          liveTimelines = await runTimelines(active, agent.id, workflowId);
          return liveTimelines.length;
        },
        { timeout: 15_000, interval: 100 },
      )
      .toBe(runDefinitions.length);
    const completed = (await active.listProviderSubagents(agent.id)).subagents;
    expect(new Set(completed.map(({ id }) => id)).size).toBe(expected.length);
    expect(JSON.stringify(completed)).not.toContain("decoy-run");
    const persisted = await active.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
    const sessionFile = persisted.agent?.persistence?.nativeHandle;
    if (!sessionFile) throw new Error("Missing named Pi session persistence handle");
    // Custom notices are consumed by adapters and intentionally omitted from the app timeline.
    await expect
      .poll(() => readFile(sessionFile, "utf8"), { timeout: 15_000, interval: 100 })
      .toContain("Retention-managed async directory:");
    await record("completed", {
      descriptors: descriptorState(completed),
      timelines: liveTimelines,
    });

    await active.close();
    client = undefined;
    await daemon!.stop();
    daemon = undefined;
    active = await start();
    await active.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    await expect
      .poll(async () => descriptorState((await active.listProviderSubagents(agent.id)).subagents), {
        timeout: 30_000,
        interval: 100,
      })
      .toEqual(expected);
    await expect
      .poll(async () => await runTimelines(active, agent.id, workflowId), {
        timeout: 15_000,
        interval: 100,
      })
      .toEqual(liveTimelines);
    const replayed = (await active.listProviderSubagents(agent.id)).subagents;
    expect(new Set(replayed.map(({ id }) => id)).size).toBe(expected.length);
    expect(JSON.stringify(replayed)).not.toContain("decoy-run");
    await record("restart-replay", {
      descriptors: descriptorState(replayed),
      timelineCounts: liveTimelines.map(({ key, items }) => ({ key, count: items.length })),
    });
    await rm(gate);
    async function launchScenario(name: string) {
      const scenarioCwd = path.join(root, name);
      await mkdir(scenarioCwd);
      const workspace = await active.createWorkspace({
        source: { kind: "directory", path: scenarioCwd },
      });
      const scenario = await active.createAgent({
        provider: "pi",
        cwd: scenarioCwd,
        workspaceId: workspace.workspace?.id,
        model: "paseo-scripted/workflow",
        title: name,
      });
      await active.sendMessage(
        scenario.id,
        name === "failure" ? "RUN_WORKFLOW_FAILURE" : "RUN_WORKFLOW",
      );
      let workflow = "";
      await expect
        .poll(
          async () => {
            const rows = (await active.listProviderSubagents(scenario.id)).subagents;
            workflow = rows.find((row) => row.title === "Workflow")?.id ?? "";
            if (name === "failure") return rows.find((row) => row.id === workflow)?.status;
            return rows.find((row) => row.id === `${workflow}/T2.review`)?.status;
          },
          { timeout: 60_000, interval: 100 },
        )
        .toBe(name === "failure" ? "failed" : "running");
      return { scenario, workflow, workspaceId: workspace.workspace?.id };
    }
    const failure = await launchScenario("failure");
    expect(
      (await active.listProviderSubagents(failure.scenario.id)).subagents.some(
        (row) => row.status === "running",
      ),
    ).toBe(false);
    await record("script-failure", {
      descriptors: (await active.listProviderSubagents(failure.scenario.id)).subagents,
    });

    const stopped = await launchScenario("stop");
    await expect
      .poll(
        async () =>
          (await active.fetchAgentTimeline(stopped.scenario.id, { limit: 0 })).agent?.status,
      )
      .toBe("idle");
    await active.sendMessage(
      stopped.scenario.id,
      `STOP_WORKFLOW:${stopped.workflow.split(":")[1]}`,
    );
    await expect
      .poll(
        async () =>
          (await active.listProviderSubagents(stopped.scenario.id)).subagents.find(
            (row) => row.id === stopped.workflow,
          )?.status,
        { timeout: 20_000 },
      )
      .toBe("canceled");
    await expect
      .poll(
        async () =>
          (await active.listProviderSubagents(stopped.scenario.id)).subagents.some(
            (row) => row.status === "running",
          ),
        { timeout: 20_000 },
      )
      .toBe(false);
    await record("explicit-workflow-stop", {
      descriptors: (await active.listProviderSubagents(stopped.scenario.id)).subagents,
    });

    const killed = await launchScenario("owner-death");
    await expect
      .poll(
        async () =>
          (await active.fetchAgentTimeline(killed.scenario.id, { limit: 0 })).agent?.status,
      )
      .toBe("idle");
    const artifact = JSON.parse(
      await readFile(
        path.join(
          subagentsTmp,
          "async-subagent-runs",
          killed.workflow.split(":")[1],
          "status.json",
        ),
        "utf8",
      ),
    );
    if (!Number.isInteger(artifact.pid)) throw new Error("Real workflow artifact has no owner PID");
    killRootedProcess(artifact.pid);
    await expect
      .poll(
        async () =>
          (await active.listProviderSubagents(killed.scenario.id)).subagents.some(
            (row) => row.status === "running",
          ),
        { timeout: 20_000 },
      )
      .toBe(false);
    expect(
      (await active.listProviderSubagents(killed.scenario.id)).subagents.find(
        (row) => row.id === killed.workflow,
      )?.status,
    ).toBe("canceled");
    await record("owner-death", {
      pid: artifact.pid,
      descriptors: (await active.listProviderSubagents(killed.scenario.id)).subagents,
    });
    await writeFile(gate, "open\n");
    expect((await active.listProviderSubagents(observer.id)).subagents).toEqual([]);
  } catch (error) {
    failures.push(error);
    console.error("S5 failure", error);
  } finally {
    const shutdown = await Promise.allSettled([client?.close()]);
    for (const result of shutdown) if (result.status === "rejected") failures.push(result.reason);
    try {
      await daemon?.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      const leftovers = await rootedProcesses(root);
      await record("process-cleanup", { root, leftovers });
      if (leftovers.length > 0) {
        failures.push(new Error(`Leaked isolated processes: ${JSON.stringify(leftovers)}`));
        for (const { pid } of leftovers) killRootedProcess(pid);
        await expect
          .poll(() => rootedProcesses(root), { timeout: 5000, interval: 100 })
          .toEqual([]);
      }
    } catch (error) {
      failures.push(error);
    }
    log.end();
    if (failures.length > 0) {
      const saved = path.join(diagnostics, `${path.basename(root)}-failure`);
      await mkdir(diagnostics, { recursive: true });
      await cp(root, saved, { recursive: true });
      console.error(`S5 raw diagnostics preserved at ${saved}`);
    }
    await rm(root, { recursive: true, force: true });
    await record("removed-temporary-root", root);
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      "S5 isolated Pi workflow journey failed; inspect raw diagnostics",
    );
}, 240_000);
