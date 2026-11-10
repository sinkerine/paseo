import { createHash } from "node:crypto";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { buildSeededHost } from "../support/helpers/daemon-registry";
import { buildHostAgentDetailRoute } from "../../src/utils/host-routes";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { Page } from "@playwright/test";
import { createPiNativeForkRuntime } from "../support/helpers/pi-native-fork";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm, rename, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test as base } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { expectComposerVisible, submitMessage } from "../support/helpers/composer";

const test = base.extend<
  {},
  { piNativeFork: Awaited<ReturnType<typeof createPiNativeForkRuntime>> }
>({
  piNativeFork: [
    async ({ browserName }, provide) => {
      expect(browserName).toBe("chromium");
      const runtime = await createPiNativeForkRuntime();
      try {
        await provide(runtime);
      } finally {
        await runtime.close();
      }
    },
    { scope: "worker" },
  ],
  e2eDaemonConfig: async ({ piNativeFork }, provide) => provide(piNativeFork.daemonConfig),
  e2eDaemonEnvironment: async ({ piNativeFork }, provide) => provide(piNativeFork.environment),
});

test("native Pi tool-only completion retains its Split boundary", async ({
  page,
  piNativeFork,
}, testInfo) => {
  test.setTimeout(240_000);
  const logs: string[] = [];
  const frames: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => frames.push(String(payload))),
  );
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "pi-fork-ac1" });
  const root = await mkdtemp(path.join(piNativeFork.root, "ac1-work-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  let projectId: string | undefined;
  try {
    const workspace = await client.createWorkspace({ source: { kind: "directory", path: root } });
    if (!workspace.workspace) throw new Error(workspace.error ?? "Missing workspace");
    projectId = workspace.workspace.projectId;
    const agent = await client.createAgent({
      provider: "pi",
      cwd: root,
      workspaceId: workspace.workspace.id,
      title: "Native Pi fork AC1",
      model: process.env.PI_REAL_TEST_MODEL ?? "magpie/group/luna-fast",
    });
    await openAgentRoute(page, { workspaceId: workspace.workspace.id, agentId: agent.id });
    await expectComposerVisible(page);
    await submitMessage(
      page,
      "Use bash to run true, then end your turn immediately after the tool result. Write no assistant text before or after the tool call. Do not use any other tools.",
    );
    expect((await client.waitForFinish(agent.id, 120_000)).status).toBe("idle");
    await expect(page.getByTestId("turn-working-indicator")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("tool-only.png"), fullPage: true });
    const timeline = await client.fetchAgentTimeline(agent.id, { limit: 0 });
    await writeFile(testInfo.outputPath("timeline.json"), JSON.stringify(timeline, null, 2));
    await writeFile(
      testInfo.outputPath("predicate.json"),
      JSON.stringify(
        {
          agentId: agent.id,
          workspaceId: workspace.workspace.id,
          root,
          serverInfo: client.getLastServerInfoMessage(),
          footers: await page.getByTestId("turn-footer").allTextContents(),
          splitTriggers: await page.getByTestId("assistant-fork-menu-trigger").count(),
        },
        null,
        2,
      ),
    );
    // The native tool result is the footer source when Pi persists an empty final assistant.
    await expect(page.getByTestId("assistant-fork-menu-trigger")).toHaveCount(1);
  } finally {
    await mkdir(testInfo.outputDir, { recursive: true });
    await writeFile(testInfo.outputPath("console.log"), logs.join("\n"));
    await writeFile(testInfo.outputPath("frames.jsonl"), frames.join("\n"));
    if (projectId) await client.removeProject(projectId);
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function agentsInCwd(client: DaemonClient, cwd: string) {
  return (await client.fetchAgents()).entries
    .map((entry) => entry.agent)
    .filter((agent) => agent.cwd === cwd);
}

test("native Pi menus render pending and persistent failure states and open independent tabs", async ({
  page,
  piNativeFork,
}, testInfo) => {
  test.setTimeout(240_000);
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "pi-fork-ui" });
  const root = await mkdtemp(path.join(piNativeFork.root, "ui-work-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  let projectId: string | undefined;
  const nativeRequests: string[] = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      const text = String(payload);
      if (text.includes('"agent.fork_session.request"')) nativeRequests.push(text);
    }),
  );
  try {
    const workspace = await client.createWorkspace({ source: { kind: "directory", path: root } });
    if (!workspace.workspace) throw new Error(workspace.error ?? "Missing workspace");
    projectId = workspace.workspace.projectId;
    const source = await client.createAgent({
      provider: "pi",
      cwd: root,
      workspaceId: workspace.workspace.id,
      title: "Native UI source",
      model: process.env.PI_REAL_TEST_MODEL ?? "magpie/group/luna-fast",
    });
    await openAgentRoute(page, { workspaceId: workspace.workspace.id, agentId: source.id });
    await expectComposerVisible(page);
    await submitMessage(
      page,
      "Run bash with command printf NATIVE_UI_TOOL, then reply exactly NATIVE_UI_DONE.",
    );
    expect((await client.waitForFinish(source.id, 120_000)).status).toBe("idle");
    await expect(page.getByTestId("turn-working-indicator")).toHaveCount(0);
    await submitMessage(
      page,
      "Run bash with command sleep 8, then reply exactly SOURCE_RUNNING_DONE.",
    );
    await expect(page.getByTestId("turn-working-indicator")).toBeVisible();
    await page
      .getByTestId("turn-working-indicator")
      .getByTestId("assistant-fork-menu-trigger")
      .click();
    await expect(page.getByTestId("assistant-fork-menu-fork-session")).toHaveCount(0);
    await expect(page.getByTestId("assistant-fork-menu-new-tab")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByTestId(`workspace-tab-agent_${source.id}`).click({ button: "right" });
    await expect(
      page.getByTestId(`workspace-tab-context-agent_${source.id}-clone-session`),
    ).toHaveAttribute("data-menu-disabled", "true");
    await page.screenshot({ path: testInfo.outputPath("native-running-clone-disabled.png") });
    await page.keyboard.press("Escape");
    await page.getByTestId("assistant-fork-menu-trigger").first().click();
    await expect(page.getByTestId("assistant-fork-menu-fork-session")).toHaveAttribute(
      "data-menu-disabled",
      "false",
    );
    await page.keyboard.press("Escape");
    expect((await client.waitForFinish(source.id, 120_000)).status).toBe("idle");
    await expect(page.getByTestId("turn-working-indicator")).toHaveCount(0);
    const snapshot = await client.fetchAgentTimeline(source.id, { limit: 0 });
    const file = snapshot.agent?.persistence?.nativeHandle;
    if (!file) throw new Error("Missing native source file");
    await page.getByTestId("assistant-fork-menu-trigger").last().click();
    await expect(page.getByText("Fork session", { exact: true })).toBeVisible();
    await expect(page.getByText("Copy chat", { exact: true })).toBeVisible();
    await expect(page.getByTestId("assistant-fork-menu-new-tab")).toHaveText(
      "Copy chat to a new tab",
    );
    await page.waitForTimeout(200);
    await page.screenshot({ path: testInfo.outputPath("native-footer-wide.png") });
    await page.keyboard.press("Escape");
    const tab = page.getByTestId(`workspace-tab-agent_${source.id}`);
    await tab.click({ button: "right" });
    await expect(
      page.getByTestId(`workspace-tab-context-agent_${source.id}-clone-session`),
    ).toBeVisible();
    await page.waitForTimeout(200);
    await page.screenshot({ path: testInfo.outputPath("native-clone-wide.png") });
    await page.keyboard.press("Escape");
    // Failure crosses the actual WebSocket RPC and source-file boundary.
    await rename(file, `${file}.held`);
    try {
      await page.getByTestId("assistant-fork-menu-trigger").last().click();
      await page.getByTestId("assistant-fork-menu-fork-session").click();
      await expect(page.getByTestId("native-session-fork-error")).toBeVisible();
      await page.waitForTimeout(2500);
      await expect(page.getByTestId("native-session-fork-error")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("native-failure-persistent.png") });
      expect(await agentsInCwd(client, root)).toHaveLength(1);
      await page.getByTestId("native-session-fork-error-dismiss").click();
      await expect(page.getByTestId("native-session-fork-error")).toHaveCount(0);
    } finally {
      await rename(`${file}.held`, file);
    }
    const requestsBeforeRetry = nativeRequests.length;
    await page.getByTestId("assistant-fork-menu-trigger").last().click();
    const action = page.getByTestId("assistant-fork-menu-fork-session");
    await action.click();
    await expect(action).toHaveAttribute("data-menu-disabled", "true");
    await expect(page.getByTestId("assistant-fork-menu-new-tab")).toHaveAttribute(
      "data-menu-disabled",
      "true",
    );
    await action.click({ force: true });
    await page.screenshot({ path: testInfo.outputPath("native-pending.png") });
    await expect(
      page.getByRole("button", { name: "Native UI source (fork)", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    expect(nativeRequests).toHaveLength(requestsBeforeRetry + 1);
    const forks = (await agentsInCwd(client, root)).filter((agent) => agent.id !== source.id);
    expect(forks).toHaveLength(1);
    const fork = forks[0]!;
    await expect(page.getByTestId(`workspace-tab-agent_${fork.id}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByTestId("assistant-fork-menu-content")).toHaveCount(0);
    await expect(
      page.getByTestId("assistant-message").filter({ hasText: "NATIVE_UI_DONE", visible: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("native-fork-history.png") });
    await openAgentRoute(page, { workspaceId: workspace.workspace.id, agentId: source.id });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("assistant-fork-menu-trigger").last().click();
    await expect(page.getByTestId("assistant-fork-menu-fork-session")).toBeVisible();
    await page.waitForTimeout(200);
    await page.screenshot({ path: testInfo.outputPath("native-footer-compact.png") });
    await page.keyboard.press("Escape");
    await page.getByTestId("workspace-tab-switcher-trigger").click();
    await page.getByTestId(`workspace-tab-menu-agent_${source.id}-trigger`).click();
    const clone = page.getByTestId(`workspace-tab-menu-agent_${source.id}-clone-session`);
    await expect(clone).toBeVisible();
    await page.waitForTimeout(200);
    await page.screenshot({ path: testInfo.outputPath("native-clone-compact.png") });
    await clone.click();
    await expect(clone).toHaveAttribute("data-menu-disabled", "true");
    await page.screenshot({ path: testInfo.outputPath("native-clone-pending-compact.png") });
    await expect
      .poll(async () => (await agentsInCwd(client, root)).length, { timeout: 30_000 })
      .toBe(3);
    await expect(page.getByRole("button", { name: "Menu backdrop", exact: true })).toHaveCount(0);
    await writeFile(
      testInfo.outputPath("native-ui-result.json"),
      JSON.stringify(
        { source, fork, nativeRequests, agents: await agentsInCwd(client, root) },
        null,
        2,
      ),
    );
  } finally {
    if (projectId) await client.removeProject(projectId);
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

function nativeSessionFile(agent: AgentSnapshotPayload): string {
  const file = agent.persistence?.nativeHandle;
  if (!file) throw new Error("Missing native Pi session file");
  return file;
}

async function nativeRecords(file: string): Promise<Record<string, unknown>[]> {
  return (await readFile(file, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function nativeIntegrity(file: string) {
  return {
    sha256: createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
    mtimeNs: (await stat(file, { bigint: true })).mtimeNs.toString(),
  };
}

async function journeyAsk(client: DaemonClient, agentId: string, prompt: string): Promise<void> {
  await client.sendMessage(agentId, prompt);
  expect((await client.waitForFinish(agentId, 180_000)).status).toBe("idle");
}

async function openJourneyAgent(page: Page, serverId: string, agentId: string): Promise<void> {
  await page.goto(buildHostAgentDetailRoute(serverId, agentId), { waitUntil: "commit" });
  const registeredHostIds = await page.evaluate(() => {
    const registry: Array<{ serverId: string }> = JSON.parse(
      localStorage.getItem("@paseo:daemon-registry") ?? "[]",
    );
    return registry.map((host) => host.serverId);
  });
  expect(registeredHostIds, "Journey host must survive every full navigation").toContain(serverId);
  await expectComposerVisible(page);
}

// Reserved for the independent full journey worker. The targeted UI regression above is separate.
test("native Pi journey preserves middle-turn cuts, real compaction and independent continuation after isolated restart", async ({
  page,
  piNativeFork,
}, testInfo) => {
  test.setTimeout(600_000);
  const root = await mkdtemp(path.join(piNativeFork.root, "journey-work-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  const daemon = await startIsolatedHostDaemon("srv_pi_native_fork_journey", {
    config: piNativeFork.daemonConfig,
    environment: { ...process.env, ...piNativeFork.environment },
  });
  expect([6767, 6768]).not.toContain(daemon.port);
  let client = await connectDaemonClient<DaemonClient>({
    port: daemon.port,
    clientIdPrefix: "native-fork-journey",
  });
  try {
    await page.goto("/");
    const journeyHost = buildSeededHost({
      serverId: daemon.serverId,
      label: "Native fork journey",
      endpoint: `127.0.0.1:${daemon.port}`,
      nowIso: new Date().toISOString(),
    });
    // The fixture merges extra hosts into the registry on every navigation, including restart.
    await page.evaluate(
      (host) => localStorage.setItem("@paseo:e2e-extra-hosts", JSON.stringify([host])),
      journeyHost,
    );
    const workspace = await client.createWorkspace({ source: { kind: "directory", path: root } });
    if (!workspace.workspace) throw new Error(workspace.error ?? "Missing journey workspace");
    const source = await client.createAgent({
      provider: "pi",
      cwd: root,
      workspaceId: workspace.workspace.id,
      title: "Native journey source",
      model: process.env.PI_REAL_TEST_MODEL ?? "magpie/group/luna-fast",
    });
    await writeFile(
      path.join(root, "sample.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    execFileSync("git", ["add", "--", "sample.png"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Paseo E2E",
        "-c",
        "user.email=e2e@paseo.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "Add journey PNG fixture",
        "--",
        "sample.png",
      ],
      { cwd: root },
    );
    expect(execFileSync("git", ["show", "HEAD:sample.png"], { cwd: root })).toEqual(
      await readFile(path.join(root, "sample.png")),
    );
    await journeyAsk(
      client,
      source.id,
      "Use read to read sample.png, then reply exactly JOURNEY_IMAGE_SEEN.",
    );
    await journeyAsk(
      client,
      source.id,
      "Run bash with command printf JOURNEY_NATIVE_TOOL, then reply exactly JOURNEY_FIRST_DONE.",
    );
    // This real user trigger, before compaction, makes the first-turn exclusion unambiguous under D6.
    await journeyAsk(
      client,
      source.id,
      `JOURNEY_FILLER_TWO. Ignore this filler: ${"lorem ipsum ".repeat(8_000)} Reply exactly JOURNEY_FILLER_DONE. Do not use tools.`,
    );
    await client.sendMessage(source.id, "/compact");
    await expect
      .poll(
        async () =>
          (await client.fetchAgentTimeline(source.id, { limit: 0 })).entries.some(
            (entry) => entry.item.type === "compaction" && entry.item.status === "completed",
          ),
        { timeout: 180_000 },
      )
      .toBe(true);
    await journeyAsk(
      client,
      source.id,
      "Reply exactly JOURNEY_THIRD_AFTER_COMPACT. Do not use tools.",
    );
    const sourceFile = nativeSessionFile(
      (await client.fetchAgentTimeline(source.id, { limit: 0 })).agent!,
    );
    const sourcePath = await nativeRecords(sourceFile);
    const before = await nativeIntegrity(sourceFile);
    await openJourneyAgent(page, daemon.serverId, source.id);
    await expect(
      page.getByTestId("assistant-fork-menu-trigger").filter({ visible: true }),
    ).toHaveCount(4);
    const earlier = page
      .getByTestId("assistant-fork-menu-trigger")
      .filter({ visible: true })
      .nth(1);
    await earlier.scrollIntoViewIfNeeded();
    await earlier.click();
    await page.getByTestId("assistant-fork-menu-fork-session").click();
    await expect
      .poll(async () => (await agentsInCwd(client, root)).length, { timeout: 30_000 })
      .toBe(2);
    const fork = (await agentsInCwd(client, root)).find((agent) => agent.id !== source.id)!;
    await expect(page.getByTestId(`workspace-tab-agent_${fork.id}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const forkPath = await nativeRecords(nativeSessionFile(fork));
    const filler = sourcePath.findIndex(
      (entry) =>
        JSON.stringify(entry).includes('"role":"user"') &&
        JSON.stringify(entry).includes("JOURNEY_FILLER_TWO"),
    );
    expect(filler).toBeGreaterThan(0);
    expect(forkPath.slice(1)).toEqual(sourcePath.slice(1, filler));
    expect(
      (await client.fetchAgentTimeline(fork.id, { limit: 0 })).entries.some(
        (entry) => entry.item.type === "compaction",
      ),
    ).toBe(false);
    expect(await nativeIntegrity(sourceFile)).toEqual(before);
    await openJourneyAgent(page, daemon.serverId, source.id);
    const latest = page.getByTestId("assistant-fork-menu-trigger").filter({ visible: true }).last();
    await latest.scrollIntoViewIfNeeded();
    await latest.click();
    await page.getByTestId("assistant-fork-menu-fork-session").click();
    await expect
      .poll(async () => (await agentsInCwd(client, root)).length, { timeout: 30_000 })
      .toBe(3);
    const post = (await agentsInCwd(client, root)).find(
      (agent) => agent.id !== source.id && agent.id !== fork.id,
    )!;
    await expect(page.getByTestId(`workspace-tab-agent_${post.id}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const postPath = await nativeRecords(nativeSessionFile(post));
    expect(postPath.slice(1)).toEqual(sourcePath.slice(1));
    const compacted = sourcePath.find((entry) => entry.type === "compaction");
    expect(compacted).toMatchObject({ firstKeptEntryId: expect.any(String) });
    expect(postPath.find((entry) => entry.type === "compaction")).toEqual(compacted);
    const compactionLabel = page
      .getByText(/Context compacted/)
      .filter({ visible: true })
      .first();
    await compactionLabel.scrollIntoViewIfNeeded();
    await expect(compactionLabel).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("native-journey-compaction-history.png") });
    await journeyAsk(client, post.id, "Reply exactly JOURNEY_FORK_ONLY. Do not use tools.");
    await journeyAsk(client, source.id, "Reply exactly JOURNEY_SOURCE_ONLY. Do not use tools.");
    expect(await readFile(sourceFile, "utf8")).not.toContain("JOURNEY_FORK_ONLY");
    expect(await readFile(nativeSessionFile(post), "utf8")).not.toContain("JOURNEY_SOURCE_ONLY");
    const beforePid = (await client.getDaemonStatus()).pid;
    await client.close();
    await daemon.restart();
    client = await connectDaemonClient<DaemonClient>({
      port: daemon.port,
      clientIdPrefix: "native-fork-journey-restart",
    });
    expect((await client.getDaemonStatus()).pid).not.toBe(beforePid);
    await openJourneyAgent(page, daemon.serverId, post.id);
    await expect(
      page.getByTestId("assistant-message").filter({ hasText: "JOURNEY_FORK_ONLY", visible: true }),
    ).toBeVisible({ timeout: 30_000 });
    expect(
      JSON.stringify((await client.fetchAgentTimeline(post.id, { limit: 0 })).entries),
    ).not.toContain("JOURNEY_SOURCE_ONLY");
    await submitMessage(page, "Reply exactly JOURNEY_AFTER_RESTART. Do not use tools.");
    expect((await client.waitForFinish(post.id, 180_000)).status).toBe("idle");
    expect(await readFile(sourceFile, "utf8")).not.toContain("JOURNEY_AFTER_RESTART");
    await page.screenshot({ path: testInfo.outputPath("native-journey-after-restart.png") });
    await writeFile(
      testInfo.outputPath("native-journey-result.json"),
      JSON.stringify(
        {
          source,
          fork,
          post,
          before,
          compacted,
          beforePid,
          afterPid: (await client.getDaemonStatus()).pid,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});
