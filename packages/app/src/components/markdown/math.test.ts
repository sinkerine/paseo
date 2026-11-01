import { describe, expect, it } from "vitest";
import { collectMathEdits, needsMathAdaptation, type SourceRange } from "./math";

function adapt(source: string, literal: readonly SourceRange[] = []) {
  const { edits, math } = collectMathEdits(source, literal);
  let rendered = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    rendered = rendered.slice(0, edit.start) + edit.text + rendered.slice(edit.end);
  }
  return { rendered, math };
}

describe("math source adaptation", () => {
  it("converts line-anchored display brackets without changing the content", () => {
    const source = "Before\n\\[\nS = \\frac{QK^\\top}{\\sqrt{D}}\n\\]\nAfter";
    expect(adapt(source)).toEqual({
      rendered: "Before\n$$\nS = \\frac{QK^\\top}{\\sqrt{D}}\n$$\nAfter",
      math: [{ start: 7, end: source.length - 6 }],
    });
  });
});

it.each([
  [String.raw`\\[x\\]`, String.raw`\\[x\\]`],
  [String.raw`\\(x\\)`, String.raw`\\(x\\)`],
  [String.raw`\(x\\) + y\)`, String.raw`$x\\) + y$`],
  [String.raw`\\\(x\)`, String.raw`\\$x$`],
  [String.raw`\[x\\]`, String.raw`\[x\\]`],
])("honours escaped delimiter backslashes: %s", (source, expected) => {
  expect(adapt(source).rendered).toBe(expected);
});

it.each([
  ["> \\[x\\]", "> $$x$$"],
  ["> - \\[\n> x\n> \\]", "> - $$\n> x\n> $$"],
  ["  1. \\[x\\]", "  1. $$x$$"],
  ["+ \\[x\\]", "+ $$x$$"],
  ["2) \\[x\\]", "2) $$x$$"],
  ["* \\[x\\]", "* $$x$$"],
  ["- - \\[x\\]", "- - \\[x\\]"],
  ["Before \\[x\\]", "Before \\[x\\]"],
  ["\\[WIP\\] fix", "\\[WIP\\] fix"],
  ["\\[x\\] middle\ny\\]  ", "$$x\\] middle\ny$$  "],
  ["\\[x\\]\n\\[y\\]", "$$x$$\n$$y$$"],
])("only converts display brackets at allowed line boundaries: %s", (source, expected) => {
  expect(adapt(source).rendered).toBe(expected);
});

it.each([
  [String.raw`\(x^2\)`, "$x^2$"],
  [String.raw`Use \(x\), then (\(y\)).`, "Use $x$, then ($y$)."],
  [String.raw`foo\(x\)`, String.raw`foo\(x\)`],
  [String.raw`\(x\)bar`, String.raw`\(x\)bar`],
  [String.raw`é\(x\)`, String.raw`é\(x\)`],
  [String.raw`\(\)`, String.raw`\(\)`],
  ["\\(x\ny\\)", "\\(x\ny\\)"],
])(
  "requires inline flanking boundaries and nonempty single-line content: %s",
  (source, expected) => {
    expect(adapt(source).rendered).toBe(expected);
  },
);

it.each([
  ["$ npm install\n$ npm test", "\\$ npm install\n\\$ npm test"],
  ["a $ b $", "a \\$ b \\$"],
  ["$", "\\$"],
  ["$$ $$$ $x$ $5 US$5 $HOME/$PATH", "$$ $$$ $x$ $5 US$5 $HOME/$PATH"],
  [String.raw`\$ npm install`, String.raw`\$ npm install`],
  [String.raw`\\$ npm install`, String.raw`\\$ npm install`],
  [String.raw`\( $ \)`, "$ $ $"],
])(
  "escapes only unescaped single dollars surrounded by space or line edges: %s",
  (source, expected) => {
    expect(adapt(source).rendered).toBe(expected);
  },
);

it("leaves literal ranges untouched and never pairs across a literal boundary", () => {
  const source = String.raw`\(a CODE b\) and \(c\)`;
  expect(adapt(source, [{ start: 4, end: 8 }])).toEqual({
    rendered: String.raw`\(a CODE b\) and $c$`,
    math: [{ start: 17, end: 22 }],
  });
  const literal = String.raw`\[x\] \(y\) $ npm`;
  expect(adapt(literal, [{ start: 0, end: literal.length }])).toEqual({
    rendered: literal,
    math: [],
  });
  expect(adapt(String.raw`\[x\]`, [{ start: 3, end: 4 }]).rendered).toBe(String.raw`\[x\]`);
});

it.each([String.raw`\[ x`, String.raw`\(x`, "$$ x"])(
  "preserves unclosed delimiters: %s",
  (source) => {
    expect(adapt(source)).toEqual({ rendered: source, math: [] });
  },
);

it.each([
  ["Plain prose", false],
  ["It costs $5 and $10.", false],
  ["$HOME/$PATH", false],
  ["$$ x $$", false],
  [String.raw`\[x\]`, true],
  [String.raw`\(x\)`, true],
  ["$ npm install", true],
  ["End $", true],
  ["$x$ and prose", true],
])("detects whether adaptation may be needed without parsing: %s", (source, expected) => {
  expect(needsMathAdaptation(source)).toBe(expected);
});

it("hides opaque delimiter tokens while allowing an enclosing formula", () => {
  const source = String.raw`\(a ![\(alt\)](x.png) b\) and \(c\)`;
  const start = source.indexOf("![");
  const end = source.indexOf(" b");
  const { edits, math } = collectMathEdits(source, [], [{ start, end }]);
  expect(math).toEqual([
    { start: 0, end: end + 4 },
    { start: end + 9, end: source.length },
  ]);
  expect(edits.map((edit) => source.slice(edit.start, edit.end))).toEqual([
    String.raw`\(`,
    String.raw`\)`,
    String.raw`\(`,
    String.raw`\)`,
  ]);
  expect(collectMathEdits(String.raw`\(a IMAGE b\)`, [], [{ start: 4, end: 9 }]).math).toEqual([
    { start: 0, end: 13 },
  ]);
  expect(collectMathEdits(String.raw`\(a IMAGE b\)`, [{ start: 4, end: 9 }]).math).toEqual([]);
  const closeInside = String.raw`\(a ![b\)](x.png) tail`;
  expect(collectMathEdits(closeInside, [], [{ start: 4, end: 17 }])).toEqual({
    edits: [],
    math: [],
  });
  const openInside = String.raw`![\(a](x.png) b\)`;
  expect(collectMathEdits(openInside, [], [{ start: 0, end: 13 }])).toEqual({
    edits: [],
    math: [],
  });
});

it("preserves long backslash runs and adapts the following lone dollar", () => {
  const source = "\\".repeat(100_000) + " $ ";
  const { edits, math } = collectMathEdits(source, []);
  expect(edits).toEqual([{ start: 100_001, end: 100_002, text: "\\$" }]);
  expect(math).toEqual([]);
});

it.each([
  { name: "inline openers", source: String.raw`\(x `.repeat(25_000) },
  { name: "display openers", source: "\\[x\n".repeat(25_000) },
  { name: "invalid inline closers", source: String.raw`\(x \)word `.repeat(25_000) },
  { name: "invalid display closers", source: "\\[x\\]word\n".repeat(25_000) },
])("leaves repeated unmatched $name untouched", ({ source }) => {
  expect(collectMathEdits(source, [])).toEqual({ edits: [], math: [] });
});

it("pairs the first opener with a distant closer without rescanning unmatched openers", () => {
  const source = String.raw`\(x `.repeat(25_000) + String.raw`\)`;
  expect(collectMathEdits(source, [])).toEqual({
    edits: [
      { start: 0, end: 2, text: "$" },
      { start: source.length - 2, end: source.length, text: "$" },
    ],
    math: [{ start: 0, end: source.length }],
  });
});
