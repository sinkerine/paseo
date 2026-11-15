import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createHostClient } from "@getpaseo/client/node";
import { expect } from "@playwright/test";
import { chromium } from "playwright";
import { hideDeveloperToasts } from "../../app/e2e/support/developer-ui.mjs";

const require = createRequire(import.meta.url);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function observe(page) {
  return page.evaluate(() => ({
    pathname: location.pathname,
    title: [...document.querySelectorAll('[data-testid="workspace-header-title"]')].map(
      (el) => el.textContent,
    ),
    tabs: [...document.querySelectorAll('[data-testid^="workspace-tab-"][aria-selected]')].map(
      (el) => ({ id: el.getAttribute("data-testid"), selected: el.getAttribute("aria-selected") }),
    ),
    activeElement: {
      tag: document.activeElement?.tagName,
      testId: document.activeElement?.getAttribute("data-testid"),
      placeholder: document.activeElement?.getAttribute("placeholder"),
    },
    drafts: [...document.querySelectorAll("textarea")].map((el) => el.value),
    scrollTop: [...document.querySelectorAll('[data-testid="agent-chat-scroll"]')].map(
      (el) => el.scrollTop,
    ),
  }));
}

function runCli(rootDir, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(rootDir, "packages/cli/dist/index.js"), ...args],
      { cwd: rootDir, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function installLandingObserver({ trigger, text }) {
  const evidence = { trigger, text, status: "waiting", frames: [], eligibleFrames: 0 };
  window.__tabFocusLanding = evidence;
  let started = trigger === "entry";
  let atEndFrames = 0;
  const startedAt = performance.now();
  if (!started)
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter" && !event.shiftKey) started = true;
      },
      { capture: true, once: true },
    );
  const frame = (now) => {
    const root = [...document.querySelectorAll('[data-testid="agent-chat-scroll"]')].find(
      (element) => element.getClientRects().length > 0 && element.clientHeight > 0,
    );
    if (
      started &&
      root &&
      root.textContent.includes(text) &&
      root.scrollHeight - root.clientHeight > 300
    ) {
      const distanceFromEnd = Math.abs(root.scrollHeight - root.clientHeight - root.scrollTop);
      evidence.eligibleFrames++;
      evidence.frames.push({
        elapsedMs: now - startedAt,
        offset: root.scrollTop,
        height: root.scrollHeight,
        viewport: root.clientHeight,
        distanceFromEnd,
      });
      atEndFrames = distanceFromEnd <= 1 ? atEndFrames + 1 : 0;
      if (atEndFrames >= 2) {
        evidence.status = "settled";
        return;
      }
      if (evidence.eligibleFrames >= 60) {
        evidence.status = "expired";
        return;
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function chatGeometry(page) {
  return page
    .getByTestId("agent-chat-scroll")
    .filter({ visible: true })
    .first()
    .evaluate((root) => ({
      offset: root.scrollTop,
      height: root.scrollHeight,
      viewport: root.clientHeight,
      distanceFromEnd: Math.abs(root.scrollHeight - root.clientHeight - root.scrollTop),
    }));
}

function assertEndLanding(geometry) {
  assert.ok(
    geometry.height - geometry.viewport > 300,
    "Landing evidence must overflow by more than 300 px",
  );
  assert.ok(
    geometry.distanceFromEnd <= 1,
    `Foreground landing missed the end: ${JSON.stringify(geometry)}`,
  );
}

async function settledLanding(page) {
  await expect
    .poll(() => page.evaluate(() => window.__tabFocusLanding?.status), { timeout: 15_000 })
    .toBe("settled");
  const observation = await page.evaluate(() => window.__tabFocusLanding);
  assert.ok(observation.eligibleFrames <= 60, "Landing must finish within 60 eligible frames");
  assertEndLanding(observation.frames.at(-1));
  return observation;
}

async function releasedLandingGrowth(page) {
  const samples = await page
    .getByTestId("agent-chat-scroll")
    .filter({ visible: true })
    .first()
    .evaluate(async (root) => {
      for (let frame = 0; frame < 4; frame++)
        await new Promise((resolve) => requestAnimationFrame(resolve));
      const frames = [];
      const startedAt = performance.now();
      await new Promise((resolve) => {
        const frame = (now) => {
          frames.push({
            elapsedMs: now - startedAt,
            offset: root.scrollTop,
            height: root.scrollHeight,
            textLength: root.textContent.length,
          });
          if (now - startedAt >= 5_000) resolve();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      return frames;
    });
  const first = samples[0],
    last = samples.at(-1);
  assert.ok(last.elapsedMs >= 5_000, "Release must be observed for at least 5 seconds");
  assert.ok(
    last.height - first.height >= 300,
    `Expected real stream growth: ${JSON.stringify({ first, last })}`,
  );
  assert.ok(
    last.textLength > first.textLength,
    "Assistant text must grow during release observation",
  );
  assert.ok(
    samples.every((sample) => Math.abs(sample.offset - first.offset) <= 1),
    "Released landing must preserve offset within 1 px during stream growth",
  );
  return samples;
}

async function verifyForegroundLanding({ page, client, agentId, serverId, expoPort, save }) {
  const proof = {};
  try {
    await client.waitForFinish(agentId, 20_000);
    proof.initialGeometry = await chatGeometry(page);
    for (let index = 0; index < 8; index++) {
      await client.sendAgentMessage(
        agentId,
        `Landing history ${index}: emit 30 coalesced agent stream updates`,
      );
      await client.waitForFinish(agentId, 20_000);
    }
    await client.setAgentModel(agentId, "ten-second-stream");
    proof.preparedGeometry = await chatGeometry(page);
    proof.model = (await client.fetchAgent({ agentId })).agent.model;
    await expect
      .poll(async () => {
        const geometry = await chatGeometry(page);
        return geometry.height - geometry.viewport;
      })
      .toBeGreaterThan(300);
    await page.getByTestId("agent-chat-scroll").filter({ visible: true }).first().hover();
    await page.mouse.wheel(0, -100_000);
    await expect.poll(async () => (await chatGeometry(page)).distanceFromEnd).toBeGreaterThan(300);
    proof.invalidObservedPosition = await chatGeometry(page);
    assert.throws(
      () => assertEndLanding(proof.invalidObservedPosition),
      /Foreground landing missed the end/,
      "Negative control must reject a real invalid reading position",
    );
    proof.negativeControl = "rejected invalid observed position";
    const prompt = "Observe foreground Send landing";
    await page.evaluate(installLandingObserver, { trigger: "send", text: prompt });
    await page.getByRole("textbox", { name: "Message agent..." }).first().fill(prompt);
    await page.getByRole("textbox", { name: "Message agent..." }).first().press("Enter");
    proof.send = await settledLanding(page);
    proof.sendGrowth = await releasedLandingGrowth(page);
    await client.waitForFinish(agentId, 20_000);
    await page.addInitScript(installLandingObserver, { trigger: "entry", text: prompt });
    await page.goto(`http://localhost:${expoPort}/h/${serverId}/agent/${agentId}`, {
      waitUntil: "commit",
    });
    await expect(page.getByTestId(`workspace-tab-agent_${agentId}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    proof.entry = await settledLanding(page);
    await client.sendAgentMessage(agentId, "Remote output after foreground entry");
    proof.entryGrowth = await releasedLandingGrowth(page);
    await client.waitForFinish(agentId, 20_000);
  } finally {
    proof.lastLandingObservation = await page
      .evaluate(() => window.__tabFocusLanding)
      .catch(() => null);
    save("j8-foreground-landing.json", proof);
  }
}

export async function runTabFocusMultiwindowRegression(input) {
  const {
    page: initialPage,
    browser,
    daemonPort,
    expoPort,
    serverId,
    workspaceIds,
    workspaceRoot,
    userData,
    runtimeDir,
    artifactDir,
    rootDir,
    commonEnv,
    evaluateMain,
    inspectorPort,
    cdpPort,
    stopElectron,
    targetUrl,
  } = input;
  let page = initialPage;
  let activeBrowser = browser;
  const client = createHostClient(`127.0.0.1:${daemonPort}`, {
    clientId: "tab-focus-e2e",
    clientType: "cli",
    reconnect: { enabled: false },
  });
  await client.connect();
  const save = (name, data) =>
    fs.writeFileSync(path.join(artifactDir, name), JSON.stringify(data, null, 2));
  try {
    const createAgent = async (index, title, parentAgentId) =>
      await client.createAgent({
        provider: "mock",
        model: "e2e-fast-stream",
        modeId: "load-test",
        workspaceId: workspaceIds[index],
        cwd: path.join(workspaceRoot, `workspace-${index + 1}`),
        title,
        ...(parentAgentId ? { labels: { "paseo.parent-agent-id": parentAgentId } } : {}),
        initialPrompt: Array.from({ length: 100 }, (_, i) => `Reading ${title} note ${i}`).join(
          "\n",
        ),
      });
    const a = await createAgent(0, "Chat A1");
    const b = await createAgent(1, "Chat B1");
    await client.waitForFinish(a.id, 20_000);
    for (let turn = 0; turn < 4; turn++) {
      await client.sendAgentMessage(
        a.id,
        `Reading turn ${turn}: emit 30 coalesced agent stream updates`,
      );
      await client.waitForFinish(a.id, 20_000);
    }
    const open = async (target, agent, index) => {
      await target.goto(`http://localhost:${expoPort}/h/${serverId}/agent/${agent.id}`, {
        waitUntil: "commit",
      });
      await expect(
        target.getByTestId("workspace-header-title").filter({ visible: true }),
      ).toHaveText(`Desktop browser workspace ${index + 1}`, { timeout: 90_000 });
      await expect(target.getByTestId(`workspace-tab-agent_${agent.id}`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(
        target.getByRole("textbox", { name: "Message agent..." }).first(),
      ).toBeEditable();
    };
    await page.addInitScript(() =>
      localStorage.setItem(
        "@paseo:create-agent-preferences",
        JSON.stringify({
          provider: "mock",
          providerPreferences: { mock: { model: "e2e-fast-stream" } },
        }),
      ),
    );
    await open(page, a, 0);
    let [second] = await Promise.all([
      browser.contexts()[0].waitForEvent("page"),
      page.evaluate(
        (projectPath) =>
          window.paseoDesktop.window.openNew({ pendingOpenProjectPath: projectPath }),
        path.join(workspaceRoot, "workspace-2"),
      ),
    ]);
    await hideDeveloperToasts(second);
    await open(second, b, 1);
    const windows = await evaluateMain(
      "return process.mainModule.require('electron').BrowserWindow.getAllWindows().map(w => ({ id: w.webContents.id, url: w.webContents.getURL() }));",
    );
    assert.equal(windows.length, 2);
    assert.notEqual(windows[0].id, windows[1].id);
    await evaluateMain(
      "globalThis.__tabFocusWindowEvents = []; for (const candidate of process.mainModule.require('electron').BrowserWindow.getAllWindows()) { for (const eventName of ['focus', 'blur']) candidate.on(eventName, () => globalThis.__tabFocusWindowEvents.push({ id: candidate.webContents.id, event: eventName, at: Date.now() })); } return true;",
    );
    const controls = [];
    for (const candidate of windows.toReversed()) {
      await evaluateMain(
        `process.mainModule.require('electron').BrowserWindow.fromWebContents(process.mainModule.require('electron').webContents.fromId(${candidate.id})).focus(); return true;`,
      );
      await delay(200);
      controls.push({
        requested: candidate.id,
        focused: await evaluateMain(
          "return process.mainModule.require('electron').BrowserWindow.getFocusedWindow()?.webContents.id ?? null;",
        ),
      });
    }
    save("focus-controls.json", {
      controls,
      events: await evaluateMain("return globalThis.__tabFocusWindowEvents;"),
      display: await evaluateMain("return process.env.DISPLAY;"),
    });
    if (process.env.PASEO_DESKTOP_E2E_WINDOW_MANAGER)
      for (const control of controls)
        assert.equal(control.focused, control.requested, "positive OS focus control");
    const secondId = windows.find((win) => win.url.includes(workspaceIds[1]))?.id;
    assert.equal(typeof secondId, "number");
    await page
      .getByRole("textbox", { name: "Message agent..." })
      .first()
      .fill("Reviewing A1 notes");
    await page
      .getByTestId("agent-chat-scroll")
      .filter({ visible: true })
      .first()
      .evaluate((el) => {
        el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 250);
      });
    await evaluateMain(
      `process.mainModule.require('electron').BrowserWindow.fromWebContents(process.mainModule.require('electron').webContents.fromId(${secondId})).focus(); return true;`,
    );
    await second
      .getByRole("textbox", { name: "Message agent..." })
      .first()
      .fill("Typing in Window 2");
    await second.getByRole("textbox", { name: "Message agent..." }).first().focus();
    const target = await createAgent(0, "Agent A-Sub", a.id);
    const display = await evaluateMain("return process.env.DISPLAY;");
    const cliHome = path.join(runtimeDir, "cli-home");
    fs.mkdirSync(path.join(cliHome, "Applications"), { recursive: true });
    const electron = require("electron");
    fs.writeFileSync(
      path.join(cliHome, "Applications/Paseo.AppImage"),
      `#!/bin/sh\nexec ${quote(electron)} --no-sandbox --ozone-platform=x11 --inspect=127.0.0.1:${inspectorPort} --remote-debugging-port=${cdpPort} ${quote(path.join(rootDir, "packages/desktop"))} "$@" >> ${quote(path.join(artifactDir, "cli-desktop.log"))} 2>&1\n`,
      { mode: 0o755 },
    );
    await evaluateMain(
      "globalThis.__tabFocusSecondInstances = []; process.mainModule.require('electron').app.on('second-instance', (_event, argv) => globalThis.__tabFocusSecondInstances.push(argv)); return true;",
    );
    const before = {
      focused: await evaluateMain(
        "return process.mainModule.require('electron').BrowserWindow.getFocusedWindow()?.webContents.id ?? null;",
      ),
      a: await observe(page),
      b: await observe(second),
    };
    save("p2-readiness.json", { windows, before, daemonPort, expoPort, userData });
    const result = await runCli(
      rootDir,
      ["agent", "open", target.id, "--host", `127.0.0.1:${daemonPort}`, "--json"],
      {
        ...commonEnv,
        HOME: cliHome,
        DISPLAY: display,
        PASEO_AGENT_ID: a.id,
        PASEO_ELECTRON_USER_DATA_DIR: userData,
        EXPO_DEV_URL: `http://localhost:${expoPort}`,
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "opened");
    const samples = [];
    for (let i = 0; i < 15; i++) {
      samples.push({
        at: Date.now(),
        focused: await evaluateMain(
          "return process.mainModule.require('electron').BrowserWindow.getFocusedWindow()?.webContents.id ?? null;",
        ),
        a: await observe(page),
        b: await observe(second),
      });
      await delay(100);
    }
    const instances = await evaluateMain("return globalThis.__tabFocusSecondInstances;");
    save("p2-observations.json", { before, result, samples, instances, target });
    await page.screenshot({ path: path.join(artifactDir, "p2-window-a.png") });
    await second.screenshot({ path: path.join(artifactDir, "p2-window-b.png") });
    await expect(page.getByTestId(`workspace-tab-agent_${target.id}`)).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await open(second, b, 1);
    await evaluateMain(
      `process.mainModule.require('electron').BrowserWindow.fromWebContents(process.mainModule.require('electron').webContents.fromId(${secondId})).focus(); return true;`,
    );
    const humanEnv = {
      ...commonEnv,
      WAYLAND_DISPLAY: "",
      HOME: cliHome,
      DISPLAY: display,
      PASEO_ELECTRON_USER_DATA_DIR: userData,
      EXPO_DEV_URL: `http://localhost:${expoPort}`,
    };
    delete humanEnv.PASEO_AGENT_ID;
    const humanResult = await runCli(
      rootDir,
      ["agent", "open", target.id, "--host", `127.0.0.1:${daemonPort}`, "--json"],
      humanEnv,
    );
    await expect(page.getByTestId(`workspace-tab-agent_${target.id}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const humanSamples = [];
    for (let i = 0; i < 15; i++) {
      humanSamples.push({
        at: Date.now(),
        focused: await evaluateMain(
          "return process.mainModule.require('electron').BrowserWindow.getFocusedWindow()?.webContents.id ?? null;",
        ),
        a: await observe(page),
        b: await observe(second),
      });
      await delay(100);
    }
    save("p2-human-observations.json", { humanResult, humanSamples });
    assert.equal(instances.length, 1, "real CLI must reach second-instance");
    for (const sample of samples) {
      assert.equal(sample.focused, secondId);
      assert.deepEqual(sample.b, before.b);
      assert.equal(sample.a.pathname, before.a.pathname);
      assert.deepEqual(sample.a.drafts, before.a.drafts);
      assert.deepEqual(sample.a.scrollTop, before.a.scrollTop);
    }
    assert.equal(humanResult.code, 0);
    const firstId = windows.find((win) => win.url.includes(workspaceIds[0])).id;
    for (const sample of humanSamples) {
      assert.equal(sample.focused, firstId);
      assert.ok(sample.b.pathname.endsWith(workspaceIds[1]));
    }
    await expect(page.getByTestId(`workspace-tab-agent_${target.id}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const journeys = ["J1", "J4-human"];
    const cli = async (agentId, flags = [], caller) => {
      const env = { ...humanEnv };
      if (caller) env.PASEO_AGENT_ID = caller;
      const response = await runCli(
        rootDir,
        ["agent", "open", agentId, ...flags, "--host", `127.0.0.1:${daemonPort}`, "--json"],
        env,
      );
      assert.equal(response.code, 0, response.stderr);
      assert.equal(JSON.parse(response.stdout).status, "opened");
      return response;
    };
    const focusedId = () =>
      evaluateMain(
        "return process.mainModule.require('electron').BrowserWindow.getFocusedWindow()?.webContents.id ?? null;",
      );
    const focusWindow = (id) =>
      evaluateMain(
        `process.mainModule.require('electron').BrowserWindow.fromWebContents(process.mainModule.require('electron').webContents.fromId(${id})).focus(); return true;`,
      );
    const selected = (snapshot) =>
      snapshot.tabs.filter((tab) => tab.selected === "true").map((tab) => tab.id);
    const backgroundOpen = async (label, agent, caller) => {
      await focusWindow(secondId);
      await second.getByRole("textbox", { name: "Message agent..." }).first().focus();
      const initial = {
        focused: await focusedId(),
        a: await observe(page),
        b: await observe(second),
      };
      const response = await cli(agent.id, caller ? [] : ["--no-focus"], caller);
      const observations = [];
      for (let i = 0; i < 15; i++) {
        observations.push({
          at: Date.now(),
          focused: await focusedId(),
          a: await observe(page),
          b: await observe(second),
        });
        await delay(100);
      }
      save(`${label}.json`, { initial, response, observations });
      for (const sample of observations) {
        assert.equal(sample.focused, initial.focused);
        assert.deepEqual(sample.b, initial.b);
        assert.equal(sample.a.pathname, initial.a.pathname);
        assert.deepEqual(selected(sample.a), selected(initial.a));
        assert.deepEqual(sample.a.drafts, initial.a.drafts);
        assert.deepEqual(sample.a.scrollTop, initial.a.scrollTop);
      }
    };
    await expect
      .poll(async () =>
        Object.entries((await client.fetchAgent({ agentId: target.id })).agent.labels ?? {}).some(
          ([key, value]) => key.startsWith("paseo.open-agent-tab.") && value === "true",
        ),
      )
      .toBe(true);
    await page.getByTestId(`workspace-tab-agent_${a.id}`).click();
    await backgroundOpen("j2-no-focus", a);
    await backgroundOpen("j2-repeat", target);
    await expect(page.getByTestId(`workspace-tab-agent_${target.id}`)).toHaveCount(1);
    journeys.push("J2");

    const c = await createAgent(2, "Unseen C root");
    const unseen = await createAgent(2, "Unseen C child", c.id);
    await evaluateMain(
      `process.mainModule.require('electron').BrowserWindow.fromWebContents(process.mainModule.require('electron').webContents.fromId(${firstId})).minimize(); return true;`,
    );
    await backgroundOpen("j3a-unseen-minimized", unseen);
    assert.equal(
      await evaluateMain(
        `return process.mainModule.require('electron').BrowserWindow.fromWebContents(process.mainModule.require('electron').webContents.fromId(${firstId})).isMinimized();`,
      ),
      true,
    );
    await evaluateMain(
      `process.mainModule.require('electron').BrowserWindow.fromWebContents(process.mainModule.require('electron').webContents.fromId(${firstId})).restore(); return true;`,
    );
    await page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceIds[2]}`).click();
    await expect(page.getByTestId(`workspace-tab-agent_${unseen.id}`)).toBeVisible();
    assert.equal(
      await page.evaluate(
        ({ key, id }) => {
          const state = JSON.parse(localStorage.getItem("workspace-layout-state")).state;
          return JSON.stringify(state.layoutByWorkspace[key]).includes(id);
        },
        { key: `${serverId}:${workspaceIds[2]}`, id: unseen.id },
      ),
      true,
    );

    await open(page, a, 0);
    const archived = await createAgent(0, "Archived background child", a.id);
    await client.archiveAgent(archived.id);
    await backgroundOpen("j3b-archived", archived);
    await expect(page.getByTestId(`workspace-tab-agent_${archived.id}`)).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await page.getByTestId(`workspace-tab-agent_${archived.id}`).click();
    await expect(page.getByRole("button", { name: "Unarchive", exact: true })).toBeVisible();
    await page.getByTestId(`workspace-tab-agent_${a.id}`).click();
    journeys.push("J3a", "J3b");
    await focusWindow(secondId);
    await cli(a.id, ["--focus"], a.id);
    await expect.poll(focusedId).toBe(firstId);
    await expect(page.getByTestId(`workspace-tab-agent_${a.id}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    journeys.push("J4-override");

    await evaluateMain(
      `process.mainModule.require('electron').BrowserWindow.fromWebContents(process.mainModule.require('electron').webContents.fromId(${firstId})).setSize(1920,1080); return true;`,
    );
    await page.getByTestId("sidebar-search").click();
    await page.getByTestId("command-center-input").fill("Split pane right");
    await page.getByText("Split pane right", { exact: true }).click();
    const launcher = page.locator('[data-testid^="workspace-tab-tab_"][aria-selected="true"]');
    await expect(launcher).toHaveCount(1);
    const launcherId = await launcher.getAttribute("data-testid");
    await client.setAgentModel(b.id, "ten-second-stream");
    await second.getByTestId(`workspace-tab-agent_${b.id}`).click();
    await second.getByRole("textbox", { name: "Message agent..." }).first().focus();
    await client.sendAgentMessage(b.id, "Stream while background tabs arrive");
    const streamBefore = await observe(second);
    const rootCli = await runCli(
      rootDir,
      [
        "run",
        "--no-wait",
        "--provider",
        "mock/e2e-fast-stream",
        "--mode",
        "load-test",
        "--workspace",
        workspaceIds[0],
        "--name",
        "CLI reconciled root",
        "--host",
        `127.0.0.1:${daemonPort}`,
        "--json",
        "emit 1 coalesced agent stream updates",
      ],
      humanEnv,
    );
    assert.equal(rootCli.code, 0, rootCli.stderr);
    const rootAId = JSON.parse(rootCli.stdout).id ?? JSON.parse(rootCli.stdout).agentId;
    const rootB = await createAgent(1, "Reconciled B root");
    const terminal = await client.createTerminal(
      path.join(workspaceRoot, "workspace-1"),
      "Reconciled terminal",
      undefined,
      { workspaceId: workspaceIds[0] },
    );
    assert.equal(terminal.error, null);
    await expect(
      page.getByTestId("workspace-pane-main").getByTestId(`workspace-tab-agent_${rootAId}`),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("workspace-pane-main")
        .getByTestId(`workspace-tab-terminal_${terminal.terminal.id}`),
    ).toBeVisible();
    await expect(page.getByTestId(launcherId)).toHaveAttribute("aria-selected", "true");
    await expect(second.getByTestId(`workspace-tab-agent_${rootB.id}`)).toHaveAttribute(
      "aria-selected",
      "false",
    );
    const streamSamples = [];
    for (let i = 0; i < 15; i++) {
      streamSamples.push(await observe(second));
      await delay(100);
    }
    save("j5-stream.json", { streamBefore, streamSamples });
    for (const sample of streamSamples) {
      assert.deepEqual(selected(sample), selected(streamBefore));
      assert.deepEqual(sample.activeElement, streamBefore.activeElement);
      assert.deepEqual(sample.drafts, streamBefore.drafts);
      sample.scrollTop.forEach((offset, index) =>
        assert.ok(Math.abs(offset - streamBefore.scrollTop[index]) <= 1),
      );
    }
    await client.waitForFinish(b.id, 20_000);
    journeys.push("J5");

    await open(page, a, 0);
    const newFromMenu = async (kind) => {
      await page.getByTestId("workspace-pane-main").getByTestId("workspace-new-tab-button").click();
      await page.getByTestId(`workspace-new-tab-menu-${kind}`).click();
    };
    await newFromMenu("browser");
    const browserChip = page.locator(
      '[data-testid^="workspace-tab-browser_"][aria-selected="true"]',
    );
    await expect(browserChip).toHaveCount(1);
    const browserId = (await browserChip.getAttribute("data-testid")).slice(
      "workspace-tab-browser_".length,
    );
    const address = page.getByRole("textbox", { name: "Browser URL", exact: true });
    await address.fill(targetUrl);
    await address.press("Enter");
    const guest = page.locator(`[data-paseo-browser-id="${browserId}"]`);
    await expect.poll(() => guest.evaluate((el) => el.getURL())).toBe(targetUrl);
    await page.getByTestId(`workspace-tab-agent_${a.id}`).click();
    await page.getByRole("textbox", { name: "Message agent..." }).first().focus();
    const browserBefore = await observe(page);
    await guest.evaluate(
      (el, url) => el.executeJavaScript(`window.open(${JSON.stringify(url)}, '_blank')`),
      `${targetUrl}?unfocused`,
    );
    await expect(page.locator('[data-testid^="workspace-tab-browser_"]')).toHaveCount(2);
    await expect(page.getByTestId(`workspace-tab-agent_${a.id}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    assert.deepEqual((await observe(page)).activeElement, browserBefore.activeElement);
    await page.getByTestId(`workspace-tab-browser_${browserId}`).click();
    await guest.evaluate(
      (el, url) =>
        el.executeJavaScript(
          `document.body.innerHTML = '<a id="background-link" style="display:block;position:absolute;left:10px;top:10px;width:200px;height:40px" href="${url}" target="_blank">Background link</a>'; true`,
        ),
      `${targetUrl}?middle`,
    );
    const guestId = await guest.evaluate((el) => el.getWebContentsId());
    await evaluateMain(
      `const guest = process.mainModule.require('electron').webContents.fromId(${guestId}); guest.sendInputEvent({ type: 'mouseDown', x: 40, y: 25, button: 'middle', clickCount: 1 }); guest.sendInputEvent({ type: 'mouseUp', x: 40, y: 25, button: 'middle', clickCount: 1 }); return true;`,
    );
    await expect(page.locator('[data-testid^="workspace-tab-browser_"]')).toHaveCount(3);
    await expect(page.getByTestId(`workspace-tab-browser_${browserId}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await guest.evaluate(
      (el, url) => el.executeJavaScript(`window.open(${JSON.stringify(url)}, '_blank')`),
      `${targetUrl}?foreground`,
    );
    await expect(page.locator('[data-testid^="workspace-tab-browser_"]')).toHaveCount(4);
    await expect(page.getByTestId(`workspace-tab-browser_${browserId}`)).toHaveAttribute(
      "aria-selected",
      "false",
    );
    journeys.push("J6");

    await page.getByTestId(`workspace-tab-agent_${target.id}`).click();
    await second.getByTestId(`workspace-tab-agent_${rootB.id}`).click();
    await page.reload();
    await second.reload();
    await expect(page.getByTestId(`workspace-tab-agent_${target.id}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(second.getByTestId(`workspace-tab-agent_${rootB.id}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    journeys.push("J7");
    await newFromMenu("agent");
    const draft = page.locator('[data-testid^="workspace-tab-draft_"][aria-selected="true"]');
    await expect(draft).toHaveCount(1);
    await page
      .getByRole("textbox", { name: "Message agent..." })
      .first()
      .fill("Create foreground landing chat");
    await page.getByRole("textbox", { name: "Message agent..." }).first().press("Enter");
    await expect(draft).toHaveCount(0);
    await expect(
      page
        .locator('[data-testid^="workspace-tab-agent_"][aria-selected="true"]')
        .filter({ visible: true }),
    ).toHaveCount(1);
    const createdAgentChip = page
      .locator('[data-testid^="workspace-tab-agent_"][aria-selected="true"]')
      .filter({ visible: true });
    const createdAgentId = (await createdAgentChip.getAttribute("data-testid")).slice(
      "workspace-tab-agent_".length,
    );
    await verifyForegroundLanding({
      page,
      client,
      agentId: createdAgentId,
      serverId,
      expoPort,
      save,
    });
    await newFromMenu("terminal");
    await expect(
      page
        .locator('[data-testid^="workspace-tab-terminal_"][aria-selected="true"]')
        .filter({ visible: true }),
    ).toHaveCount(1);
    await newFromMenu("browser");
    await expect(
      page
        .locator('[data-testid^="workspace-tab-browser_"][aria-selected="true"]')
        .filter({ visible: true }),
    ).toHaveCount(1);
    journeys.push("J8");
    save("journey-checkpoint.json", { journeys, a: await observe(page), b: await observe(second) });

    const cold = await createAgent(0, "Cold background child", a.id);
    await open(second, b, 1);
    await expect
      .poll(() =>
        second.evaluate(() => localStorage.getItem("paseo:last-workspace-route-selection")),
      )
      .toContain(workspaceIds[1]);
    save("j3c-before-shutdown.json", {
      a: await observe(page),
      b: await observe(second),
      remembered: await second.evaluate(() =>
        localStorage.getItem("paseo:last-workspace-route-selection"),
      ),
    });
    await evaluateMain(
      "for (const candidate of process.mainModule.require('electron').BrowserWindow.getAllWindows()) candidate.webContents.session.flushStorageData(); return true;",
    );
    stopElectron();
    await expect
      .poll(
        async () => {
          try {
            await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 30_000 },
      )
      .toBe(false);
    await cli(cold.id, ["--no-focus"]);
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok;
          } catch {
            return false;
          }
        },
        { timeout: 90_000 },
      )
      .toBe(true);
    activeBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    await expect
      .poll(
        () =>
          activeBrowser
            .contexts()[0]
            .pages()
            .filter((candidate) => candidate.url().includes(`localhost:${expoPort}`)).length,
      )
      .toBe(1);
    page = activeBrowser
      .contexts()[0]
      .pages()
      .find((candidate) => candidate.url().includes(`localhost:${expoPort}`));
    await expect(page.getByTestId("workspace-header-title").filter({ visible: true })).toHaveText(
      "Desktop browser workspace 2",
      { timeout: 90_000 },
    );
    await expect(page.getByTestId(`workspace-tab-agent_${b.id}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect
      .poll(() =>
        page.evaluate(
          (id) => localStorage.getItem("workspace-layout-state")?.includes(id),
          cold.id,
        ),
      )
      .toBe(true);
    assert.ok(new URL(page.url()).pathname.endsWith(workspaceIds[1]));
    save("j3c-restored.json", {
      renderer: await observe(page),
      remembered: await page.evaluate(() =>
        localStorage.getItem("paseo:last-workspace-route-selection"),
      ),
    });
    await page.goto(`http://localhost:${expoPort}/h/${serverId}/workspace/${workspaceIds[0]}`);
    await expect(page.getByTestId(`workspace-tab-agent_${cold.id}`)).toBeVisible();
    journeys.push("J3c");
    await page.screenshot({ path: path.join(artifactDir, "cold-launch.png") });
    save("journeys.json", { journeys });
    return { journeys, secondInstance: true, windows, result };
  } catch (error) {
    save("failure.json", { message: String(error), window: await observe(page).catch(() => null) });
    await page.screenshot({ path: path.join(artifactDir, "failure.png") }).catch(() => undefined);
    throw error;
  } finally {
    if (activeBrowser !== browser) {
      await evaluateMain(
        "setTimeout(() => process.mainModule.require('electron').app.quit(), 50); return true;",
      ).catch(() => undefined);
      await activeBrowser.close().catch(() => undefined);
    }
    for (const workspaceId of workspaceIds) {
      const { terminals } = await client.listTerminals(undefined, undefined, { workspaceId });
      for (const terminal of terminals) await client.killTerminal(terminal.id);
    }
    await client.close();
  }
}
