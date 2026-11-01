import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { expect, test, type Page } from "../support/fixtures";
import { installDesktopRuntime } from "../../../desktop/e2e/support/runtime";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { expectComposerModel, expectComposerMode } from "../support/helpers/agent-profiles";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { composerLocator, expectComposerEditable } from "../support/helpers/composer";
import { addConnectedHostsAndReload, reloadPreservingHostRegistry } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { clickSettingsBackToWorkspace, openSettingsSection } from "../support/helpers/settings";
import { createAgentTabFromMenu } from "../support/helpers/workspace-tabs";

const OVERRIDES_KEY = "@paseo:keyboard-shortcut-overrides";
const SELECT_ID = JSON.stringify(["agent-profile.select", "claude"]);
const START_ID = JSON.stringify(["agent-profile.start", "pi opus"]);
const REMOTE_PROVIDER = "shortcut-pi";
const KAZUKI_PROFILES: AgentProfile[] = [
  {
    id: "kazuki-claude",
    name: "Claude",
    provider: "mock",
    model: "one-minute-stream",
    modeId: "approval-test",
  },
  {
    id: "kazuki-pi-opus",
    name: "Pi Opus",
    provider: "mock",
    model: "ten-second-stream",
    modeId: "load-test",
  },
];
const SACHI_PROFILES: AgentProfile[] = [
  { id: "sachi-claude", name: "claude ", provider: REMOTE_PROVIDER, model: "pi-profile-model" },
];

async function readOverrides(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), OVERRIDES_KEY);
}

// The menu is a stable row anchor; its parent contains the label, note and keys.
function shortcutRow(page: Page, id: string) {
  return page.getByTestId(`shortcut-actions-${id}`).locator("../../..");
}

async function openShortcuts(page: Page) {
  await openSettings(page);
  await openSettingsSection(page, "shortcuts");
  await expect(page.getByText("Agent profiles", { exact: true })).toHaveCount(1);
  await expect(page.getByText(/^Agent profiles —/)).toHaveCount(0);
}

test("profile shortcuts migrate, resolve on the active host, and share one rebind", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const cleanup: Array<() => Promise<unknown>> = [];
  const consoleLines: string[] = [];
  const createRequests: string[] = [];
  page.on("console", (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (
        ["create_agent_request", "agent.create.request", "workspace.create.request"].includes(
          frame.message?.type,
        )
      ) {
        createRequests.push(socket.url());
      }
    });
  });
  const kazukiId = getServerId();
  // Shortcuts settings is desktop-only. Reuse the established IPC boundary;
  // this covers the desktop renderer in Chromium, not a real Electron window.
  await installDesktopRuntime(page, {
    serverId: kazukiId,
    daemonListen: `127.0.0.1:${getE2EDaemonPort()}`,
    manageBuiltInDaemon: false,
  });
  const logHomes: Array<{ label: string; home: string }> = [];
  if (process.env.E2E_PASEO_HOME)
    logHomes.push({ label: "kazuki", home: process.env.E2E_PASEO_HOME });
  try {
    const sachi = await startIsolatedHostDaemon("srv_shortcuts_sachi");
    cleanup.push(() => sachi.close());
    logHomes.push({ label: "sachi", home: sachi.paseoHome });
    const kazukiConfig = await connectNewWorkspaceDaemonClient();
    cleanup.push(() => kazukiConfig.close());
    const previous = await kazukiConfig.getDaemonConfig();
    cleanup.push(() =>
      kazukiConfig.patchDaemonConfig({ agentProfiles: previous.config.agentProfiles ?? [] }),
    );
    const sachiConfig = await connectNewWorkspaceDaemonClient({ port: sachi.port });
    cleanup.push(() => sachiConfig.close());
    await kazukiConfig.patchDaemonConfig({ agentProfiles: KAZUKI_PROFILES });
    // Reuse the browser suite's fake Pi process only at the provider boundary.
    // Profiles, migration, keyboard dispatch and all daemon RPCs stay real.
    await sachiConfig.patchDaemonConfig({
      providers: {
        [REMOTE_PROVIDER]: {
          extends: "pi",
          label: "Shortcut Pi",
          enabled: true,
          command: [process.execPath, path.resolve("e2e/fixtures/fake-pi-rpc.mjs")],
          models: [
            {
              id: "pi-profile-model",
              label: "Pi profile model",
              description: "Remote shortcut model",
            },
          ],
        },
      },
      agentProfiles: SACHI_PROFILES,
    });
    expect((await kazukiConfig.getDaemonConfig()).config.agentProfiles).toEqual(KAZUKI_PROFILES);
    expect((await sachiConfig.getDaemonConfig()).config.agentProfiles).toEqual(SACHI_PROFILES);
    expect(KAZUKI_PROFILES[0].id).not.toBe(SACHI_PROFILES[0].id);
    const kazuki = await seedWorkspace({ repoPrefix: "shortcuts-kazuki-" });
    cleanup.push(() => kazuki.cleanup());
    const remote = await seedWorkspace({ repoPrefix: "shortcuts-sachi-", port: sachi.port });
    cleanup.push(() => remote.cleanup());
    const agents = async () =>
      Promise.all([kazuki.client.fetchAgents(), remote.client.fetchAgents()]);
    const counts = async () => (await agents()).map((result) => result.entries.length);

    await test.step("legacy bindings migrate after both disposable hosts connect", async () => {
      await gotoAppShell(page);
      await expect(
        page.getByTestId("sidebar-settings").filter({ visible: true }).first(),
      ).toBeVisible();
      await addConnectedHostsAndReload(
        page,
        [{ serverId: sachi.serverId, label: "sachi-e2e", port: sachi.port }],
        { primaryLabel: "kazuki-e2e" },
      );
      await page.evaluate(
        ({ key, bindings }) => localStorage.setItem(key, JSON.stringify(bindings)),
        {
          key: OVERRIDES_KEY,
          bindings: {
            [JSON.stringify(["agent-profile.select", kazukiId, KAZUKI_PROFILES[0].id])]:
              "Ctrl+Shift+1",
            [JSON.stringify(["agent-profile.start", kazukiId, KAZUKI_PROFILES[1].id])]:
              "Ctrl+Shift+2",
          },
        },
      );
      await reloadPreservingHostRegistry(page);
      await expect
        .poll(() => readOverrides(page))
        .toEqual({ [SELECT_ID]: "Ctrl+Shift+1", [START_ID]: "Ctrl+Shift+2" });
    });

    await test.step("one settings section shows merged host notes and migrated keys", async () => {
      await openShortcuts(page);
      const select = shortcutRow(page, SELECT_ID);
      const start = shortcutRow(page, START_ID);
      await expect(select).toContainText("Select profile: Claude");
      await expect(select.getByText("kazuki-e2e, sachi-e2e", { exact: true })).toBeVisible();
      // The shared desktop runtime fixture reports macOS, which renders symbols.
      await expect(select).toContainText("⌃⇧1");
      await expect(start).toContainText("Start agent: Pi Opus");
      await expect(start.getByText("kazuki-e2e", { exact: true })).toBeVisible();
      await expect(start).toContainText("⌃⇧2");
      await page.getByRole("button", { name: "About Agent profiles", exact: true }).hover();
      await expect(
        page.getByText("Shortcuts apply to every host's profile with the same name.", {
          exact: true,
        }),
      ).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("merged-shortcuts.png") });
      await clickSettingsBackToWorkspace(page);
    });

    async function focusWorkspace(serverId: string, workspaceId: string, draft = false) {
      await page
        .getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`)
        .filter({ visible: true })
        .first()
        .click();
      if (draft) await createAgentTabFromMenu(page);
      await expectComposerEditable(page);
      await composerLocator(page).focus();
    }

    await test.step("sachi selects its different provider and warns without creating for a missing name", async () => {
      await focusWorkspace(sachi.serverId, remote.workspaceId, true);
      await page.keyboard.press("Control+Shift+1");
      await expectComposerModel(page, "Pi profile model");
      const before = await counts();
      const requestsBefore = createRequests.length;
      await page.keyboard.press("Control+Shift+2");
      await expect(
        page.getByText("No agent profile named Pi Opus on sachi-e2e", { exact: true }),
      ).toBeVisible();
      expect(await counts()).toEqual(before);
      expect(createRequests).toHaveLength(requestsBefore);
      await page.screenshot({ path: testInfo.outputPath("missing-profile.png") });
    });

    async function startAndExpect(host: 0 | 1, combo: string, expectedCounts: number[]) {
      const clients = [kazuki.client, remote.client];
      const before = new Set(
        (await clients[host].fetchAgents()).entries.map(({ agent }) => agent.id),
      );
      // The pending toast can disappear between Playwright polls on local providers.
      // Observe its actual rendered text from before the keystroke.
      await page.evaluate(() => {
        const evidence = { seen: false };
        const observer = new MutationObserver(() => {
          if (document.body.textContent?.includes("Starting agent: Pi Opus")) evidence.seen = true;
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        Object.assign(window, { profileStartToast: { evidence, observer } });
      });
      await page.keyboard.press(combo);
      await expect.poll(counts, { timeout: 30_000 }).toEqual(expectedCounts);
      expect(
        await page.evaluate(() => {
          const toast = Reflect.get(window, "profileStartToast") as {
            evidence: { seen: boolean };
            observer: MutationObserver;
          };
          toast.observer.disconnect();
          return toast.evidence.seen;
        }),
      ).toBe(true);
      const created = (await clients[host].fetchAgents()).entries.filter(
        ({ agent }) => !before.has(agent.id),
      );
      expect(created).toHaveLength(1);
      expect(created[0].agent).toMatchObject(
        host === 0
          ? {
              provider: "mock",
              model: "ten-second-stream",
              currentModeId: "load-test",
              workspaceId: kazuki.workspaceId,
              cwd: kazuki.repoPath,
            }
          : {
              provider: REMOTE_PROVIDER,
              model: "pi-profile-model",
              currentModeId: null,
              workspaceId: remote.workspaceId,
              cwd: remote.repoPath,
            },
      );
      await expect(
        page
          .getByTestId(`workspace-tab-agent_${created[0].agent.id}`)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
    }

    await test.step("kazuki applies and starts its own configuration only", async () => {
      await focusWorkspace(kazukiId, kazuki.workspaceId, true);
      await page.keyboard.press("Control+Shift+1");
      await expectComposerModel(page, "One minute stream");
      await expectComposerMode(page, "Approval test");
      await startAndExpect(0, "Control+Shift+2", [1, 0]);
    });

    await test.step("a newly added remote profile immediately uses the existing binding", async () => {
      await sachiConfig.patchDaemonConfig({
        agentProfiles: [
          ...SACHI_PROFILES,
          {
            id: "sachi-pi-opus",
            name: "Pi Opus",
            provider: REMOTE_PROVIDER,
            model: "pi-profile-model",
          },
        ],
      });
      await openShortcuts(page);
      await expect(
        shortcutRow(page, START_ID).getByText("kazuki-e2e, sachi-e2e", { exact: true }),
      ).toBeVisible();
      await clickSettingsBackToWorkspace(page);
      await focusWorkspace(sachi.serverId, remote.workspaceId);
      await startAndExpect(1, "Control+Shift+2", [1, 1]);
    });

    await test.step("one rebind applies on both hosts and retires the old combo", async () => {
      await openShortcuts(page);
      await page.getByTestId(`shortcut-actions-${START_ID}`).click();
      await page.getByTestId(`shortcut-bind-${START_ID}`).click();
      await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(1);
      await page.keyboard.press("Control+Shift+3");
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await expect
        .poll(() => readOverrides(page))
        .toEqual({ [SELECT_ID]: "Ctrl+Shift+1", [START_ID]: "Ctrl+Shift+3" });
      await page.screenshot({ path: testInfo.outputPath("rebound-shortcuts.png") });
      await clickSettingsBackToWorkspace(page);
      for (const host of [0, 1] as const) {
        await focusWorkspace(
          host === 0 ? kazukiId : sachi.serverId,
          host === 0 ? kazuki.workspaceId : remote.workspaceId,
        );
        const requestsBefore = createRequests.length;
        const before = await counts();
        await page.keyboard.press("Control+Shift+2");
        // Observe beyond keyboard dispatch so a late accidental create is visible.
        await page.waitForTimeout(500);
        expect(await counts()).toEqual(before);
        expect(createRequests).toHaveLength(requestsBefore);
        await startAndExpect(host, "Control+Shift+3", host === 0 ? [2, 1] : [2, 2]);
      }
    });
  } finally {
    async function saveLog(name: string, body: string) {
      const logPath = testInfo.outputPath(`${name}.log`);
      await writeFile(logPath, body);
      await testInfo.attach(name, { path: logPath, contentType: "text/plain" });
    }
    await saveLog("browser-console", consoleLines.join("\n"));
    for (const { label, home } of logHomes) {
      const log = await readFile(path.join(home, "daemon.log"), "utf8").catch(() => "");
      await saveLog(`${label}-daemon`, log);
    }
    await saveLog("sandbox-homes", JSON.stringify(logHomes, null, 2));
    // Disconnect the renderer before stopping its hosts so teardown emits no lost-RPC UI.
    await page.goto("about:blank").catch(() => undefined);
    const cleanupErrors: unknown[] = [];
    for (const dispose of cleanup.toReversed()) {
      try {
        await dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    expect(cleanupErrors, "Shortcut sandbox cleanup failures").toEqual([]);
  }
});
