import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type TestInfo, type WorkerInfo } from "@playwright/test";
import { z } from "zod";
import { test as base } from "../fixtures";
import {
  createBtwRuntime,
  type BtwRuntime,
} from "../../../../server/src/server/daemon-e2e/fixtures/pi-btw-stub/runtime";
import { launchAgent } from "./rewind-flow";
import { fillComposerDraft } from "./composer";

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
export async function captureBtw(page: Page, info: TestInfo, name: string) {
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
