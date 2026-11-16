import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, type TestInfo, type WorkerInfo } from "@playwright/test";
import { z } from "zod";
import { test as base } from "../fixtures";
import {
  createBtwRuntime,
  type BtwRuntime,
} from "../../../../server/src/server/daemon-e2e/fixtures/pi-btw-stub/runtime";
import { launchAgent } from "./rewind-flow";
import { fillComposerDraft } from "./composer";
import { waitForSettledPosition } from "./sheet-layout";

export function btwBrowserTest(live: boolean, includeBtwExtension = true) {
  return base.extend<{}, { btwRuntime: BtwRuntime }>({
    btwRuntime: [
      async ({ browserName }, provide, workerInfo) => {
        expect(browserName).toBe("chromium");
        const runtime = await createBtwRuntime(live);
        try {
          if (!includeBtwExtension) {
            const settingsFile = path.join(runtime.piAgent, "settings.json");
            const settings = JSON.parse(await readFile(settingsFile, "utf8"));
            await writeFile(settingsFile, JSON.stringify({ ...settings, packages: [] }));
          }
          await provide(runtime);
        } finally {
          try {
            await persistBtwRuntimeEvidence(runtime, workerInfo);
          } finally {
            await runtime.close();
          }
        }
      },
      { scope: "worker" },
    ],
    e2eDaemonConfig: async ({ btwRuntime }, provide) => provide(btwRuntime.daemonConfig),
    e2eDaemonEnvironment: async ({ btwRuntime }, provide) => provide(btwRuntime.environment),
  });
}
async function persistBtwRuntimeEvidence(runtime: BtwRuntime, info: WorkerInfo) {
  const output = info.project.outputDir;
  await mkdir(output, { recursive: true });
  await writeFile(
    path.join(output, `btw-runtime-worker-${info.workerIndex}.json`),
    JSON.stringify(
      {
        live: runtime.stub === null,
        piBinary: runtime.piBinary,
        revision: runtime.revision,
        model: runtime.model,
        packages: z
          .object({ packages: z.array(z.string()) })
          .parse(JSON.parse(await readFile(path.join(runtime.piAgent, "settings.json"), "utf8")))
          .packages,
      },
      null,
      2,
    ),
  );
  try {
    const events = await readFile(runtime.events, "utf8");
    await writeFile(
      path.join(output, `btw-thread-events-worker-${info.workerIndex}.jsonl`),
      events,
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
export async function launchBtwAgent(page: Page, runtime: BtwRuntime) {
  const cwd = await mkdtemp(path.join(runtime.root, "work-"));
  return launchAgent({
    page,
    cwd,
    provider: "pi",
    mode: "full-access",
    providerConfig: { model: runtime.model },
  });
}
export async function closeBtwSurface(page: Page, agentId: string, compact: boolean) {
  if (compact) {
    await page
      .getByTestId("sheet-tab-header")
      .getByRole("button", { name: "Close", exact: true })
      .click();
  } else {
    await page.getByTestId(`workspace-tab-btw_${agentId}`).hover();
    await page.getByTestId(`workspace-btw-close-${agentId}`).click();
  }
  await expect(page.getByTestId("btw-panel").filter({ visible: true })).toHaveCount(0);
}

export async function btwScrollFrames(scroller: Locator, frames = 60) {
  return scroller.evaluate(async (element, count) => {
    const samples = [];
    for (let frame = 0; frame < count; frame++) {
      await new Promise<number>(requestAnimationFrame);
      const viewport = element.getBoundingClientRect();
      samples.push({
        frame,
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        rows: Array.from(element.querySelectorAll("[data-history-row-id]"), (row) => {
          const box = row.getBoundingClientRect();
          return {
            id: row.getAttribute("data-history-row-id"),
            top: box.top,
            bottom: box.bottom,
            inViewport: box.bottom > viewport.top && box.top < viewport.bottom,
          };
        }),
      });
    }
    return samples;
  }, frames);
}

export async function waitForBtwViewportSettled(scroller: Locator) {
  await expect
    .poll(async () => {
      const frames = await btwScrollFrames(scroller, 8);
      const first = frames[0];
      return (
        first !== undefined &&
        frames.every(
          (frame) =>
            Math.abs(frame.scrollTop - first.scrollTop) <= 1 &&
            frame.scrollHeight === first.scrollHeight &&
            frame.clientHeight === first.clientHeight,
        )
      );
    })
    .toBe(true);
}

export function expectBtwViewportHeld(
  baseline: Awaited<ReturnType<typeof btwScrollFrames>>[number],
  frames: Awaited<ReturnType<typeof btwScrollFrames>>,
) {
  const anchor = baseline.rows.find((row) => row.inViewport);
  if (!anchor?.id) throw new Error("Missing visible history row after entry settlement");
  for (const frame of frames) {
    expect(Math.abs(frame.scrollTop - baseline.scrollTop)).toBeLessThanOrEqual(1);
    const row = frame.rows.find((candidate) => candidate.id === anchor.id);
    if (!row) throw new Error("Settled history anchor disappeared");
    expect(Math.abs(row.top - anchor.top)).toBeLessThanOrEqual(1);
  }
}

export async function btwViewportGeometry(target: Locator) {
  return target.evaluate((element) => {
    const window = element.closest('[data-testid="btw-panel"]');
    const scroller = window?.querySelector('[data-testid="agent-chat-scroll"]');
    if (!(scroller instanceof HTMLElement)) throw new Error("Missing BTW scroll viewport");
    const viewport = scroller.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      viewport: { top: viewport.top, bottom: viewport.bottom },
      target: { top: bounds.top, bottom: bounds.bottom },
      inViewport: bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1,
      running: window?.querySelector('[data-testid="btw-stop"]') !== null,
      rows: Array.from(scroller.querySelectorAll("[data-history-row-id]"), (row) => ({
        id: row.getAttribute("data-history-row-id"),
        top: row.getBoundingClientRect().top,
        height: row.getBoundingClientRect().height,
        text: row.textContent,
      })),
    };
  });
}
export async function expectBtwTextInViewport(target: Locator) {
  await expect(target).toBeVisible();
  await expect.poll(async () => (await btwViewportGeometry(target)).inViewport).toBe(true);
  await target.evaluate(async () => {
    for (let frame = 0; frame < 4; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  expect((await btwViewportGeometry(target)).inViewport).toBe(true);
}
export async function revealBtwText(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  const window = page.getByTestId("btw-panel").filter({ visible: true });
  await expect(window).toHaveCount(1);
  await expect(window.getByTestId("btw-stop")).toHaveCount(0);
  await waitForSettledPosition(window);
  // Land at the current end so the floating jump control cannot cover a visible answer.
  const geometry = await btwViewportGeometry(target);
  const distanceFromEnd = geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop;
  const jump = window.getByTestId("scroll-to-bottom-button");
  if (distanceFromEnd > 1) await jump.click({ timeout: 10000 });
  await expect
    .poll(async () => {
      const next = await btwViewportGeometry(target);
      return next.scrollHeight - next.clientHeight - next.scrollTop;
    })
    .toBeLessThanOrEqual(1);
  await expect(jump).toHaveCount(0);
  await expectBtwTextInViewport(target);
}
export async function captureBtw(page: Page, info: TestInfo, name: string) {
  const panel = page.getByTestId("btw-panel").filter({ visible: true });
  if ((await panel.count()) > 0) await waitForSettledPosition(panel);
  const screenshot = info.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot });
  await info.attach(name, { path: screenshot, contentType: "image/png" });
}
const EventSchema = z.object({
  type: z.literal("state"),
  thread: z
    .object({
      threadId: z.string(),
      status: z.string(),
      revision: z.number(),
      boundary: z.object({
        parentLeafEntryId: z.string().nullable(),
        parentTurnIndex: z.number().nullable(),
        prefixDigest: z.string(),
      }),
    })
    .passthrough(),
});
export async function recordedBtwStates(runtime: BtwRuntime) {
  const lines = (await readFile(runtime.events, "utf8")).trim().split("\n");
  return lines.flatMap((line) => {
    const parsed = EventSchema.safeParse(JSON.parse(line));
    return parsed.success ? [parsed.data.thread] : [];
  });
}
export async function askBtwFromRunningMainComposer(page: Page, question: string) {
  await fillComposerDraft(page, `/btw ${question}`);
  await page.getByRole("button", { name: "Send and steer", exact: true }).click({ timeout: 15000 });
}
export async function askBtw(page: Page, question: string) {
  await page.getByTestId("btw-composer").filter({ visible: true }).fill(question);
  await page.getByTestId("btw-send").filter({ visible: true }).click();
}

export function btwRequests(runtime: BtwRuntime) {
  if (!runtime.stub) throw new Error("Missing deterministic HTTP fixture");
  return runtime.stub.requests.filter((request) =>
    JSON.stringify(request.messages).includes("<btw>"),
  );
}

export async function pressBtwComposerKey(page: Page, shortcut: string) {
  await page.getByTestId("btw-composer").filter({ visible: true }).press(shortcut);
}
