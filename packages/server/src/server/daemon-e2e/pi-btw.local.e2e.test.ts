import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { createPaseoDaemon, type PaseoDaemon } from "../bootstrap.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createBtwRuntime } from "./fixtures/pi-btw-stub/runtime.js";

test("pi-btw remains out-of-band while busy, retries failures and restores the same timeline after isolated daemon restart", async () => {
  const runtime = await createBtwRuntime();
  if (!runtime.stub) throw new Error("Missing HTTP fixture");
  const stub = runtime.stub;
  const home = path.join(runtime.root, "paseo-home");
  const cwd = path.join(runtime.root, "work");
  await mkdir(cwd);
  let daemon: PaseoDaemon | undefined;
  let client: DaemonClient | undefined;
  const logger = pino({ level: "silent" });
  async function start() {
    daemon = await createPaseoDaemon(
      {
        listen: "127.0.0.1:0",
        paseoHome: home,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: false,
        mcpInjectIntoAgents: false,
        pluginsEnabled: false,
        staticDir: path.join(runtime.root, "static"),
        mcpDebug: false,
        agentClients: {},
        agentStoragePath: path.join(home, "agents"),
        relayEnabled: false,
        idleRuntimeCleanup: false,
        providerOverrides: runtime.daemonConfig.agents.providers,
      },
      logger,
    );
    await daemon.start();
    const target = daemon.getListenTarget();
    if (!target || target.type !== "tcp") throw new Error("Missing isolated listener");
    client = new DaemonClient({ url: `ws://127.0.0.1:${target.port}/ws`, appVersion: "0.15.3" });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    return client;
  }
  try {
    let active = await start();
    const workspace = await active.createWorkspace({ source: { kind: "directory", path: cwd } });
    if (!workspace.workspace) throw new Error("Missing BTW workspace");
    const agent = await active.createAgent({
      provider: "pi",
      cwd,
      model: runtime.model,
      workspaceId: workspace.workspace.id,
    });
    await active.sendMessage(agent.id, "PARENT_A");
    await expect
      .poll(
        async () =>
          (await active.fetchAgentTimeline(agent.id, { limit: 0 })).entries.some(
            ({ item }) => item.type === "assistant_message" && item.text === "PARENT_A_FINISHED",
          ),
        { timeout: 60000 },
      )
      .toBe(true);
    await expect
      .poll(async () => (await active.fetchAgentTimeline(agent.id, { limit: 0 })).agent?.status, {
        timeout: 60000,
      })
      .toBe("idle");
    async function verifyNormalizedCommands(busy: boolean) {
      for (const input of [" /btw ", "/btw\n", "/btw\t"]) {
        const question = "NORMALIZE 日本語\nsecond\tline";
        const before = await active.fetchAgentTimeline(agent.id, { limit: 0 });
        const usersBefore = before.entries.filter(({ item }) => item.type === "user_message");
        const requestsBefore = stub.requests.length;
        await active.sendMessage(agent.id, input + question, { messageId: "" });
        await expect.poll(() => stub.requests.length).toBe(requestsBefore + 1);
        await expect
          .poll(async () => (await active.listProviderSubagents(agent.id)).subagents[0]?.status, {
            timeout: 60000,
          })
          .toBe("completed");
        const request = stub.requests.at(-1);
        expect(JSON.stringify(request?.messages)).toContain("<btw>");
        expect(JSON.stringify(request?.messages.at(-1)?.content)).toContain(
          "NORMALIZE 日本語\\nsecond\\tline",
        );
        const after = await active.fetchAgentTimeline(agent.id, { limit: 0 });
        expect(after.entries.filter(({ item }) => item.type === "user_message")).toEqual(
          usersBefore,
        );
        expect(after.agent?.status).toBe(busy ? "running" : "idle");
        expect(stub.pending("parent")).toBe(busy ? 1 : 0);
      }
    }
    await verifyNormalizedCommands(false);
    await active.sendMessage(agent.id, "HOLD_PARENT");
    await expect.poll(() => runtime.stub?.pending("parent")).toBe(1);
    await active.sendMessage(agent.id, "/btw HOLD_BTW");
    await expect.poll(() => runtime.stub?.pending("btw")).toBe(1);
    const list = () => active.listProviderSubagents(agent.id);
    await expect.poll(async () => (await list()).subagents[0]?.status).toBe("running");
    const thread = (await list()).subagents[0];
    expect(thread).toMatchObject({
      presentation: "side_conversation",
      subtitle: expect.stringContaining("pinned turn 1"),
    });
    expect((await active.fetchAgentTimeline(agent.id, { limit: 0 })).agent?.status).toBe("running");
    // The provider response remains held. Stop must be admitted before generation completes.
    await active.sendMessage(agent.id, "/btw:abort", { messageId: "" });
    await expect.poll(async () => (await list()).subagents[0]?.status).toBe("canceled");
    expect((await active.fetchAgentTimeline(agent.id, { limit: 0 })).agent?.status).toBe("running");
    await verifyNormalizedCommands(true);
    runtime.stub.release("parent");
    await expect
      .poll(async () => (await active.fetchAgentTimeline(agent.id, { limit: 0 })).agent?.status)
      .toBe("idle");
    await active.sendMessage(agent.id, "/btw FAIL_BTW", { messageId: "" });
    await expect
      .poll(async () => (await list()).subagents[0]?.status, { timeout: 60000 })
      .toBe("failed");
    expect((await list()).subagents[0].description).toContain("failed");
    await active.sendMessage(agent.id, "/btw AFTER_B", { messageId: "" });
    await expect
      .poll(async () => (await list()).subagents[0]?.status, { timeout: 60000 })
      .toBe("completed");
    expect((await list()).subagents[0].subtitle).toContain("pinned turn 2");
    const before = await active.fetchProviderSubagentTimeline(agent.id, thread.id, { limit: 0 });
    expect(JSON.stringify(before.rows)).toContain("BTW_REPLY AFTER_B");
    const beforeItems = before.rows.map(({ item }) => item);
    await active.refreshAgent(agent.id);
    expect((await list()).subagents.map(({ id }) => id)).toEqual([thread.id]);
    expect(
      (await active.fetchProviderSubagentTimeline(agent.id, thread.id, { limit: 0 })).rows.map(
        ({ item }) => item,
      ),
    ).toEqual(beforeItems);
    await active.close();
    client = undefined;
    await daemon?.stop();
    daemon = undefined;
    active = await start();
    await active.fetchAgentTimeline(agent.id, { limit: 0 });
    await expect
      .poll(async () => (await list()).subagents.map(({ id }) => id), { timeout: 60000 })
      .toEqual([thread.id]);
    const after = await active.fetchProviderSubagentTimeline(agent.id, thread.id, { limit: 0 });
    expect(after.rows.map(({ item }) => item)).toEqual(beforeItems);
    const fork = await active.forkAgentSession(agent.id, { target: "latest" });
    expect((await active.listProviderSubagents(fork.id)).subagents).toEqual([]);
    await active.archiveAgent(fork.id);
    await active.sendMessage(agent.id, "/btw:clear", { messageId: "" });
    await expect.poll(async () => (await list()).subagents).toEqual([]);
    await active.archiveAgent(agent.id);
    const absentHome = path.join(runtime.root, "pi-without-btw");
    await mkdir(absentHome);
    await copyFile(path.join(runtime.piAgent, "models.json"), path.join(absentHome, "models.json"));
    await writeFile(
      path.join(absentHome, "settings.json"),
      JSON.stringify({
        packages: [],
        defaultProvider: "paseo-btw",
        defaultModel: "stub",
        defaultThinkingLevel: "off",
      }),
    );
    const absent = await active.createAgent({
      provider: "pi",
      cwd,
      model: runtime.model,
      workspaceId: workspace.workspace.id,
      env: { PI_CODING_AGENT_DIR: absentHome },
    });
    await active.sendMessage(absent.id, "HOLD_PARENT");
    await expect.poll(() => runtime.stub?.pending("parent")).toBe(1);
    await active.sendMessage(absent.id, "/btw no extension");
    await expect
      .poll(async () => (await active.fetchAgentTimeline(absent.id, { limit: 0 })).agent?.status)
      .toBe("idle");
    expect((await active.listProviderSubagents(absent.id)).subagents).toEqual([]);
    await active.archiveAgent(absent.id);
    await active.removeProject(workspace.workspace.projectId);
    const output = process.env.PASEO_PI_BTW_EVIDENCE_DIR;
    if (output) {
      await mkdir(output, { recursive: true });
      await writeFile(
        path.join(output, "daemon-journey.json"),
        JSON.stringify(
          {
            pi: runtime.piBinary,
            revision: runtime.revision,
            threadId: thread.id,
            rowsBefore: before.rows.length,
            rowsAfter: after.rows.length,
            events: (await readFile(runtime.events, "utf8"))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
          },
          null,
          2,
        ),
      );
    }
  } finally {
    runtime.stub.release("parent");
    runtime.stub.release("btw");
    await client?.close();
    await daemon?.stop();
    await runtime.close();
  }
}, 180000);
