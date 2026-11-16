import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [
  snapshotPath,
  windowPath,
  mode = "keyboard",
  header = "sheet-tab-header",
  selectedImePath,
  realIme,
  expectedText,
] = process.argv.slice(2);
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
assert.equal(snapshot.success, true, "Agent Device snapshot failed");
assert.ok(
  Array.isArray(snapshot.data.nodes) && snapshot.data.nodes.length > 0,
  "Empty device snapshot",
);
const nodes = snapshot.data.nodes;
if (mode === "back") {
  assert.equal(
    nodes.some((node) => node.identifier === header && node.visibleToUser !== false),
    false,
    "Back did not close the sheet",
  );
} else {
  assert.ok(selectedImePath && realIme && expectedText, "Missing real IME/text evidence");
  assert.equal(readFileSync(selectedImePath, "utf8").trim(), realIme, "Selected IME changed");
  assert.equal(
    /imehelper|TestInputMethodService/.test(realIme),
    false,
    "Helper IME cannot prove layout",
  );
  const realPackage = realIme.split("/")[0];
  assert.ok(
    nodes.some(
      (node) =>
        node.bundleId === realPackage && node.visibleToUser !== false && node.rect?.height > 0,
    ),
    "Real keyboard is not visible",
  );
  assert.equal(
    nodes.find((node) => node.identifier === "btw-composer")?.value,
    expectedText,
    "ASCII draft differs",
  );
  const window = readFileSync(windowPath, "utf8");
  const match = window.match(/type=ime frame=\[0,(\d+)\].*visible=true/);
  assert.ok(match, "Missing visible real software IME frame");
  const top = Number(match[1]);
  assert.ok(top > 0, "Invalid IME top");
  for (const id of ["btw-composer", "btw-send"]) {
    const node = nodes.find(
      (candidate) => candidate.identifier === id && candidate.visibleToUser !== false,
    );
    assert.ok(node?.rect, `Missing visible bounds: ${id}`);
    const { y, height, width } = node.rect;
    assert.ok(Number.isFinite(y) && height > 0 && width > 0, `Invalid rect: ${id}`);
    assert.ok(y + height <= top + 1, `${id} bottom ${y + height} overlaps IME top ${top}`);
  }
  process.stdout.write(`PASS: composer and Send above visible IME top=${top}px\n`);
}
