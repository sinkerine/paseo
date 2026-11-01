import { writeFile } from "node:fs/promises";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { holdAssistantStream } from "./agent-timeline-gate";
import { buildAgentRoute, openAgentRoute, seedMockAgentWorkspace } from "./mock-agent";

export const SCREENSHOT_TEX = String.raw`S = \frac{QK^\top}{\sqrt{D}}, \qquad P = \operatorname{softmax}(S + M), \qquad O = PV.`;
export const INTEGRAL_TEX = String.raw`\int_0^1 x\,dx = \tfrac{1}{2}`;
export const LONG_TEX =
  String.raw`\sum_{i=1}^{n} ` +
  Array.from({ length: 80 }, (_, index) => `a_{${index}}`).join(" + ");
export const INLINE_SENTENCE = String.raw`Inline $x^2 + y^2$ and $e^{i\pi} + 1 = 0$ in a sentence.`;
const CODE = String.raw`echo "$HOME" '$x$' \[x\] \(x\)`;

export const MATH_REPLY = [
  "The screenshot case:",
  "",
  "\\[",
  SCREENSHOT_TEX,
  "\\]",
  "",
  String.raw`Inline $x^2 + y^2$ and \(e^{i\pi} + 1 = 0\) in a sentence.`,
  "",
  "$$",
  INTEGRAL_TEX,
  "$$",
  "",
  "$$a+b$$",
  "",
  "Before dollar display",
  "$$c+d$$",
  "After dollar display",
  "",
  String.raw`It costs $5 and $10. Range $5-$10, US$5, $HOME/$PATH.`,
  "",
  String.raw`Use \[WIP\] fix and foo\(x\) as text.`,
  "",
  "$ npm install",
  "$ npm test",
  "A lone $ stays visible.",
  "",
  "Use `$x$`, `\\[x\\]` and `\\(x\\)` literally.",
  "",
  "```sh",
  CODE,
  "```",
  "",
  String.raw`Broken: $$\frac{a$$`,
  "",
  "Unclosed dollars: $$ x",
  "",
  "Unclosed brackets:",
  "\\[",
  "z",
  "",
  "A long one:",
  "$$",
  LONG_TEX,
  "$$",
  "",
  "After the long formula.",
].join("\n");

export function assistantMathMessage(page: Page): Locator {
  return page.locator("[data-message-id]").filter({ has: page.getByTestId("assistant-message") });
}

export function formula(page: Page, tex: string): Locator {
  return assistantMathMessage(page)
    .locator('span[role="math"]')
    .filter({
      has: page.locator("annotation").filter({ hasText: tex }),
    });
}

export async function withMarkdownMath(
  page: Page,
  run: (
    agent: Awaited<ReturnType<typeof seedMockAgentWorkspace>>,
    stream: Awaited<ReturnType<typeof holdAssistantStream>>,
  ) => Promise<void>,
): Promise<void> {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "markdown-math-",
    title: "Markdown math",
    featureValues: {
      mockStreamingAssistantResponse: MATH_REPLY,
      mockStreamingAssistantIntervalMs: 20,
    },
  });
  const stream = await holdAssistantStream(page, agent.agentId);
  try {
    await openAgentRoute(page, agent);
    await stream.waitForInitialTimeline();
    await run(agent, stream);
  } finally {
    stream.release();
    await agent.cleanup();
  }
}

export async function captureMath(page: Page, info: TestInfo, name: string): Promise<void> {
  await info.attach(name, {
    body: await page.screenshot({ path: info.outputPath(`${name}.png`) }),
    contentType: "image/png",
  });
  if (name.startsWith("completed-")) {
    await info.attach(`${name}-formula`, {
      body: await formula(page, SCREENSHOT_TEX).screenshot({
        path: info.outputPath(`${name}-formula.png`),
      }),
      contentType: "image/png",
    });
  }
}

export async function expectMathFonts(page: Page, info: TestInfo, uiFont: string): Promise<void> {
  const message = assistantMathMessage(page);
  const fonts = await message
    .locator("math, math *")
    .evaluateAll((elements) => [
      ...new Set(elements.map((element) => getComputedStyle(element).fontFamily)),
    ]);
  const paragraph = message.locator("p").filter({ hasText: "The screenshot case:" });
  const proseFont = await paragraph.evaluate((element) => getComputedStyle(element).fontFamily);
  const userMessage = page.getByText("Show the math fixture.", { exact: true });
  await expect(userMessage).toHaveCSS("font-family", proseFont);
  expect(proseFont).toContain(uiFont);
  const radical = await formula(page, SCREENSHOT_TEX)
    .locator("msqrt")
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return { fontFamily: style.fontFamily, fontSize: style.fontSize, width: bounds.width };
    });
  const fontsPath = info.outputPath("math-fonts.json");
  await writeFile(fontsPath, JSON.stringify({ fonts, proseFont, radical }, null, 2));
  await info.attach("math-fonts", { path: fontsPath, contentType: "application/json" });
  // MathML needs the browser's math family to paint radicals; the UI stack can omit them.
  expect(fonts).toEqual(["math"]);
}

export async function expectRenderedMath(page: Page): Promise<void> {
  const message = assistantMathMessage(page);
  await expect(message.locator('span[role="math"]')).toHaveCount(8);
  for (const tex of [SCREENSHOT_TEX, INTEGRAL_TEX, "a+b", "c+d", LONG_TEX]) {
    const math = formula(page, tex);
    await expect(math).toHaveCount(1);
    await expect(math.locator('math[display="block"]')).toHaveCount(1);
    // md4c turns every newline into a space, including both delimiter-adjacent ones.
    const normalized = [SCREENSHOT_TEX, INTEGRAL_TEX, LONG_TEX].includes(tex) ? ` ${tex} ` : tex;
    expect(await math.locator("annotation").textContent()).toBe(normalized);
    await expect(math).toHaveAttribute("aria-label", normalized);
  }
  const screenshot = formula(page, SCREENSHOT_TEX);
  await expect(screenshot.locator("mfrac")).toHaveCount(1);
  await expect(screenshot.locator("msqrt")).toHaveCount(1);
  await expect(screenshot.locator("msup")).toHaveCount(1);
  await expect(screenshot.locator("mi").filter({ hasText: "softmax" })).toHaveText("softmax");
  for (const tex of ["x^2 + y^2", String.raw`e^{i\pi} + 1 = 0`]) {
    const math = formula(page, tex);
    await expect(math).toHaveCSS("display", "inline");
    await expect(math.locator("math")).toHaveCount(1);
    await expect(math.locator('math[display="block"]')).toHaveCount(0);
    expect(await math.locator("annotation").textContent()).toBe(tex);
  }
  const inline = message.locator("p").filter({ hasText: "in a sentence." });
  expect(
    await inline.evaluate((paragraph) => {
      const boxes = Array.from(paragraph.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
        .flatMap((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return Array.from(range.getClientRects());
        });
      // The inline formulas and adjacent prose share a baseline even if the phone wraps them.
      return Array.from(paragraph.querySelectorAll('span[role="math"]')).map((math) => {
        const box = math.getBoundingClientRect();
        return boxes.some(
          (text) => text.width > 0 && text.top < box.bottom && text.bottom > box.top,
        );
      });
    }),
  ).toEqual([true, true]);
  const visibleText = await message.innerText();
  for (const literal of [
    "It costs $5 and $10. Range $5-$10, US$5, $HOME/$PATH.",
    "Use [WIP] fix and foo(x) as text.",
    "$ npm install",
    "$ npm test",
    "A lone $ stays visible.",
    "Unclosed dollars: $$ x",
    "Unclosed brackets:",
  ])
    expect(visibleText).toContain(literal);
  await expect(message.locator("p").filter({ hasText: "Unclosed brackets:" })).toContainText("[");
  expect(visibleText).not.toContain("\\qquad");
  expect(visibleText).not.toContain("QK^\\top");
  expect(visibleText).not.toContain(INTEGRAL_TEX);
  for (const code of ["$x$", String.raw`\[x\]`, String.raw`\(x\)`]) {
    await expect(message.locator("p code").filter({ hasText: code })).toHaveText(code);
  }
  const fence = message.locator('[data-paseo-markdown-language="sh"]');
  await expect(fence.locator('[data-paseo-markdown-tag="code"]')).toHaveText(CODE);
  await expect(fence.locator('[data-paseo-markdown-tag="code"] span').first()).toBeAttached();
  await fence.hover();
  await expect(fence.locator("[data-paseo-markdown-ignore]")).toBeVisible();
  await fence.locator("[data-paseo-markdown-ignore]").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CODE);
  const broken = message.locator('span[role="math"][aria-label="\\\\frac{a"]');
  await expect(broken.locator(".katex-error")).toHaveText(String.raw`\frac{a`);
  await expect(broken.locator(".katex-error")).toHaveAttribute("title", /KaTeX parse error/);
}

export async function copyMathRange(page: Page, start: string, end: string): Promise<string> {
  await assistantMathMessage(page).evaluate(
    (message, selected) => {
      const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (!node.parentElement?.closest("annotation")) nodes.push(node);
      }
      const text = nodes.map((node) => node.data).join("");
      const startOffset = text.indexOf(selected.start);
      const endOffset = text.indexOf(selected.end, startOffset);
      if (startOffset < 0 || endOffset < 0) throw new Error("Math selection boundaries not found");
      const boundary = (offset: number, isEnd = false): [Text, number] => {
        for (const node of nodes) {
          if (offset < node.length || (isEnd && offset === node.length)) return [node, offset];
          offset -= node.length;
        }
        throw new Error("Math selection exceeds message");
      };
      const range = document.createRange();
      range.setStart(...boundary(startOffset));
      range.setEnd(...boundary(endOffset + selected.end.length, true));
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    { start, end },
  );
  await page.keyboard.press("ControlOrMeta+c");
  return page.evaluate(() => navigator.clipboard.readText());
}

interface MathRowSample {
  reason: string;
  hasMath: boolean;
  hasContent: boolean;
  width: number;
  height: number;
}

interface FirstMathCommit {
  messageId: string;
  samples: MathRowSample[];
  rawSourceSeen: boolean;
}

interface MathRowObservation {
  state: FirstMathCommit;
  sample(reason: string): void;
  stop(): void;
}

type MathObservationWindow = Window & { __markdownMathFirstCommit: MathRowObservation };

/** Reopen the completed reply through the route handoff without reloading the parser. */
export async function remountCompletedMath(
  page: Page,
  agent: { workspaceId: string; agentId: string },
): Promise<void> {
  const messageId = await assistantMathMessage(page).getAttribute("data-message-id");
  if (!messageId) throw new Error("Math reply has no message id");
  const original = await assistantMathMessage(page).elementHandle();
  if (!original) throw new Error("Math reply is not mounted");
  await observeFirstMathCommit(page, messageId);
  // Same-document navigation uses the existing route handoff, keeping WASM warm.
  await page.evaluate(
    (route) => {
      window.history.pushState(null, "", route);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    buildAgentRoute(agent.workspaceId, agent.agentId),
  );
  await page.waitForURL((url) => !url.searchParams.has("open"));
  await expect.poll(() => original.evaluate((row) => row.isConnected)).toBe(false);
  await expect(assistantMathMessage(page)).toHaveAttribute("data-message-id", messageId);
  expect(
    await assistantMathMessage(page).evaluate((row, previous) => row === previous, original),
  ).toBe(false);
  await original.dispose();
}

async function observeFirstMathCommit(page: Page, messageId: string): Promise<void> {
  await page.evaluate((id) => {
    const state: FirstMathCommit = { messageId: id, samples: [], rawSourceSeen: false };
    let row: Element | null = null;
    const inspectSource = (root: Node) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const inspect = (node: Node) => {
        if (
          node.nodeType === Node.TEXT_NODE &&
          node.parentElement?.closest('[data-testid="assistant-message"]') &&
          !node.parentElement.closest("annotation") &&
          node.textContent?.includes("QK^\\top")
        )
          state.rawSourceSeen = true;
      };
      inspect(root);
      while (walker.nextNode()) inspect(walker.currentNode);
    };
    const sample = (reason: string) => {
      if (!row?.isConnected) return;
      inspectSource(row);
      const bounds = row.getBoundingClientRect();
      const assistant = row.querySelector('[data-testid="assistant-message"]');
      state.samples.push({
        reason,
        hasMath: !!assistant?.querySelector("math"),
        hasContent: !!assistant?.textContent?.trim(),
        width: bounds.width,
        height: bounds.height,
      });
    };
    const resize = new ResizeObserver(() => sample("resize"));
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const candidates = [node, ...node.querySelectorAll("[data-message-id]")];
          for (const candidate of candidates) {
            if (candidate.getAttribute("data-message-id") !== id) continue;
            if (row && row !== candidate) throw new Error("Math row mounted more than once");
            if (!row) {
              row = candidate;
              sample("insertion");
              resize.observe(row);
            }
          }
        }
        inspectSource(record.target);
        for (const node of [...record.addedNodes, ...record.removedNodes]) inspectSource(node);
        if (
          record.type === "characterData" &&
          record.oldValue?.includes("QK^\\top") &&
          record.target.parentElement?.closest('[data-testid="assistant-message"]') &&
          !record.target.parentElement.closest("annotation")
        )
          state.rawSourceSeen = true;
      }
      sample("mutation");
    });
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
    });
    (window as unknown as MathObservationWindow).__markdownMathFirstCommit = {
      state,
      sample,
      stop: () => {
        observer.disconnect();
        resize.disconnect();
      },
    };
  }, messageId);
}

export async function expectFirstMathCommit(page: Page, info: TestInfo): Promise<void> {
  const state = await page.evaluate(async () => {
    const observation = (window as unknown as MathObservationWindow).__markdownMathFirstCommit;
    try {
      // Keep sampling the entire row after all content is present, including layout callbacks.
      await document.fonts.ready;
      for (let frame = 0; frame < 60; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        observation.sample("frame");
      }
      return observation.state;
    } finally {
      observation.stop();
    }
  });
  const statePath = info.outputPath("first-math-commit.json");
  await writeFile(statePath, JSON.stringify(state, null, 2));
  await info.attach("first-math-commit", {
    path: statePath,
    contentType: "application/json",
  });
  expect(state.rawSourceSeen, "warm row must never show raw TeX").toBe(false);
  expect(state.samples[0]?.reason).toBe("insertion");
  expect(state.samples[0]?.hasContent, "first inserted row must not be empty").toBe(true);
  expect(state.samples[0]?.hasMath, "first inserted row must contain MathML").toBe(true);
  expect(state.samples.filter((sample) => sample.reason === "frame")).toHaveLength(60);
  const settled = state.samples.at(-1)!;
  expect(settled.width).toBeGreaterThan(0);
  expect(settled.height).toBeGreaterThan(0);
  for (const sample of state.samples) {
    expect(sample.hasContent).toBe(true);
    expect(sample.hasMath).toBe(true);
    expect(Math.abs(sample.width - settled.width), JSON.stringify(sample)).toBeLessThan(0.5);
    expect(Math.abs(sample.height - settled.height), JSON.stringify(sample)).toBeLessThan(0.5);
  }
}

export async function expectMathLayout(page: Page): Promise<string> {
  const message = assistantMathMessage(page);
  const paragraph = message.locator("p").filter({ hasText: "The screenshot case:" });
  const color = await paragraph.evaluate((element) => getComputedStyle(element).color);
  const gap = await paragraph.evaluate((element) => getComputedStyle(element).marginBottom);
  for (const tex of [
    SCREENSHOT_TEX,
    INTEGRAL_TEX,
    "a+b",
    "c+d",
    LONG_TEX,
    "x^2 + y^2",
    String.raw`e^{i\pi} + 1 = 0`,
  ]) {
    const math = formula(page, tex);
    await expect(math).toHaveCSS("color", color);
    await expect(math).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    if (!["x^2 + y^2", String.raw`e^{i\pi} + 1 = 0`].includes(tex)) {
      await expect(math).toHaveCSS("margin-bottom", gap);
    }
  }
  const long = formula(page, LONG_TEX);
  await expect(long).toHaveCSS("overflow-x", "auto");
  expect(
    await long.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeGreaterThan(100);
  await long.evaluate((element) => {
    element.scrollLeft = 100;
  });
  expect(await long.evaluate((element) => element.scrollLeft)).toBe(100);
  await long.evaluate((element) => {
    element.scrollLeft = 0;
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => innerWidth),
  );
  return color;
}

export async function expectMathFindHighlight(page: Page, text: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const texts: string[] = [];
        for (const [name, highlight] of CSS.highlights.entries()) {
          if (!name.startsWith("paseo-chat-find-")) continue;
          for (const range of highlight) texts.push(range.toString());
        }
        return texts;
      }),
    )
    .toEqual([text]);
}

export async function expectMathThemeChanged(page: Page, previousColor: string): Promise<void> {
  await expect
    .poll(() =>
      assistantMathMessage(page)
        .locator("p")
        .filter({ hasText: "The screenshot case:" })
        .evaluate((element) => getComputedStyle(element).color),
    )
    .not.toBe(previousColor);
}
