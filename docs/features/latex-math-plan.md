# LaTeX math rendering — plan

Status: **approved by the user (2026-10-31)**
Feature: `latex-math` · Branch: `check-paseo-latex-rendering-support` · Base: `origin/main` `b2541b34c`

## Scope (user ruling, 2026-10-31)

Math is enabled on the **web platform only**: Electron desktop, browser web, and the daemon's bundled web UI. They share one renderer path. iOS and Android stay exactly as they are today: `enableMath` stays `false`, there is no RaTeX download, no native build change, and the native source passes to the parser unchanged. Native enablement is future work. Its findings are recorded below so the next change starts from them.

## Problem

Assistant replies with TeX show raw source. The reported reply used `\[ … \]`:

```
\[
S = \frac{QK^\top}{\sqrt{D}}, \qquad P = \operatorname{softmax}(S + M), \qquad O = PV.
\]
```

CommonMark treats `\[` and `\]` as escaped brackets, so the user sees `[`, the TeX, then `]`.

On web, two things block math:

| Blocker                          | Where                                                  | Effect                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MD4C_FLAGS.latexMath: false`    | `packages/app/src/components/markdown/renderer.tsx:22` | The md4c parser (the WASM build on web) does not see `$`/`$$`.                                                                                                         |
| No `katex` dependency in the app | `packages/app/package.json`                            | Web `loadKaTeX()` does `require('katex')`. It resolves today only because `mermaid` hoists `katex@0.16.47` to the root `node_modules`. Make it an explicit dependency. |

The migration commit (`eb1a8a2ec`, #6973) gives no reason for disabling math. No reason was found in docs, history or issues.

### Findings from the installed library (`react-native-enriched-markdown@1.2.0-nightly-20261014-766fc0e67`)

I checked these against the npm tarball, and ran the parser checks against the library's real md4c WASM build:

- **Delimiters.** md4c `MD_FLAG_LATEXMATHSPANS` recognizes only `$…$` (inline) and `$$…$$` (display). It does not recognize `\[…\]` or `\(…\)`. Flipping the flag alone does not fix the reported reply.
- **Display lifting.** `MD4CParser.cpp` `splitParagraphAroundDisplayMath` turns `$$…$$` into a top-level `LatexMathDisplay` block when it borders a line or paragraph edge. This covers `$$` on its own lines and `text\n$$x$$\ntext`. Display math with text on both sides on the same line stays inline.
- **Math content is literal.** md4c keeps math content raw, the same way it keeps code spans. Backslashes, `_`, `*` and `||` reach the engine unchanged. Newlines inside math become spaces.
- **Dollar rules.** An opener `$` must follow whitespace, punctuation or the line start. A closer `$` must come before whitespace, punctuation or the line end. Runs of equal length pair up. Probe results:
  - `It costs $5 and $10.` → no math ✅
  - `$ npm install\n$ npm test` → **inline math `npm install`** ❌ (a shell prompt in prose)
  - `Range $5-$10. Euro 5$ and 10$.` → **math `10. Euro 5`** ❌ (prefix and suffix currency mixed in one paragraph; GitHub and pandoc behave the same way)
  - `\$ npm install` → literal ✅ (md4c honours `\$`)
  - Code spans and fences → `Code`/`CodeBlock` with `$` kept literal ✅
  - `where\(x\)`, `$x$y`, `$$ unclosed` → literal text ✅
- **Web engine.** KaTeX `renderToString({ output: 'mathml', throwOnError: false })` inside `<span role="math" aria-label="<tex>">`. MathML needs no CSS or fonts. Chromium, Electron, Safari and Firefox all render it. Display math gets `display: block; overflow-x: auto`. Malformed TeX renders KaTeX's red error text and never throws.
- **Web first commit regresses with math on.** Our patch makes the web component parse synchronously, but `katex` starts as `null` state. With `latexMath: true`, **every** mounted row runs a second async parse. Rows with math first render `$$…$$` source, then MathML, so their height changes after the virtualized list measured them.
- **Web DOM consumers.** KaTeX MathML includes a hidden `<annotation encoding="application/x-tex">` with the source. Today, turndown selection-copy would emit MathML token text followed by the annotation text. Chat find would match hidden annotation text.

Native findings, for future enablement only (not acted on here):

- **Engines.** Native uses RaTeX. Android adds the Maven AAR `io.github.erweixin:ratex-android:0.1.14` (MIT, about 4 MB with Rust `.so` files for every ABI; relevant for F-Droid). On iOS, postinstall downloads `RaTeX.xcframework.zip` (13.8 MB) from GitHub. Both are switched on by `"enriched-markdown".enableMath` in `packages/app/package.json` and need new native builds.
- **Drag handling.** Android `MathContainerView` uses a plain `HorizontalScrollView`, not our patch's `ClaimingHorizontalScrollView`.
- **Copy.** Android plain copy of inline math yields `U+FFFC`.
- **Selection.** Display math is a separate native segment, so native selection stops there.

## Goal and acceptance criteria

Goal: on Electron and browser web, TeX math in assistant replies, file previews, plans, PRs and changelogs renders as typeset math. Everything that is not math renders exactly as before. Native rendering does not change at all.

| ID   | Criterion                                                                                                                                                                                                                                                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1  | **Screenshot case.** The reported `\[ … \]` reply renders as one display formula (fraction, transpose, square root, `softmax` operator, `\qquad` spacing). It shows no `[`, `]`, `\frac`, `\qquad` or `$` text. The parser yields one top-level `LatexMathDisplay` whose source TeX is preserved byte-for-byte before parsing; md4c replaces newlines with spaces without trimming. |
| AC2  | **Dollar display.** `$$` on its own lines, `$$…$$` alone on a line, and `$$…$$` between text lines each render as a display block.                                                                                                                                                                                                                                                  |
| AC3  | **Inline.** `$x^2$` and `\(x^2\)` render inline inside the paragraph, and the surrounding text stays on the same line.                                                                                                                                                                                                                                                              |
| AC4  | **Bracket safety.** `\[` converts only when it is the first thing on its line and its matching `\]` is the last thing on its line. `\(` converts only when the character before it is whitespace, punctuation or the line start, and the character after `\)` is whitespace, punctuation or the line end. `\[WIP\] fix` and `foo\(x\)` render exactly as today.                     |
| AC5  | **Currency and prompts.** `It costs $5 and $10.`, `$5-$10`, `US$5`, `$HOME/$PATH` and `$ npm install` (repeated on the next line) render as literal text with their `$` visible. A lone `$` with whitespace or a line edge on both sides is never a delimiter.                                                                                                                      |
| AC6  | **Code.** Inline code and fences, including `$…$`, `\[…\]` and `\(…\)` inside them, render as literal code. Highlighting, copy and inline-code file links are unchanged.                                                                                                                                                                                                            |
| AC7  | **Malformed.** `$$\frac{a$$` renders KaTeX error text without crashing or logging a console error. Unclosed `$$ x` and `\[` with no `\]` render as literal text.                                                                                                                                                                                                                    |
| AC8  | **Streaming and first paint.** While a reply streams, an unclosed formula shows its literal source until the closing delimiter arrives, then renders. Completed replies match history after reload. A math row's first committed DOM already contains `<math>`: no source-then-math swap and no height jump after measurement.                                                      |
| AC9  | **Selection/copy and find.** Copying a selection that includes inline math gives `$tex$`. Copying a selection that includes display math gives `$$\ntex\n$$` as its own block. Surrounding Markdown copies as before. Chat find does not match hidden annotation text, and visible prose around math is still found.                                                                |
| AC10 | **Theming and layout.** Math uses the paragraph colour, including muted compact text. In both light and dark themes, display math has no grey box and is separated by the standard `blockGap`. Overflowing display math scrolls horizontally inside its block and never makes the page scroll horizontally, at 1100 px and 390 px.                                                  |
| AC11 | **Links and other syntax.** Links, file-link taps, images, tables, Mermaid, spoilers and entity text behave as before. Text inside math is never linkified.                                                                                                                                                                                                                         |
| AC12 | **Native unchanged.** With `supportsMath: false`, `prepareMarkdownSource` output is byte-identical to today for every math fixture, and native parses with `latexMath: false`. `enableMath` stays `false`, and `package.json` has no native-affecting diff.                                                                                                                         |

Known limitations (documented, not fixed):

- **Mixed currency in one paragraph.** A paragraph that mixes prefix and suffix currency, such as `$5-$10 … 5$`, can pair into math. GitHub and pandoc do the same.
- **`||` in dollar math.** `||` inside `$…$` is still escaped to `\|\|` by the spoiler adaptation, so it renders as `‖‖`. Converted `\[…\]`/`\(…\)` spans are protected from this; raw dollar spans are not.
- **Block syntax inside display math.** A blank line, or a line that starts a Markdown block (`- `, `> `, `#`, a setext `===`), inside display math ends the paragraph. md4c has the same limit for `$$`.
- **Linux math fonts.** MathML glyph quality on Linux depends on installed math fonts. Record what Electron on Linux shows.

## Design

### Boundaries and data flow

```
assistant text
  → useMarkdownSource (images.ts): prepareMarkdownSource(text, root, { supportsSvg: isWeb, supportsMath: isWeb })
      ├─ normalizeMarkdownHtml (unchanged)
      ├─ mdast tree (existing; built lazily)
      ├─ if supportsMath: collectMathEdits (NEW math.ts) ← literal ranges from mdast code/inlineCode/html
      │     \[…\] → $$…$$   \(…\) → $…$   lone `$` → `\$`
      ├─ existing edits (images, titles, table pipes, entities, spoilers), skipped inside converted math ranges
      └─ render() applies all edits right-to-left (unchanged mechanism)
  → EnrichedMarkdownText md4cFlags = md4cFlags(isWeb)
      ├─ web: md4c WASM → KaTeX MathML (sync on first commit, patched)
      └─ native: latexMath false, same as today
  → web DOM consumers: selection-copy turndown rule, chat-find ignore list
```

Everything stays in the shared Markdown module. Consumers (chat, file preview, plans, PRs) change nothing. There are no protocol, daemon, server or native changes. The platform gate follows the existing `supportsSvg: isWeb` idiom in `images.ts`. Both gates are one-line inline checks, so there is no file-extension split.

### `packages/app/src/components/markdown/math.ts` (new)

A pure module with no React, platform or mdast imports, so it can be unit tested.

```ts
export interface SourceRange {
  start: number;
  end: number;
}
export interface SourceEdit extends SourceRange {
  text: string;
}

/** True when the source may contain TeX bracket delimiters or a dollar that cannot delimit math. */
export function needsMathAdaptation(source: string): boolean;

/**
 * Rewrites TeX bracket delimiters to the dollar delimiters MD4C parses, and escapes
 * dollars that cannot delimit math. `literal` ranges (code, inline code, HTML) are
 * left untouched. `math` lists the converted spans, delimiters included, so other
 * text edits can skip them.
 */
export function collectMathEdits(
  source: string,
  literal: readonly SourceRange[],
): { edits: SourceEdit[]; math: SourceRange[] };
```

Rules. Each one is an acceptance criterion and gets a unit test.

1. **Escaped delimiters.** A `\` counts as a delimiter backslash only when an even number of backslashes come before it, so `\\[` is a literal backslash followed by `[`.
2. **Display brackets.** For `\[ … \]`, the text before `\[` on its line contains only whitespace, `>` quote markers and at most one list marker (`-`, `*`, `+`, `1.`, `1)`). The text after `\]` on its line is only whitespace. Pair with the nearest unescaped `\]` that satisfies this. Content may span lines. Rewrite `\[` to `$$` and `\]` to `$$`, and leave the content and line prefixes untouched.
3. **Inline brackets.** For `\( … \)`, both delimiters are on one line and the content is not empty. The character before `\(` is the line start, whitespace or ASCII punctuation. The character after `\)` is the line end, whitespace or ASCII punctuation. Rewrite to `$ … $`. Otherwise leave the text unchanged; it renders `(x)` as today.
4. **Lone dollar.** A single `$` (not part of a `$$` run, not escaped) with whitespace or a line edge on both sides becomes `\$`.
5. **Literal ranges.** Nothing inside a `literal` range is scanned. A delimiter pair never spans a literal range boundary.
6. **Fast path.** `needsMathAdaptation` is a single regex test: `\[`, `\(`, or a lone `$` followed by whitespace or the end of the source. It returns `false` for plain currency like `$5`, so those messages keep `prepareMarkdownSource`'s existing fast path (no mdast parse).

### `source.ts`

- Export the parser flags shared by the renderer and the parser tests:

  ```ts
  /** MD4C flags for the shared renderer. Math is web-only until native builds include RaTeX. */
  export function md4cFlags(supportsMath: boolean) {
    return { latexMath: supportsMath, hardSoftBreaks: true, admonitions: true } as const;
  }
  ```

- `prepareMarkdownSource(source, workspaceRoot?, options: { supportsSvg?: boolean; supportsMath?: boolean } = {})`. `supportsMath` defaults to `false`, so callers that pass no option and the native path are unchanged.
- When `supportsMath`:
  - Add `!needsMathAdaptation(source)` to the fast-path guard.
  - Collect literal ranges from the mdast tree: `code`, `inlineCode` and `html` node positions.
  - Call `collectMathEdits(source, literal)` and add its edits.
  - Drop any other edit (entity decode, `||` escape, table pipe spacing, title insertion) whose range falls inside a returned `math` range.
- Update the doc comment to mention math delimiters.

### `images.ts`

`useMarkdownSource` passes `{ supportsSvg: isWeb, supportsMath: isWeb }`.

### `renderer.tsx`

Replace the local constant with `const MD4C_FLAGS = md4cFlags(isWeb);`, imported from `./source`.

### `styles.ts`

Add these entries to `markdownStyle`. Native ignores them while math is off.

```ts
math: {
  ...block,                       // marginTop 0, marginBottom blockGap
  fontSize: Math.round(fontSize * 1.2),
  color: paragraph.color,         // follows muted
  backgroundColor: "transparent",
  padding: 4,                     // keeps tall glyphs from clipping inside the scroll box
  textAlign: "center",
},
inlineMath: { color: paragraph.color },
```

The default style is a `#F3F4F6` box with black text, which is wrong in dark theme.

### Dependency (`packages/app/package.json`, `package-lock.json`)

Add `"katex": "^0.16.47"` to `dependencies`, the same version the lockfile already resolves for mermaid. Install it with `npm install katex@^0.16.47 --workspace=@getpaseo/app` so the lockfile records the app as a dependent. Do not hand-edit the lockfile. Leave `"enriched-markdown".enableMath` set to `false`.

### Library patch (`patches/react-native-enriched-markdown+1.2.0-nightly-20261014-766fc0e67.patch`)

There is one new web-only hunk.

- **Synchronous KaTeX on first commit.**
  - In `lib/module/web/katex.js`, add `export function getKaTeX()`. It returns the cached instance, or `null` when `katex` is missing, without a Promise. `loadKaTeX` delegates to it, so both share the cache.
  - In `lib/module/web/EnrichedMarkdownText.js`, initialize state with `useState(() => (latexMath ? getKaTeX() : null))`. The existing `if (immediate && (!latexMath || katex)) return;` guard then skips the async re-parse for every row once WASM is ready. This makes a math row's first DOM commit contain `<math>` (AC8).
  - Edit `lib/module` only, because Metro resolves `lib/module`, not `src/`.

To make the change:

1. Edit `packages/app/node_modules/react-native-enriched-markdown/…`.
2. Regenerate the patch from `packages/app` with `npx patch-package react-native-enriched-markdown`.
3. Diff the new patch against the old one. Only the `katex.js`, `EnrichedMarkdownText.js` and matching `.js.map` hunks may change. Every existing hunk must be byte-identical.

Note the hunk next to the upstream PR #997 note in `docs/markdown-renderer.md` (Task T3).

### Web DOM consumers

- **`assistant-selection-copy/content.web.ts`.** Add a turndown rule for `span[role="math"]`. It emits `$${aria-label}$` inline. When the span contains `math[display="block"]`, or its inline style is `display: block` (the no-KaTeX fallback), it emits `\n\n$$\n${aria-label}\n$$\n\n`. Treat the span as atomic: a partial selection inside it copies the whole formula. The library's `aria-label` holds the raw TeX.
- **`agent-stream/chat-find/ranges.web.ts`.** Add `annotation` to `IGNORED`, so find skips the hidden TeX source. Visible MathML token text stays searchable.

### Conventions

- No capability gate. This is client-only rendering with no protocol surface. Old daemons send the same text.
- No new user-facing strings, so no i18n changes.

## Tasks

Waves run in order. Tasks in the same wave own disjoint files and can run in parallel.

**Before Wave 1:** run `npm ci` once in the worktree. During Wave 1, only T2 changes `node_modules`. No task runs `npm ci` while another task is testing.

### Wave 1

#### T1 — Math source adaptation, web flags and styles · **high reasoning**

- **Goal:** Implement `math.ts`, wire it into `prepareMarkdownSource` behind `supportsMath`, turn on `latexMath` for web through `md4cFlags`, and add math styles. Prove AC1–AC7, AC11 and AC12 through the real md4c WASM parser.
- **Files owned:** `packages/app/src/components/markdown/math.ts` (new), `math.test.ts` (new), `source.ts`, `images.ts`, `renderer.tsx`, `styles.ts`, `renderer.test.ts`.
- **Produces:** `collectMathEdits`, `needsMathAdaptation`, `SourceRange`, `SourceEdit`, `md4cFlags(supportsMath)`, and the `prepareMarkdownSource` option `supportsMath`.
- **Consumes:** nothing new.
- **Depends on:** none.
- **Tests:**
  - `math.test.ts`: one case per rule (escaped backslashes, line-anchored display in a paragraph, quote and list item, inline flanking, lone dollar, literal ranges, multiline display, unclosed delimiters, fast-path true/false).
  - `renderer.test.ts`: parse `prepareMarkdownSource(x, undefined, { supportsMath: true }).render()` with `parseMarkdown(…, md4cFlags(true))` for the screenshot `\[…\]`, `$$` own-line, `$$` between text, inline `$`/`\(`, currency/prompt/`$HOME` cases, code spans and fences, `\[WIP\]`, malformed and unclosed. Assert node types and exact `content`.
  - AC12: for every fixture, `supportsMath: false` renders byte-identical source, and `md4cFlags(false)` yields no `LatexMath*` nodes.
  - Switch the existing `latexMath: false` parser calls to `md4cFlags(false)`.
  - Extend "shared Markdown theme colours" to assert that `math`/`inlineMath` follow the paragraph and muted colours in light and dark themes.
- **Unit test command (from `packages/app`):**
  `npx vitest run src/components/markdown/math.test.ts src/components/markdown/renderer.test.ts src/components/markdown/streaming.test.ts src/components/markdown/image-source.test.ts --bail=1`

#### T2 — KaTeX dependency and library patch: synchronous web KaTeX · **high reasoning**

- **Goal:** Make `katex` a direct app dependency. Remove the interim source render and the extra async parse per row (AC8).
- **Files owned:** `packages/app/package.json` (`katex` dependency only), `package-lock.json`, `patches/react-native-enriched-markdown+1.2.0-nightly-20261014-766fc0e67.patch`.
- **Produces:** patched `react-native-enriched-markdown/lib/module/web/katex.js` `getKaTeX(): KaTeXInstance | null`, and first-commit KaTeX in `EnrichedMarkdownText.js`.
- **Consumes:** nothing.
- **Depends on:** none.
- **Steps:**
  1. Run `npm install katex@^0.16.47 --workspace=@getpaseo/app`.
  2. Edit `node_modules` and regenerate the patch.
  3. Diff the old and new patches; only the new hunks may differ.
  4. Prove the patch applies to a pristine package without touching the worktree's `node_modules`. Run `npm pack react-native-enriched-markdown@1.2.0-nightly-20261014-766fc0e67` into a scratch directory, extract it to `<scratch>/node_modules/react-native-enriched-markdown`, then run `patch -p1 --dry-run < <patch>` from `<scratch>`.
- **Unit test command (from repo root):** `node --test scripts/postinstall-patches.test.mjs`. The behaviour itself is proven by the T4 E2E first-paint observer.

#### T3 — Web selection-copy and chat-find treat math as atomic; docs

- **Goal:** AC9 on web, and the docs.
- **Files owned:** `packages/app/src/assistant-selection-copy/content.web.ts`, `content.browser.test.ts`, `packages/app/src/agent-stream/chat-find/ranges.web.ts`, `ranges.browser.test.ts`, `docs/markdown-renderer.md`.
- **Produces:** the turndown rule `assistantMath`; `IGNORED` gains `annotation`.
- **Consumes:** the library's DOM shape: `<span role="math" aria-label="<tex>">` containing KaTeX `<math display="block|inline"><semantics>…<annotation encoding="application/x-tex">`. Fixtures copy this shape statically.
- **Depends on:** none.
- **Tests:**
  - Browser tests with real Chromium selection: inline math inside a paragraph copies as `$tex$`. Display math between paragraphs copies as a `$$` block. A partial selection inside a formula copies the whole formula. The fallback span (no `<math>`) copies correctly.
  - Find for a TeX-only token (`sqrt`) returns no matches. Find for surrounding prose still matches.
- **Docs (`markdown-renderer.md`):**
  - Rewrite "Math and video are disabled". Say that math is enabled on web and Electron, list the supported delimiters and the bracket/dollar adaptation rules (why: md4c only knows dollars), and the known limitations above.
  - State that native math is off, and what enabling it requires: `enableMath`, the RaTeX downloads and native builds, the Android `ClaimingHorizontalScrollView` gap, `U+FFFC` copy, and the F-Droid prebuilt AAR.
  - Add the sync-KaTeX hunk to the patch paragraph.
  - Add math to the Verification list.
- **Unit test command (from `packages/app`):**
  `npx vitest run --project browser src/assistant-selection-copy/content.browser.test.ts src/agent-stream/chat-find/ranges.browser.test.ts --bail=1`

### Wave 2

#### T4 — E2E journey

- **Goal:** A Playwright journey through the real app proving AC1–AC10 on web, plus Electron evidence.
- **Files owned:** `packages/app/e2e/browser/markdown-math.spec.ts` (new), `packages/app/e2e/support/helpers/markdown-math.ts` (new; reuses `seedMockAgentWorkspace`, `holdAssistantStream` and `openAgentRoute`, like `streaming-markdown.ts`).
- **Depends on:** T1, T2, T3.
- **Unit test command (from `packages/app`):** `npm run test:e2e -- e2e/browser/markdown-math.spec.ts`

## Test and verification

Never run the full local suite. Run only the task commands above, plus:

- After each task: `npm run typecheck` and `npm run lint` from the repo root. Use `npm run lint -- <files>` for quick passes, but run the full `npm run lint` before handoff.
- Before committing: `npm run format`. Then `npm run format:check`.
- If typecheck errors point at workspace declarations, run `npm run build:client` or `npm run build:server` before diagnosing them.
- Run the existing related suites, one file each, to catch regressions:
  - `npm run test:e2e -- e2e/browser/streaming-markdown.spec.ts`
  - `npm run test:e2e -- e2e/browser/assistant-selection-copy.spec.ts`
  - `npm run test:e2e -- e2e/browser/chat-find.spec.ts`
  - `npm run test:e2e -- e2e/browser/assistant-message-render-limit.spec.ts`
- Performance (math rows on the message list hot path): run `npm run test:e2e:stream-smoothness --workspace=@getpaseo/app` on base and on the branch. Report CV and p95 gap. Also report the web bundle size delta: run `npm run build:daemon-web-ui` and compare the size of the output directory before and after.
- CI covers the full app unit suite and the Playwright shards.

## E2E journey

### Setup (isolated; never touches daemon 6767 or the dev daemon 6768)

```bash
cd /home/sinkerine/.paseo/worktrees/28vpgp2p/wretched-wolf
npm ci
npx playwright install chromium
npm run build:server
npm run build:app-deps
cd packages/app
npm run test:e2e -- e2e/browser/markdown-math.spec.ts
```

The Playwright global setup starts its own Metro and daemon on free ports, and reserves 6767 and 6768. The mock agent (`seedMockAgentWorkspace` with `featureValues.mockStreamingAssistantResponse`) streams a fixed reply, so no provider credentials are needed.

### Fixture reply (`MATH_REPLY`)

````
The screenshot case:

\[
S = \frac{QK^\top}{\sqrt{D}}, \qquad P = \operatorname{softmax}(S + M), \qquad O = PV.
\]

Inline $x^2 + y^2$ and \(e^{i\pi} + 1 = 0\) in a sentence.

$$
\int_0^1 x\,dx = \tfrac{1}{2}
$$

It costs $5 and $10. Use `$x$` literally, and \[WIP\] stays text.

$ npm install

```sh
echo "$HOME" \[x\]
```

Broken: $$\frac{a$$

A long one: $$\sum_{i=1}^{n} a_i b_i c_i d_i e_i f_i g_i h_i i_i j_i k_i l_i m_i n_i o_i p_i q_i r_i s_i t_i$$
````

### Steps, expected results, evidence (Playwright, at 1100 px and 390 px)

1. **Stream with a held gate.** Use `holdAssistantStream`, then `showThrough("\\[\nS = \\frac{QK")`.
   - **Expect:** the last assistant message has no `math` element yet and shows the partial source as text.
   - **Evidence:** screenshot `unclosed-display.png`.
2. **Release the stream** and wait for the agent to finish.
   - **Expect (AC1):** exactly one `span[role="math"]` contains `math[display="block"]` whose `annotation[encoding="application/x-tex"]` text equals the TeX between `\[` and `\]` (trimmed). The message's visible `innerText` has no `\frac`, `\qquad`, `[` before `S =`, or `$$` around it.
   - **Expect (AC2, AC3):** the `\int` display formula renders as `math[display="block"]`. `x^2 + y^2` and `e^{i\pi} + 1 = 0` render as inline `math`, and their bounding boxes lie within the same line box as the neighbouring text.
   - **Expect (AC4, AC5, AC6):** the message text contains `It costs $5 and $10.`, `[WIP] stays text`, `$ npm install`, and the code-span text `$x$`. The fence keeps `echo "$HOME" \[x\]` verbatim, with highlighting and the copy button present.
   - **Expect (AC7):** the broken formula shows KaTeX error text, and the page logs no console errors.
   - **Expect (AC10):** the long formula's block has `scrollWidth > clientWidth`, `document.documentElement.scrollWidth <= innerWidth`, and the math colour equals the paragraph colour. Switch the theme and repeat the colour check.
   - **Evidence:** screenshots `completed-1100.png`, `completed-390.png` and `completed-dark.png`, plus the DOM assertions in the Playwright report.
3. **Reload the page.**
   - **Expect (AC8):** the same DOM assertions pass. A `MutationObserver` installed with `page.addInitScript` before navigation records whether any `assistant-message` subtree ever contained `QK^\top` outside an `annotation` element. The broken formula is excluded, because its KaTeX error text legitimately shows `\frac`. The recorded value must be false. This proves the first commit already has `<math>`.
   - **Evidence:** observer result attached to the report.
4. **Selection copy.** Select from "Inline" through "sentence.", copy, and read the clipboard the same way `assistant-selection-copy.spec.ts` does.
   - **Expect (AC9):** `Inline $x^2 + y^2$ and $e^{i\pi} + 1 = 0$ in a sentence.`
   - Then select from "The screenshot case" across the formula into "Inline".
   - **Expect:** the clipboard contains a `$$\nS = …\n$$` block between the two paragraphs.
   - **Evidence:** clipboard text attached.
5. **Find.** Open chat find and search `sqrt`, which appears only in the TeX source.
   - **Expect:** 0 matches. Search `costs`: 1 match.
6. **Regressions.** The existing suites listed under Test and verification stay green.

### Electron (Linux, this machine)

1. Start this workspace's `daemon` and `desktop` services from `paseo.json` (workspace `wks_5eae5d094de34985`), via the Paseo workspace-script tools. They inject `PASEO_PORT` and `PASEO_SERVICE_DAEMON_PORT`, and use the worktree's `.dev/paseo-home`. Do not use `npm run dev:desktop` directly: it hardcodes `PASEO_LISTEN=127.0.0.1:6768`.
2. In the Electron window, start a Mock Load Test agent (desktop dev runs the daemon in development mode) with the same `MATH_REPLY`. If the mock cannot take a fixed reply from the UI, write `MATH_REPLY` to `math-fixture.md` in a scratch workspace and open it in the file preview, which exercises a second shared surface.
3. **Expect:** the same rendering as step 2, plus a selection copy as in step 4.
4. **Evidence:** screenshots of Electron in light and dark, the copied text, and a note about MathML glyph quality on Linux.

### Native

Not in scope. Fill the QA platform table (`docs/qa.md`) like this:

| Platform                | Tested | Notes                                                                            |
| ----------------------- | ------ | -------------------------------------------------------------------------------- |
| iOS                     | —      | Math gated off. AC12 unit tests prove the source and parser flags are unchanged. |
| Android                 | —      | Same as iOS.                                                                     |
| Web                     | ✅     | Playwright journey above.                                                        |
| Desktop Linux           | ✅     | Electron evidence above.                                                         |
| Desktop macOS / Windows | —      | Same web renderer. Note them as untested.                                        |
