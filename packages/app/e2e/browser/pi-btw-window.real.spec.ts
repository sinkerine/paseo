import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { closeAgent } from "../support/helpers/rewind-flow";
import { submitMessageWithButton } from "../support/helpers/composer";
import {
  askBtw,
  askBtwFromRunningMainComposer,
  btwBrowserTest,
  captureBtw,
  launchBtwAgent,
  recordedBtwStates,
} from "../support/helpers/pi-btw";

const test = btwBrowserTest(true);
test("real Pi and configured provider answer from finished parent context while it runs, then auto-pin its newer turn", async ({
  page,
  btwRuntime,
}, info) => {
  test.setTimeout(480000);
  const tokenA = `RECORD_A_${randomUUID()}`;
  const tokenB = `RECORD_B_${randomUUID()}`;
  const handle = await launchBtwAgent(page, btwRuntime);
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "btw-live-proof" });
  const window = page.getByTestId("btw-window").filter({ visible: true });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await submitMessageWithButton(
      page,
      `Remember the current record token is ${tokenA}. Reply with that token only. Do not run tools.`,
    );
    await expect(page.getByTestId("assistant-message").filter({ hasText: tokenA })).toBeVisible({
      timeout: 120000,
    });
    await handle.client.waitForFinish(handle.agentId, 120000);
    // The parent owns this gated tool. BTW must use A until the whole B tool batch completes.
    await submitMessageWithButton(
      page,
      `The next record token is ${tokenB}. Run a shell tool with this exact command and wait for it to finish: while [ ! -f "${btwRuntime.gate}" ]; do sleep 0.1; done\nThen reply with the new record token only.`,
    );
    await expect
      .poll(
        async () =>
          (await client.fetchAgentTimeline(handle.agentId, { limit: 0 })).entries.some(
            ({ item }) => item.type === "tool_call" && item.status === "running",
          ),
        { timeout: 120000 },
      )
      .toBe(true);
    await askBtwFromRunningMainComposer(
      page,
      "What is the exact current record token from the last finished parent turn? Answer with the token only.",
    );
    await expect(window).toBeVisible({ timeout: 60000 });
    await expect(window).toContainText(tokenA, { timeout: 120000 });
    expect((await client.fetchAgentTimeline(handle.agentId, { limit: 0 })).agent?.status).toBe(
      "running",
    );
    await expect
      .poll(async () => (await client.listProviderSubagents(handle.agentId)).subagents[0]?.status, {
        timeout: 120000,
      })
      .toBe("completed");
    const firstStates = await recordedBtwStates(btwRuntime);
    const first = firstStates.findLast((state) => state.status === "idle");
    expect(first?.boundary.parentLeafEntryId).toEqual(expect.any(String));
    await captureBtw(page, info, "live-btw-wide-parent-running");
    await page.getByTestId("btw-chip").click();
    await expect(window).toBeHidden();
    await page.getByTestId("btw-chip").click();
    await expect(window).toHaveAttribute("aria-label", `btw:${first?.threadId}`);
    await writeFile(btwRuntime.gate, "open\n");
    await handle.client.waitForFinish(handle.agentId, 120000);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(window).toBeVisible();
    await askBtw(
      page,
      "What is the current record token now? Use the latest finished parent turn and answer with its exact token only.",
    );
    await expect(window).toContainText(tokenB, { timeout: 120000 });
    await expect
      .poll(async () => (await client.listProviderSubagents(handle.agentId)).subagents[0]?.status, {
        timeout: 120000,
      })
      .toBe("completed");
    const states = await recordedBtwStates(btwRuntime);
    const second = states.findLast((state) => state.status === "idle");
    expect(second?.threadId).toBe(first?.threadId);
    expect(second?.boundary.prefixDigest).not.toBe(first?.boundary.prefixDigest);
    expect(second?.boundary.parentTurnIndex).toBeGreaterThan(first?.boundary.parentTurnIndex ?? 0);
    await captureBtw(page, info, "live-btw-compact-repinned");
    await page.getByTestId("btw-sheet-chip").filter({ visible: true }).click();
    await expect(window).toBeHidden();
    await page.getByTestId("btw-chip").filter({ visible: true }).click();
    await expect(window).toHaveAttribute("aria-label", `btw:${first?.threadId}`);
    const proof = `# Live Pi BTW proof\n\nPi: ${btwRuntime.piBinary} (1.4.0)\nProducer revision: ${btwRuntime.revision}\n\nThe actual configured provider returned ${tokenA} while the parent tool was held, then ${tokenB} after its completion.\n\nFirst boundary: ${JSON.stringify(first?.boundary)}\nNext boundary: ${JSON.stringify(second?.boundary)}\n\nWide and compact screenshots are attached. This run does not establish native keyboard or Electron window behavior.\n`;
    const proofPath = info.outputPath("live-pi-proof.md");
    await writeFile(proofPath, proof);
    await info.attach("live-pi-proof", { path: proofPath, contentType: "text/markdown" });
    await info.attach("contract-states", {
      body: JSON.stringify(states, null, 2),
      contentType: "application/json",
    });
  } finally {
    await writeFile(btwRuntime.gate, "open\n");
    await client.close();
    await closeAgent(handle);
  }
});
