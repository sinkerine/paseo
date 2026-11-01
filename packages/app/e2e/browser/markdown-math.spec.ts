import { expect, test } from "../support/fixtures";
import {
  assistantMathMessage,
  captureMath,
  copyMathRange,
  expectFirstMathCommit,
  expectMathLayout,
  expectMathFindHighlight,
  expectMathFonts,
  expectMathThemeChanged,
  expectRenderedMath,
  formula,
  INLINE_SENTENCE,
  MATH_REPLY,
  remountCompletedMath,
  SCREENSHOT_TEX,
  withMarkdownMath,
} from "../support/helpers/markdown-math";

for (const width of [1100, 390]) {
  test(`renders streamed and historical math, copies and finds visible content at ${width}px`, async ({
    page,
    context,
  }, info) => {
    info.setTimeout(120_000);
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: "light" });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    await withMarkdownMath(page, async (agent, stream) => {
      await agent.client.sendAgentMessage(agent.agentId, "Show the math fixture.");
      // Transport frames can contain several provider tokens; stop inside the open formula.
      await stream.showUntil("The screenshot case:\n\n\\[\nS = \\frac{QK");
      const message = assistantMathMessage(page);
      await expect(message).toContainText("\\frac{QK");
      await expect(message.locator("math")).toHaveCount(0);
      await expect(message).not.toContainText("Inline");
      await captureMath(page, info, "unclosed-display");

      stream.release();
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await expectRenderedMath(page);
      await expectMathFonts(page, info, "system-ui");
      const lightColor = await expectMathLayout(page);
      await formula(page, SCREENSHOT_TEX).scrollIntoViewIfNeeded();
      await captureMath(page, info, `completed-light-${width}`);
      await formula(page, "\\sum_{i=1}^{n}").scrollIntoViewIfNeeded();
      await captureMath(page, info, `overflow-light-${width}`);

      await page.reload({ waitUntil: "domcontentloaded" });
      await expectRenderedMath(page);
      await remountCompletedMath(page, agent);
      await expectRenderedMath(page);
      await expectFirstMathCommit(page, info);
      await expectMathFonts(page, info, "system-ui");
      await expectMathLayout(page);

      await message.locator("p").filter({ hasText: "in a sentence." }).scrollIntoViewIfNeeded();
      const inlineCopy = await copyMathRange(page, "Inline", "sentence.");
      expect(inlineCopy).toBe(INLINE_SENTENCE);
      const displayCopy = await copyMathRange(page, "The screenshot case:", "Inline");
      expect(displayCopy).toBe(`The screenshot case:\n\n$$\n ${SCREENSHOT_TEX} \n$$\n\nInline`);
      await info.attach("math-selection-copy", {
        body: JSON.stringify({ inlineCopy, displayCopy }, null, 2),
        contentType: "application/json",
      });
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await message.locator("p").filter({ hasText: "It costs" }).click();
      await page.keyboard.press("ControlOrMeta+f");
      const query = page.getByRole("textbox", { name: "Find in pane", exact: true });
      await expect(query).toBeFocused();
      await query.fill("sqrt");
      await expect(page.getByRole("status", { name: "Find matches" })).toHaveText("No matches");
      await query.fill("costs");
      await expect(page.getByRole("status", { name: "Find matches" })).toHaveText("1 of 1");
      await expectMathFindHighlight(page, "costs");
      await query.press("Escape");

      await page.emulateMedia({ colorScheme: "dark" });
      await expectMathThemeChanged(page, lightColor);
      await expectMathLayout(page);
      await formula(page, SCREENSHOT_TEX).scrollIntoViewIfNeeded();
      await captureMath(page, info, `completed-dark-${width}`);
      await formula(page, "\\sum_{i=1}^{n}").scrollIntoViewIfNeeded();
      await captureMath(page, info, `overflow-dark-${width}`);
      await info.attach("fixture", { body: MATH_REPLY, contentType: "text/markdown" });
      expect(errors).toEqual([]);
    });
  });
}

test("keeps the math font when a custom interface font is saved", async ({
  page,
  context,
}, info) => {
  info.setTimeout(120_000);
  await page.setViewportSize({ width: 1100, height: 1000 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ uiFontFamily: "monospace" }));
  });
  await withMarkdownMath(page, async (agent, stream) => {
    await agent.client.sendAgentMessage(agent.agentId, "Show the math fixture.");
    stream.release();
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await expectRenderedMath(page);
    await expectMathFonts(page, info, "monospace");
    await formula(page, SCREENSHOT_TEX).scrollIntoViewIfNeeded();
    await captureMath(page, info, "completed-custom-ui-font");
  });
});
