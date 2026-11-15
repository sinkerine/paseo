# Selection "Add to BTW" plan

Feature id: `selection-shortcuts` (mission `fa41fa88-17ec-49db-9532-50670778de03`). The feature id predates the user scope change recorded below; shortcut configuration was removed from scope.

## Gate resolution and repository rules

- **Discovery.** The selected-text "Copy / Add to chat" bar in the user's screenshot is rendered by the Better Paseo plugin (`client/components/selection-actions.ts` in the user's fork `sinkerine/better-paseo`, local checkout `/home/sinkerine/dev/better-paseo`, clean at `5d26670c`, matching `/nixfiles/pkgs/paseo/better-paseo.nix`). Searches across `origin/main` (`2e9d69649`), `upstream/main` (`2bd9e9d87`), `/home/sinkerine/dev/paseo`, `macho-lionfish`, and all local branches confirmed Paseo has no built-in selection action chip bar. Plugins cannot read Paseo's BTW thread store or mutate Paseo's BTW draft directly.
- **Human scope input (resolved).** The user narrowed the request to: _"don't need shortcut then, only add a 'add to btw' chip if there's a btw conversation"_. Shortcut configuration is dropped. Scope is adding an **Add to BTW** action beside **Add to chat**, shown only when the chat owns an active BTW conversation.
- **External side-effect gate — cross-repository worktree and commits (explicitly authorized by user).** The user authorized proceeding in both repositories: creating an isolated git worktree `/home/sinkerine/.paseo/worktrees/28vpgp2p/better-paseo-add-to-btw` on branch `feat/add-to-btw-chip` from `/home/sinkerine/dev/better-paseo` (`5d26670c`), implementing, testing, and making local commits in both isolated worktrees. **Prohibited without separate approval:** editing `/home/sinkerine/dev/paseo` or `/home/sinkerine/dev/better-paseo` main checkouts, pushing to any remote, opening PRs, updating `/nixfiles`, or deploying.
- **Better Paseo repository rules applicability (inspected `/home/sinkerine/dev/better-paseo/CLAUDE.md`, `scripts/check-hermes.mjs`, `test/unit/settings-strings.test.ts`, and `git remote -v`).**
  - _Synchronous `nativeEvent` reads (`CLAUDE.md` §1, enforced by `test/unit/pooled-event-reads.test.ts`):_ **Applies in full.** Read `event.nativeEvent.*` synchronously inside event callbacks; never forward `event` into state updaters, timers, promises, or nested closures.
  - _Hermes compilation and ASCII-only bundle (`scripts/check-hermes.mjs`):_ **Required.** Bundle comments and regex literals must remain ASCII (`<= 0x7f`); both raw `index.client.tsx` and the `--built` bundle/chunk must pass the Hermes V1 and legacy compiler checks. Run `npm_config_offline=true npm run check:hermes`. **User-approved verification amendment:** standalone Hermes VM evaluation is not required for this web-only feature. Disclose VM execution as unrun, never passed. Do not acquire, download, or install a runtime or tools for this check.
  - _Bilingual parity (`test/unit/settings-strings.test.ts`, `README.md`, `README-zh.md`):_ **Applies in full.** Update English and Chinese strings and README sections together.
  - _Upstream PR author identity (`CLAUDE.md` §2 `提交身份（commit 与 PR）`):_ **Scoped to upstream PRs; not applicable to local fork commits.** That rule comes from `upstream` (`RoundRedDot/better-paseo`) and governs PRs pushed to `RoundRedDot/*` or `getpaseo/*` under upstream maintainer `luke <luopeihuan@gmail.com>`. Here `origin` is `sinkerine/better-paseo` (where local fork commits such as `86a6697b` use the host identity `sinkerine <git@15cm.net>`) and pushing/PR creation is forbidden. Local commits in `feat/add-to-btw-chip` use the host's configured git identity without modifying `~/.gitconfig` or repository git config.
- **Discovery side effect.** Design ran `git fetch upstream`, updating `refs/remotes/upstream/main` in the shared Paseo git dir without altering any working tree or local branch.

## 1. Goal and acceptance criteria

**Goal.** On web and Electron desktop, selecting text in a Better Paseo timeline card or preview gutter, or selecting cells in a Better Paseo Markdown table, offers **Add to BTW** immediately after **Add to chat** when and only when that chat pane currently owns a BTW thread. Activating **Add to BTW** appends the quoted snippet to that pane's BTW draft, focuses the pane, opens the BTW floating card (wide) or sheet (compact), and focuses the BTW composer with the caret at the end. Copy, Add to chat, the main composer, and existing BTW thread/draft/send behavior remain unchanged.

### Acceptance criteria

Per `docs/testing.md`, Paseo tests use only two shapes: (1) Node unit tests (`environment: "node"`) against pure reducers and typed ports/adapters with colocated in-memory fakes — no JSDOM, no `@testing-library` component mounting, and no `vi.mock` of own modules; and (2) real Playwright browser E2E tests against an isolated daemon, real Metro web bundle, deterministic Pi BTW HTTP fixture (`http-stub.ts`), and real directory-compiled plugin. Helper/faked-DOM unit tests in Better Paseo cover only plugin-internal branches (such as `zh` label lookup and the `Platform.OS !== "web"` branch); every observable UI entry path, variant, and lifecycle transition below is proven by the Playwright acceptance spec `packages/app/e2e/browser/btw-selection-insert.spec.ts`.

- **AC1 — Chip availability across all selection surfaces and negative boundaries.**
  - Entry paths:
    - (a) prose range/drag selection inside a `[data-bcselection]` card in the main chat transcript;
    - (b) code range/drag selection inside a `[data-bccode]` code block in the main chat transcript;
    - (c) whole-line gutter selection (`[data-testid="preview-line-numbers"]`) inside an open plugin code preview window (`Open Markdown in a window` -> `Show raw text`), which sets a DOM selection inside `[data-bccode]` and raises `[data-bcselectionbar]`;
    - (d) Markdown table-cell selection (`dblclick` on `[data-testid="markdown-table-cell"]`), which opens `[data-testid="table-selection-menu-row"]`;
    - (e) text selection inside the open wide `BtwFloatingCard` transcript (which sits inside the pane's `streamContent` container).
  - Positive rule: (a)–(c) and (e) render bar buttons in exact order **Copy · Add to chat · Add to BTW**, and (d) renders menu buttons **Copy selected cell · Add to chat · Add to BTW**, when and only when the selection or table anchor is inside an agent pane whose `BtwWindow` currently mounts a `BtwThreadWindow` (`[data-btw-thread]`).
  - Negative rule — **Add to BTW** is absent (leaving existing buttons unchanged) in every other state:
    - chat has no BTW thread yet, verified across all four entry paths (a)–(d);
    - Pi agent runs without the BTW extension (`btwBrowserTest(false, false)`);
    - draft / new-tab composer pane (`draft` truthy);
    - split-pane neighbour agent without a BTW thread, even while another visible split pane in the same window owns a BTW thread;
    - pane without an active composer (`!hasActiveComposer`, e.g. an archived agent tab);
    - selection inside the open compact `BtwSheet` (`390×844`), which portals to the root `SheetHostScope` outside the pane's `[data-btw-thread]` container;
    - selection whose anchor and focus cross out of the `[data-bcselection]` card into host chrome (no bar at all, matching today);
    - after `btw-clear` removes the BTW thread;
    - iOS and Android (`selection-target.ts` is a no-op; the selection bar is web-only; `TableCopyMenu` gates **Add to BTW** on `Platform.OS === "web"`).
  - Dynamic availability: availability is re-evaluated on every bar show and table menu open, so creating or clearing a BTW thread updates the next selection without reloading.
  - Evidence:
    - Real browser E2E `packages/app/e2e/browser/btw-selection-insert.spec.ts`: Journey 1 steps 1–3, 9–12; Journey 2 (compact `390×844`); Journey 3 (BTW extension absent).
    - Paseo Node unit `packages/app/src/btw/selection-target.test.ts`: `"sets data-btw-thread on attach and removes attribute and listener on cleanup"`.
    - Plugin Node units: `test/unit/selection-bar-btw.test.ts` (`"hides Add to BTW outside a BTW target and reveals it when the ancestor acquires data-btw-thread"`) and `test/unit/markdown-table-copy-menu.test.ts` (`"offers Add to BTW for a selected cell only inside a web BTW target"` and `"never offers Add to BTW on native"`).

- **AC2 — Insertion formatting, separator, window presentation, and focus.**
  - Activating **Add to BTW** dispatches the same Markdown snippet shape as **Add to chat**:
    - prose selection (a, e): `> ` blockquote ending in `\n\n`;
    - code selection (b) and preview gutter line selection (c): ` ```\n<text>\n```\n\n ` fenced block;
    - table cell selection (d): `quoteCell(selected.text)` (`> ` blockquote ending in `\n\n`).
  - Paseo appends the snippet to that pane's BTW draft:
    - empty draft: takes `snippet` verbatim;
    - non-empty draft: inserts `""` if draft already ends with `\n\n`, `"\n"` if it ends with `\n`, else `"\n\n"`, followed by `snippet`.
  - Paseo focuses the owning pane (`onFocusPane`), sets that BTW thread's window mode to `"open"` (opening a minimized `BtwFloatingCard` on wide or presenting `BtwSheet` on compact), and focuses `[data-testid="btw-composer"]` with `selectionStart === selectionEnd === value.length`.
  - Visual confirmation: the selection bar flashes the `"Added"` check before hiding; the table selection menu dismisses (`selected.dismiss()`).
  - Isolation: the main chat composer draft (`[data-composer-input]`) and main agent user-message timeline remain untouched.
  - Evidence:
    - Real browser E2E `packages/app/e2e/browser/btw-selection-insert.spec.ts`: Journey 1 steps 3–6 (prose, code fence, preview gutter line, table cell, send + parent timeline check, selection inside wide BTW card) and Journey 2 (compact sheet open + focus).
    - Paseo Node unit `packages/app/src/btw/draft.test.ts`: `"appendBtwDraftSnippet joins empty and newline-terminated drafts with at most one blank line"`.

- **AC3 — Fail-closed validation and visible fallback when unhandled.**
  - If `paseo:btw-insert` is not acknowledged via `preventDefault()` (because `admitting` is in flight, the BTW thread unmounted after the bar/menu opened, or the host predates this contract):
    - the selection bar copies the raw selected text via `copyText` and flashes `"Copied instead"`;
    - the table selection menu copies `selected.text` via `copyText`, shows the `"Copied instead"` toast (`toolbarLabel("Copied instead", language)`), and keeps the cell selection menu open.
  - Paseo ignores already-`defaultPrevented` events and invalid event `detail` payloads (`null`, missing `text`, `text: ""`, or non-string `text`) without mutating state or calling `preventDefault()`.
  - Evidence:
    - Real browser E2E `packages/app/e2e/browser/btw-selection-insert.spec.ts`: Journey 1 step 8 (held `send_agent_message_request` -> bar flashes `"Copied instead"` while admitting, then succeeds with `"Added"` after release) and Journey 0 host-contract check (malformed `CustomEvent` detail leaves event unprevented and draft unchanged).
    - Paseo Node unit `packages/app/src/btw/selection-target.test.ts`: `"ignores defaultPrevented events and malformed detail payloads"` and `"leaves event unprevented when onInsert refuses during admission"`.
    - Plugin Node units: `test/unit/selection-bar-btw.test.ts` (`"copies raw text and flashes Copied instead when event is unhandled"`) and `test/unit/markdown-table-copy-menu.test.ts` (`"copies cell text, toasts Copied instead, and stays open when event is unhandled"`).

- **AC4 — BTW lifecycle, retry, and concurrency transitions.**
  - Every transition has named regression coverage across pure Node units and real-browser Playwright E2E:
    - (a) _Admission in flight:_ while a BTW command mutation is admitting (`admitting.current === true`), `onSelectionInsert` returns `false`, refusing insertion so `accepted` cannot erase a newly added snippet; once settled, subsequent insertion succeeds. (`selection-target.test.ts`: `"leaves event unprevented when onInsert refuses during admission"`; E2E Journey 1 step 8 with `installDaemonWebSocketGate` holding `send_agent_message_request`.)
    - (b) _Failed ask recovery:_ after `FAIL_BTW` fails (HTTP 500), the restored question stays in `btw-composer` and **Add to BTW** appends after `\n\n` while preserving recovery state. (`draft.test.ts`: `"insert after a failed ask appends to the restored question"`; E2E Journey 1 step 8b.)
    - (c) _Streaming answer reconciliation:_ after an ask (`HOLD_BTW`) is accepted (`btw-composer` cleared to `""`) and while its answer is still streaming, **Add to BTW** populates `btw-composer`; when `HOLD_BTW` finishes and reconciles (`status === "completed"`), `reduceBtwDraft` keeps the newly inserted draft (`state.text !== state.submitted?.text`), and after that draft is sent and reconciled, a later insert lands in an empty draft. (`draft.test.ts`: `"insert during an in-flight ask survives answer reconciliation and clears only after its own send reconciles"`; E2E Journey 1 step 8c.)
    - (d) _Thread replacement and removal:_ `btw-new` changes `thread.id` and remounts `BtwThreadWindow` (`key={btwWindowKey(...)}`), detaching the old listener/attribute and attaching the new window's listener with an empty draft; `btw-clear` unmounts `BtwThreadWindow`, removes `[data-btw-thread]`, and hides **Add to BTW**. (`selection-target.test.ts`: `"replaces listener cleanly across target remounts"`; E2E Journey 1 step 9.)
    - (e) _Multi-pane and multi-window isolation:_ with two split panes showing two agents that both own BTW threads, **Add to BTW** in pane A focuses pane A, opens pane A's `BtwWindow`, and modifies only pane A's draft while pane B's draft remains untouched; with two browser pages open to the same agent, **Add to BTW** in page 1 modifies only page 1's local BTW draft while page 2's draft stays empty. (`selection-target.test.ts`: `"isolates sibling pane elements"`; E2E Journey 1 steps 10–11.)
    - (f) _Minimize/open and one-shot focus:_ inserting into a minimized card/sheet opens it and focuses `btw-composer`; inserting into an already-open card keeps it open and moves caret to end; minimizing and later reopening via `btw-chip` does not replay a stale focus request. (E2E Journey 1 steps 3–4 and Journey 2.)

- **AC5 — Existing selection, main composer, and BTW behavior preserved.**
  - **Add to chat** still inserts into the main composer (`[data-composer-input]`) and leaves `btw-composer` unchanged.
  - **Copy** and cross-surface selection dismissal behave identically to `5d26670c`.
  - Existing BTW send, stop, inject, summarize, new, clear, and viewport landing rules remain intact (`pi-btw-window.spec.ts` passes unchanged).
  - Evidence: E2E Journey 1 step 7, `packages/app/e2e/browser/pi-btw-window.spec.ts`, Paseo `packages/app/src/btw/*.test.*`, and Better Paseo `npm test`.

### Decisions

- **D1 — No keyboard shortcuts.** Dropped per explicit user instruction. `keyboard-shortcuts.ts` and Shortcuts settings are untouched.
- **D2 — Web DOM event hand-off (`data-btw-thread` + `paseo:btw-insert`).**
  - Ruling: Paseo marks the agent pane's `streamContent` element with `data-btw-thread=""` while `BtwThreadWindow` is mounted and listens on that element for `new CustomEvent("paseo:btw-insert", { bubbles: true, cancelable: true, detail: { text } })`, acknowledging acceptance via `event.preventDefault()` and `event.stopPropagation()`. — The selection bar lives in a `document.body` shadow root outside React, plugins have no BTW SDK API in `@getpaseo/plugin@0.14.0`, and Better Paseo already integrates with the host composer via `[data-composer-input]`. — Cost if wrong: localized to two constants shared between `selection-contract.ts` and `selection-actions.ts`, with graceful no-chip/copy fallback across mismatched versions.
- **D3 — Host owns BTW draft state.** The plugin never mutates the BTW `<textarea>` DOM directly, which is unmounted whenever the card or sheet is minimized and governed by `reduceBtwDraft`.
- **D4 — Append at end with single blank-line separator.** Because the BTW card/sheet may be minimized when **Add to BTW** is pressed, there is no prior active caret; snippets append at the end using AC2's separator rule, then focus places the caret at `value.length`.
- **D5 — Refuse during RPC admission.** Returning `false` while `admitting.current` is true avoids racing `accepted` draft clearing and triggers AC3's visible `"Copied instead"` fallback.
- **D6 — Web and Electron only; native is a no-op.** Better Paseo's selection bar is web-only (`Platform.OS === "web"`), and Paseo does not supply host composer mutation on native. `selection-target.ts` is a no-op on native.
- **D7 — Per-pane DOM ref ownership.** Each `BtwThreadWindow` binds its listener directly to its own pane's `streamContentRef` element rather than `document`, preventing cross-pane leakage or duplicate delivery.
- **D8 — Labels and icons.** English: `"Add to BTW"`. Chinese (`zh`): `"添加到 BTW"`. Selection bar uses inline Lucide `messages-square` SVG; `TableCopyMenu` uses `<Icon name="MessagesSquare" />` (already supported by Paseo's plugin icon runtime and used in Better Paseo `user-questions.tsx`).
- **D9 — Focus owning pane on insert.** Ruling: pass optional `onFocusPane?: () => void` from `AgentConversationPanel` (`usePaneFocus().focusPane`) to `BtwWindow` and call `onFocusPane?.()` when accepting an insert, matching `BtwPill` (`pill.tsx:30`). — `BtwThreadWindow` gates `visible` on `isPaneFocused`, so focusing the pane guarantees the card opens even if a selection or menu action occurred while another split pane held focus, without making `BtwWindow` depend directly on `PaneFocusContext`. — Cost if wrong: none; `onFocusPane` is idempotent when the pane is already focused.
- **D10 — Chromium Playwright renderer evidence covers Electron desktop for this feature run.**
  - Ruling: Chromium Playwright acceptance (`--project=browser`, wide and compact) is the complete web/desktop runtime verification for this feature; no separate real-Electron run is required or deferred. — None of the touched Paseo files (`packages/app/src/btw/*`, `packages/app/src/panels/agent-panel.tsx`) has an `.electron.*` variant, calls `getIsElectron()`, or touches Electron preload/IPC/`<webview>`, and Better Paseo's daemon-compiled `index.client.tsx` runs identical `Platform.OS === "web"` DOM code in Chromium and Electron's Chromium renderer. This matches repository CI routing in `.github/ci-paths.yml`, where `packages/app/src/!(desktop)/**` without `.electron.{ts,tsx}` routes to `browser` Playwright rather than `desktop` Electron suites. — Cost if wrong: low; if a future default-branch merge workflow independently runs desktop suites, `packages/desktop` already has `npm run test:e2e:browser-tabs --workspace=@getpaseo/desktop`.

### Required documentation

- Paseo `docs/plugins.md`: integrate a concise paragraph/subsection inside `## Contribute timeline items` (near line 690, right after the completed-turn action slot paragraph) documenting the web-only `data-btw-thread` ancestor marker and cancelable `paseo:btw-insert` `CustomEvent<{ text: string }>` hand-off (`preventDefault()` acknowledgement, required plugin fallback when unhandled, no native equivalent).
- Better Paseo `README.md` and `README-zh.md`: update the selection bullet (`README.md` ~line 755, `README-zh.md` ~line 569), table selection bullet (`README-zh.md` ~line 538 and `README.md` counterpart), settings table row (`README.md` ~line 1021, `README-zh.md` ~line 702), and native-limitations row (`README.md` ~line 1137, `README-zh.md` ~line 773) to note **Add to BTW** / `添加到 BTW` on web/desktop when the chat has a BTW conversation. Update `selectionDescription` in `client/i18n/settings-page-strings.ts` (`en` and `zh`) and `"Add to BTW": "添加到 BTW"` in `client/i18n/toolbar-strings.ts`.

## 2. Design

### Data flow

```text
Selection in [data-bcselection] / [data-bccode] / PreviewLines gutter, or dblclick in MdTable cell
  └─ Better Paseo: canInsertIntoBtw(element) -> Boolean(element?.closest("[data-btw-thread]"))
       └─ click "Add to BTW" -> insertIntoBtw(snippet, element)
            └─ !element.dispatchEvent(new CustomEvent("paseo:btw-insert", { bubbles: true, cancelable: true, detail: { text: snippet } }))
                 └─ Paseo: attachBtwSelectionTarget listener on streamContent element
                      ├─ event.defaultPrevented or !BtwSelectionInsertDetailSchema.safeParse(event.detail).success -> ignore
                      └─ BtwThreadWindow.onSelectionInsert(text)
                           ├─ admitting.current === true -> return false (unhandled -> plugin copies & shows "Copied instead")
                           └─ updateDraft({ type: "insert", text })
                              onFocusPane?.()
                              setMode(key, "open")
                              setPendingComposerFocus(true)
                              event.preventDefault(); event.stopPropagation() -> return true (plugin flashes "Added" / dismisses menu)
```

### Module boundaries and exact interfaces

#### Paseo (producer) — `/home/sinkerine/.paseo/worktrees/28vpgp2p/fast-fish`

1. `packages/app/src/btw/selection-contract.ts` (new, pure TypeScript + Zod, Node-testable with zero DOM globals):

```ts
import { z } from "zod";

export const BTW_SELECTION_TARGET_ATTRIBUTE = "data-btw-thread";
export const BTW_SELECTION_INSERT_EVENT = "paseo:btw-insert";

export const BtwSelectionInsertDetailSchema = z.object({
  text: z.string().min(1),
});

export interface BtwSelectionEventPort {
  readonly defaultPrevented: boolean;
  readonly detail?: unknown;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface BtwSelectionElementPort {
  setAttribute(qualifiedName: string, value: string): void;
  removeAttribute(qualifiedName: string): void;
  addEventListener(type: string, listener: (event: BtwSelectionEventPort) => void): void;
  removeEventListener(type: string, listener: (event: BtwSelectionEventPort) => void): void;
}

export function attachBtwSelectionTarget(
  element: BtwSelectionElementPort,
  onInsert: (text: string) => boolean,
): () => void;
```

- `attachBtwSelectionTarget` sets `element.setAttribute(BTW_SELECTION_TARGET_ATTRIBUTE, "")`, registers a listener for `BTW_SELECTION_INSERT_EVENT` that returns early if `event.defaultPrevented`, validates `event.detail` with `BtwSelectionInsertDetailSchema.safeParse`, calls `onInsert(parsed.data.text)`, and on `true` calls `event.preventDefault()` and `event.stopPropagation()`. Its cleanup removes both the listener and `BTW_SELECTION_TARGET_ATTRIBUTE`.

2. `packages/app/src/btw/selection-target.ts` (native/base) and `packages/app/src/btw/selection-target.web.ts` (web):

```ts
import type { RefObject } from "react";
import type { TextInput, View } from "react-native";

export interface BtwSelectionTargetInput {
  target: RefObject<View | null> | undefined;
  onInsert(text: string): boolean;
}

export function useBtwSelectionTarget(input: BtwSelectionTargetInput): void;
export function focusBtwComposerInput(input: TextInput | null): void;
```

- `selection-target.ts`: `useBtwSelectionTarget` is a no-op; `focusBtwComposerInput` calls `input?.focus()`.
- `selection-target.web.ts`:
  - Stores `onInsert` in a `useRef` so listener identity stays stable while always calling the latest closure.
  - `useEffect` reads `const node = target?.current; if (!(node instanceof HTMLElement)) return;` and returns `attachBtwSelectionTarget(node as unknown as BtwSelectionElementPort, (text) => onInsertRef.current(text))`.
  - `focusBtwComposerInput(input)` focuses `input`, places the caret at `end = input.value.length` via `setSelectionRange(end, end)` when `input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement`, and repeats once inside `window.requestAnimationFrame` if still mounted so `BtwSheet` overlay activation cannot leave focus elsewhere.

3. `packages/app/src/btw/draft.ts`:

```ts
export function appendBtwDraftSnippet(draft: string, snippet: string): string;
```

- `BtwDraftAction` gains `| { type: "insert"; text: string }`.
- `reduceBtwDraft` handles `"insert"` by returning `{ ...state, text: appendBtwDraftSnippet(state.text, action.text) }`.

4. `packages/app/src/btw/window.tsx` & `packages/app/src/btw/window-content.tsx` & `packages/app/src/panels/agent-panel.tsx`:

- `BtwWindow` props gain optional `selectionTarget?: RefObject<View | null>` and `onFocusPane?: () => void`, forwarded to `BtwThreadWindow`.
- `BtwThreadWindow` adds `const [pendingComposerFocus, setPendingComposerFocus] = useState(false)`, `clearComposerFocus = useCallback(() => setPendingComposerFocus(false), [])`, and `onSelectionInsert`:
  - if `admitting.current` is `true`, return `false`;
  - call `updateDraft({ type: "insert", text })`, `onFocusPane?.()`, `setMode(key, "open")`, `setPendingComposerFocus(true)`, and return `true`.
- `BtwContentProps` gains `pendingComposerFocus?: boolean` and `onComposerFocusHandled?: () => void`. `BtwWindowContent` attaches `inputRef = useRef<TextInput>(null)` to `SheetAwareTextInput` and runs an effect when `pendingComposerFocus` is `true`: if `inputRef.current` is mounted, call `focusBtwComposerInput(inputRef.current)` and `onComposerFocusHandled?.()`. Because `pendingComposerFocus` stays `true` until `BtwWindowContent` mounts (`BtwFloatingCard` in the same commit; `BtwSheet` once `present()` mounts portal content) and is cleared immediately once handled, subsequent manual `btw-chip` toggles never replay stale focus.
- `agent-panel.tsx`: `AgentConversationPanel` reads `const { isInteractive, focusPane } = usePaneFocus()`, threads `onFocusPane={focusPane}` through `AgentPanelContent` -> `AgentPanelBody`, attaches `streamContentRef = useRef<View>(null)` to the `streamContent` `<View>` (~line 1191), and passes `selectionTarget={streamContentRef}` and `onFocusPane={onFocusPane}` to `<BtwWindow>`.

5. `packages/server/src/server/daemon-e2e/fixtures/pi-btw-stub/http-stub.ts`:

- Preserve existing `PARENT_A`, `HOLD_PARENT`, `HOLD_BTW`, `AFTER_B`, and `FAIL_BTW` responses unchanged.
- When `!isBtw && question.includes("RICH_PARENT")`, set `text` to a deterministic multi-surface Markdown reply containing:
  - prose line `PARENT_RICH_PROSE`;
  - fenced TypeScript block ` ```ts\nconst answer = 42;\n``` `;
  - fenced plain-text block ` ```txt\nGUTTER_LINE_ONE\nGUTTER_LINE_TWO\n``` ` (renders `MarkdownCodePreview` with raw-line gutter `[data-testid="preview-line-numbers"]`);
  - Markdown table `| Metric | Value |\n| --- | --- |\n| Latency | 42ms |` (renders `MdTable` with `[data-testid="markdown-table-cell"]`).

#### Better Paseo (consumer) — `/home/sinkerine/.paseo/worktrees/28vpgp2p/better-paseo-add-to-btw`

1. `client/components/selection-actions.ts`:

```ts
export const BTW_TARGET_SELECTOR = "[data-btw-thread]";
export const BTW_INSERT_EVENT = "paseo:btw-insert";
export function canInsertIntoBtw(from: Element | null): boolean;
export function insertIntoBtw(snippet: string, from: Element | null): boolean;
```

- `canInsertIntoBtw(from)` returns `Boolean(from?.closest?.(BTW_TARGET_SELECTOR))`.
- `insertIntoBtw(snippet, from)` returns `false` when `!from || !snippet`, otherwise `!from.dispatchEvent(new CustomEvent(BTW_INSERT_EVENT, { bubbles: true, cancelable: true, detail: { text: snippet } }))`.
- Add `btw` icon (`messages-square` SVG paths) to `ICONS`.
- **Critical CSS detail:** add `.btn[hidden] { display: none; }` to `BAR_CSS` (otherwise author `.btn { display: inline-flex; }` overrides the UA `[hidden]` rule).
- `createBar` creates `btwButton = makeButton("Add to BTW", "btw", ...)` after `addButton`; its click handler re-reads `readSelection()`, calls `insertIntoBtw(quote(snapshot), snapshot.element)`, flashes `"Added"` on `true`, or calls `void copyText(snapshot.text)` and flashes `"Copied instead"` on `false`.
- `reset()` repaints `[copyButton, addButton, btwButton]`.
- `Bar.show(rect: DOMRect, options?: { btw?: boolean }): void` sets `btwButton.hidden = !options?.btw` before measuring `bar.offsetWidth` so horizontal viewport clamping uses the actual 2- or 3-button width. `sync()` passes `{ btw: canInsertIntoBtw(snapshot.element) }`.

2. `client/components/markdown/render/table-copy-menu.tsx`:

- Thread `frame` into `SelectionCopyMenu` -> `SelectionMenu` as fallback anchor alongside `anchorRef`.
- Import `useToast` and `copyText` from `@getpaseo/plugin/client/react-native`, and `canInsertIntoBtw`, `insertIntoBtw` from `../../selection-actions`.
- In `SelectionMenu`, maintain `const [btw, setBtw] = useState(false)` updated in `useLayoutEffect` from `open && Platform.OS === "web" && canInsertIntoBtw((anchorRef.current ?? frame.current) as unknown as Element | null)` whenever `[open, selectedText, frame]` changes.
- Keep `onLayout` synchronous (`const { width: rowWidth } = event.nativeEvent.layout; setMeasured(Math.ceil(rowWidth) + BORDER * 2);`) in strict compliance with `pooled-event-reads.test.ts`.
- When `btw` is `true`, render an **Add to BTW** `Pressable` (`accessibilityLabel={open ? "Add to BTW" : undefined}`, `<Icon name="MessagesSquare" ... />`) immediately after **Add to chat**. On press: if `insertIntoBtw(quoteCell(selected.text), (anchorRef.current ?? frame.current) as unknown as Element | null)` returns `true`, call `selected.dismiss()`; otherwise copy `selected.text` via `copyText`, show `toast.show(toolbarLabel("Copied instead", language))` (or `toast.error(toolbarLabel("Couldn't copy", language))` on clipboard rejection), and keep the menu open.

3. `client/i18n/toolbar-strings.ts` & `client/i18n/settings-page-strings.ts`:

- `toolbar-strings.ts`: add `"Add to BTW": "添加到 BTW"`.
- `settings-page-strings.ts`: update `selectionDescription` in both `en` and `zh` to mention **Add to BTW** / `添加到 BTW` when a chat has a BTW conversation.

### Error handling and compatibility

- **Fail-closed, visible fallback:** malformed event details do nothing; refused inserts leave `defaultPrevented === false`, causing both the selection bar and table menu to copy the raw selection and surface `"Copied instead"` (`docs/testing.md`).
- **Platform gating:** Metro file extensions (`selection-target.ts` vs `selection-target.web.ts`), with zero `isWeb` branches or DOM casts in `window.tsx` / `window-content.tsx` (`CLAUDE.md`).
- **Cross-version safety:** no wire protocol, persistence, or plugin SDK version bump. New plugin + old Paseo shows no chip; old plugin + new Paseo ignores `data-btw-thread`.
- **Coexistence with `macho-lionfish`:** no keydown handler changes in `window-content.tsx`; potential merge overlap is limited to `BtwContentProps` and `SheetAwareTextInput` ref prop.

## 3. Tasks

### T1 — Paseo BTW selection target contract, host wiring, and host contract tests (producer)

- **Goal:** Prove initial browser/plugin capability on unmodified code first; then implement Paseo's web selection marker/listener contract, BTW draft `insert` action + separator, pane focus + composer caret focus, deterministic `RICH_PARENT` stub fixture, Paseo docs, Node ports-and-adapters unit tests, and Paseo's inline-plugin browser contract test.
- **Repository:** `/home/sinkerine/.paseo/worktrees/28vpgp2p/fast-fish`
- **Pre-implementation capability gate (must pass before editing `packages/app/src/`):** create `packages/app/e2e/browser/btw-selection-insert.spec.ts` with the `"capability: Better Paseo selection bar renders on assistant reply"` test and run row 1 of §4 against unmodified `/home/sinkerine/dev/better-paseo` (`5d26670c`).
- **Owned files:**
  - New: `packages/app/src/btw/selection-contract.ts`, `packages/app/src/btw/selection-target.ts`, `packages/app/src/btw/selection-target.web.ts`, `packages/app/src/btw/selection-target.test.ts`, `packages/app/e2e/browser/btw-selection-insert.spec.ts` (initial capability + Journey 0 host contract; extended in T2).
  - Changed: `packages/app/src/btw/draft.ts`, `packages/app/src/btw/draft.test.ts`, `packages/app/src/btw/window.tsx`, `packages/app/src/btw/window-content.tsx`, `packages/app/src/panels/agent-panel.tsx`, `packages/server/src/server/daemon-e2e/fixtures/pi-btw-stub/http-stub.ts`, `docs/plugins.md`.
  - Untouched: `packages/app/src/btw/window.test.tsx` (do not add JSDOM tests; run existing file only as neighbour regression).
- **Produces:** `BTW_SELECTION_TARGET_ATTRIBUTE` (`data-btw-thread`), `BTW_SELECTION_INSERT_EVENT` (`paseo:btw-insert`), `attachBtwSelectionTarget`, `useBtwSelectionTarget`, `focusBtwComposerInput`, `appendBtwDraftSnippet`, `BtwWindow` `selectionTarget`/`onFocusPane`, and `RICH_PARENT` HTTP stub replies.
- **Consumes:** `useBtwWindowStore`, `reduceBtwDraft`, `usePaneFocus`, `SheetAwareTextInput`, `btwBrowserTest`.
- **Dependencies:** none.
- **Unit command:** `npx vitest run packages/app/src/btw/draft.test.ts packages/app/src/btw/selection-target.test.ts --bail=1`

### T2 — Better Paseo Add to BTW chip and full cross-repo browser acceptance journey (consumer)

`Split: separate producer — Better Paseo lives in a separate repository (/home/sinkerine/dev/better-paseo) with its own build pipeline, Hermes compiler gate, and test runner, and consumes T1's DOM contract across the plugin runtime boundary.`

- **Goal:** Create the authorized isolated Better Paseo worktree, prove plugin worktree capability first, implement **Add to BTW** on the selection bar and table selection menu with bilingual strings/docs and plugin unit tests, and extend `packages/app/e2e/browser/btw-selection-insert.spec.ts` with Journeys 1–3 driving the real modified Better Paseo plugin against T1's Paseo host.
- **Repositories:**
  1. New isolated plugin worktree `/home/sinkerine/.paseo/worktrees/28vpgp2p/better-paseo-add-to-btw` created via:
     `git -C /home/sinkerine/dev/better-paseo worktree add -b feat/add-to-btw-chip /home/sinkerine/.paseo/worktrees/28vpgp2p/better-paseo-add-to-btw 5d26670c`
     Verify `git -C /home/sinkerine/.paseo/worktrees/28vpgp2p/better-paseo-add-to-btw diff --quiet 5d26670c -- package.json package-lock.json`, then symlink `ln -s /home/sinkerine/dev/better-paseo/node_modules /home/sinkerine/.paseo/worktrees/28vpgp2p/better-paseo-add-to-btw/node_modules` (read-only; no `npm install`/`npm ci`). Verify no `index.client.ts` exists in the worktree root so Paseo's directory-plugin compiler (`compiler-build.ts:407`) compiles `index.client.tsx` from source.
  2. `/home/sinkerine/.paseo/worktrees/28vpgp2p/fast-fish` (sequentially after T1 finishes; single writer per worktree).
- **Pre-implementation capability gate (must pass before editing Better Paseo `client/`):** run §4 row 8 in the new plugin worktree (`selection-composer.test.ts`, `markdown-table-copy-menu.test.ts`, `check:hermes`, and `btw-selection-insert.spec.ts --grep "capability"` pointed at `PASEO_BETTER_PASEO_SOURCE=/home/sinkerine/.paseo/worktrees/28vpgp2p/better-paseo-add-to-btw`).
- **Owned files (Better Paseo worktree):**
  - New: `test/unit/selection-bar-btw.test.ts`.
  - Changed: `client/components/selection-actions.ts`, `client/components/markdown/render/table-copy-menu.tsx`, `client/i18n/toolbar-strings.ts`, `client/i18n/settings-page-strings.ts`, `test/unit/markdown-table-copy-menu.test.ts`, `README.md`, `README-zh.md`.
- **Owned files (Paseo worktree, after T1 completes):**
  - Changed: `packages/app/e2e/browser/btw-selection-insert.spec.ts` (add Journeys 1–3 using `PASEO_BETTER_PASEO_SOURCE`, throwing `NEEDS_CONTEXT` if unset — no `test.skip`).
- **Consumes:** T1's `data-btw-thread` / `paseo:btw-insert` DOM contract and `RICH_PARENT` stub replies.
- **Produces:** User-visible **Add to BTW** chip on selection bar and table selection menu, plus full cross-repo Playwright evidence.
- **Dependencies:** T1 (strictly sequential).
- **Unit command (plugin worktree):** `npx vitest run test/unit/selection-bar-btw.test.ts test/unit/markdown-table-copy-menu.test.ts test/unit/selection-composer.test.ts test/unit/selection-bar-scroll.test.ts test/unit/selection-bar-claim.test.ts test/unit/settings-strings.test.ts test/unit/toolbar-strings.test.ts test/unit/pooled-event-reads.test.ts`

### Conflicts and external dependencies

- T1 and T2 execute sequentially; at most one writer touches `fast-fish` or `better-paseo-add-to-btw` at any time.
- `macho-lionfish` touches BTW composer key handling; this plan avoids keydown handlers in `window-content.tsx`.
- Runtime prerequisites on host `kazuki` (verified present): `/home/sinkerine/.nix-profile/bin/pi` (`1.4.0`), `/home/sinkerine/dev/pi-btw` (`7ea4f10`), `/home/sinkerine/dev/better-paseo` (`5d26670c`), and development-shell Chromium libs.
- No network access, package installs, pushes, PRs, Nix pin updates, or daemon-6767 interactions.

## 4. Test and verification

Execute sequentially in the order below. Never run Paseo's full Vitest or Playwright suites locally. Acquire `/home/sinkerine/dev/paseo/.git/worktrees/fast-fish/e2e-feature-build.lock` around workspace builds, `typecheck`, Playwright runs, `expo export`, and Better Paseo's full unit/Hermes runs so heavy steps never contend (`max concurrency = 1`). Never touch port `6767` (Playwright's `global-setup.ts` reserves dynamic ports and excludes `6767`/`6768`).

### Prerequisites and generated inputs

- **Paseo workspace build prerequisites:** `packages/app` and Playwright's in-process E2E daemon consume generated JS/declarations from `@getpaseo/protocol` (including `zod-aot` validators), `@getpaseo/client`, `@getpaseo/highlight`, `@getpaseo/plugin`, `@getpaseo/expo-two-way-audio`, and `@getpaseo/server`. Run `npm run build:server && npm run build --workspace=@getpaseo/expo-two-way-audio` (row 0) once before capability/typecheck/build/E2E so all cross-package `dist/` outputs are current (`CLAUDE.md`).
- **BTW E2E environment variables:** `PASEO_PI_BINARY=/home/sinkerine/.nix-profile/bin/pi` (`1.4.0`) and `PASEO_PI_BTW_PACKAGE=/home/sinkerine/dev/pi-btw` (required by `createBtwRuntime(false)` in `packages/server/src/server/daemon-e2e/fixtures/pi-btw-stub/runtime.ts`).
- **Better Paseo directory source:** `PASEO_BETTER_PASEO_SOURCE` points to `/home/sinkerine/dev/better-paseo` in row 1 (pre-T1 capability) and `/home/sinkerine/.paseo/worktrees/28vpgp2p/better-paseo-add-to-btw` in rows 8 and 14 (T2 capability and full journey). Paseo's `compileDirectoryPlugin` compiles `index.client.tsx` on the fly; no `index.client.ts` may exist in the plugin worktree root.

### Verification inventory

| #   | Stage & scope                                                                          | Exact command (`cwd`)                                                                                                                                                                                                                                                                                                                                   | Runner / notes / side effects                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | Workspace generated prereqs & isolated unit smoke                                      | `npm run build:server && npm run build --workspace=@getpaseo/expo-two-way-audio && npx vitest run packages/app/src/btw/draft.test.ts --bail=1` (`fast-fish`)                                                                                                                                                                                            | Builds protocol, client, highlight, plugin, relay, server, cli, and audio `dist/` outputs; runs fast Node smoke. Writes gitignored `dist/` only.                                                                                                                                           |
| 1   | **Pre-T1 capability check** (before editing `packages/app/src/`)                       | `PASEO_PI_BINARY=/home/sinkerine/.nix-profile/bin/pi PASEO_PI_BTW_PACKAGE=/home/sinkerine/dev/pi-btw PASEO_BETTER_PASEO_SOURCE=/home/sinkerine/dev/better-paseo npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/btw-selection-insert.spec.ts --project=browser --grep "capability"` (`fast-fish`, dev shell)                                  | Playwright `browser` project (Chromium + Metro + isolated daemon). Proves unmodified plugin + BTW stub render `[data-bcselectionbar]` before T1 implementation.                                                                                                                            |
| 2   | T1 Node units (ports & adapters + reducer)                                             | `npx vitest run packages/app/src/btw/draft.test.ts packages/app/src/btw/selection-target.test.ts --bail=1` (`fast-fish`)                                                                                                                                                                                                                                | Vitest `unit` project (`environment: "node"`). Failing-first before T1 implementation, green after. Zero JSDOM/mocks.                                                                                                                                                                      |
| 3   | T1 `btw/` neighbour regressions                                                        | `npx vitest run packages/app/src/btw --bail=1` (`fast-fish`)                                                                                                                                                                                                                                                                                            | Runs all existing `packages/app/src/btw/*.test.*` (`draft`, `selection-target`, `pill`, `select`, `send`, `window-store`, existing `window`).                                                                                                                                              |
| 4   | T1 host-contract browser acceptance                                                    | `PASEO_PI_BINARY=/home/sinkerine/.nix-profile/bin/pi PASEO_PI_BTW_PACKAGE=/home/sinkerine/dev/pi-btw PASEO_BETTER_PASEO_SOURCE=/home/sinkerine/dev/better-paseo npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/btw-selection-insert.spec.ts --project=browser --grep "capability\|host contract"` (`fast-fish`, dev shell)                   | Proves T1's real `BtwWindow`/`agent-panel.tsx` DOM contract (`data-btw-thread`, `paseo:btw-insert`, malformed-detail refusal) in Chromium via inline fixture plugin before T2 starts.                                                                                                      |
| 5   | Paseo consumer typecheck                                                               | `npm run typecheck` (`fast-fish`)                                                                                                                                                                                                                                                                                                                       | Workspace-wide `tsgo --noEmit` across every package consuming `BtwWindow`, `BtwWindowContent`, and `draft.ts`.                                                                                                                                                                             |
| 6   | Paseo consumer web build                                                               | `npm run build --workspace=@getpaseo/app` (`fast-fish`)                                                                                                                                                                                                                                                                                                 | Runs `npm run build:app-deps && expo export --platform web`, bundling all changed web/consumer modules into gitignored `packages/app/dist/`.                                                                                                                                               |
| 7   | Paseo lint & format                                                                    | `npm run lint && npm run format:files -- <T1/T2 Paseo files> && npm run format:check` (`fast-fish`)                                                                                                                                                                                                                                                     | `oxlint` + `oxfmt`. **Note:** `format:files` **rewrites files in place**; inspect `git diff` afterward. Re-run after T2 updates `btw-selection-insert.spec.ts`.                                                                                                                            |
| 8   | **Pre-T2 capability check** (after worktree creation, before editing plugin `client/`) | In plugin worktree: `npx vitest run test/unit/selection-composer.test.ts test/unit/markdown-table-copy-menu.test.ts && npm_config_offline=true npm run check:hermes`; then in `fast-fish`: row 1 command with `PASEO_BETTER_PASEO_SOURCE=/home/sinkerine/.paseo/worktrees/28vpgp2p/better-paseo-add-to-btw`                                             | Proves isolated Better Paseo worktree + symlinked `node_modules` pass Vitest, Hermes V1/legacy compilation and ASCII checks, and live Paseo directory compilation before T2 edits.                                                                                                         |
| 9   | T2 targeted plugin units                                                               | `npx vitest run test/unit/selection-bar-btw.test.ts test/unit/markdown-table-copy-menu.test.ts test/unit/selection-composer.test.ts test/unit/selection-bar-scroll.test.ts test/unit/selection-bar-claim.test.ts test/unit/settings-strings.test.ts test/unit/toolbar-strings.test.ts test/unit/pooled-event-reads.test.ts` (`better-paseo-add-to-btw`) | Vitest (`environment: "node"`). Failing-first for new BTW cases, green after implementation; includes AST `pooled-event-reads` and `en`/`zh` parity checks.                                                                                                                                |
| 10  | Plugin consumer typecheck                                                              | `npm run typecheck` (`better-paseo-add-to-btw`)                                                                                                                                                                                                                                                                                                         | `tsc --noEmit` over the plugin client, server, shared, and tests.                                                                                                                                                                                                                          |
| 11  | Plugin consumer client bundle build                                                    | `rm -rf /tmp/better-paseo-add-to-btw-build && node scripts/build-client.mjs --out /tmp/better-paseo-add-to-btw-build` (`better-paseo-add-to-btw`)                                                                                                                                                                                                       | Builds minified `index.client.ts` + `tasks-chunk.ts` and shared-module registry into `/tmp/better-paseo-add-to-btw-build` without writing `index.client.ts` into the worktree.                                                                                                             |
| 12  | Plugin Hermes V1 & legacy compilation gate                                             | `npm_config_offline=true npm run check:hermes` (`better-paseo-add-to-btw`)                                                                                                                                                                                                                                                                              | Runs `check-hermes.mjs` on raw `index.client.tsx` and `--built` (`build-client.mjs` output): requires ASCII-only output and V1/legacy bytecode compilation for raw and built bundle/chunk. Per user approval, standalone VM execution is unrun and not required; do not acquire a runtime. |
| 13  | Plugin full unit suite (per Better Paseo `CLAUDE.md`)                                  | `npm test > /tmp/better-paseo-unit.txt 2>&1` then inspect `/tmp/better-paseo-unit.txt` (`better-paseo-add-to-btw`)                                                                                                                                                                                                                                      | Required by Better Paseo's repository rules before committing there (~290 fast Node-env files; Paseo's no-full-suite rule applies to Paseo workspaces). Do not overlap with rows 14–15.                                                                                                    |
| 14  | **Full cross-repo feature E2E journey** (real-counterpart contract check)              | `PASEO_PI_BINARY=/home/sinkerine/.nix-profile/bin/pi PASEO_PI_BTW_PACKAGE=/home/sinkerine/dev/pi-btw PASEO_BETTER_PASEO_SOURCE=/home/sinkerine/.paseo/worktrees/28vpgp2p/better-paseo-add-to-btw npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/btw-selection-insert.spec.ts --project=browser` (`fast-fish`, dev shell)                     | Runs capability, Journey 0, Journey 1 (wide), Journey 2 (compact), and Journey 3 (absent extension). Every test must report **passed** (0 skipped). Copy PNG screenshots and `btw-runtime-worker-*.json` into `$runDir/artifacts/`.                                                        |
| 15  | Existing BTW regression journey                                                        | `PASEO_PI_BINARY=/home/sinkerine/.nix-profile/bin/pi PASEO_PI_BTW_PACKAGE=/home/sinkerine/dev/pi-btw npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/pi-btw-window.spec.ts --project=browser` (`fast-fish`, dev shell)                                                                                                                        | Verifies `window.tsx`, `window-content.tsx`, and `http-stub.ts` changes did not regress existing wide/compact BTW lifecycle, scroll landing, restart recovery, or absent-extension fallback.                                                                                               |

- **Nix hashes:** `package-lock.json` is untouched in Paseo; if any lockfile diff appears unexpectedly, fail and check `bash scripts/update-nix.sh --check`.
- **Future pushes and deployments:** rows 0, 2, 3, 5, 6, 7 (Paseo) and rows 9–13 (Better Paseo) remain required; Playwright E2E rows 1, 4, 14, and 15 are required for this initial feature implementation run only (`docs/testing.md`).

### Representative capability checks

- **Pre-T1 (row 1) & Pre-T2 (row 8) — Chromium + Metro + isolated daemon + Pi BTW stub + directory-compiled Better Paseo:**
  - _Entry:_ `btwBrowserTest(false)` launches an isolated daemon with Pi `1.4.0` + `pi-btw` + `startBtwHttpStub()`, enables plugins, and calls `client.installDirectoryPlugin(PASEO_BETTER_PASEO_SOURCE)`.
  - _Readiness:_ `launchBtwAgent` opens the agent route; submitting `PARENT_A` renders `PARENT_A_FINISHED` inside `[data-bcselection]`.
  - _Action:_ select `PARENT_A_FINISHED` with a real DOM `Range` + `Selection`.
  - _Observation:_ `[data-bcselectionbar]` becomes visible (`display: block`) in the top layer.
  - _Precision:_ inspect `host.shadowRoot.querySelectorAll("button")` `aria-label` list — exact match `["Copy", "Add to chat"]` before T2.
  - _Evidence:_ PNG screenshot `00-capability-selection-bar.png`.

### Target coverage matrix

| Target                                                                        | Coverage status                                                                                              | Verification                                                                                                                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser web — wide (`1440×900`, `BtwFloatingCard`, split panes, multi-window) | Executable                                                                                                   | Rows 1, 4, 6, 14, 15                                                                                                                            |
| Browser web — compact (`390×844`, `BtwSheet` portal)                          | Executable                                                                                                   | Rows 14, 15                                                                                                                                     |
| Electron desktop renderer                                                     | Covered by Chromium renderer evidence (D10)                                                                  | Rows 5, 6, 14, 15 — zero `.electron.*` files or `getIsElectron()` branches touched; identical `Platform.OS === "web"` bundle and plugin runtime |
| iOS & Android native                                                          | No UI change by design (D6); `selection-target.ts` no-op; plugin bundle Hermes-compiled; standalone VM unrun | Rows 5, 9 (`native` branch in `markdown-table-copy-menu.test.ts`), 12 (`npm run check:hermes`)                                                  |

## 5. E2E journey (`packages/app/e2e/browser/btw-selection-insert.spec.ts`)

No `test.skip` or conditional env gates (`docs/testing.md`): `PASEO_BETTER_PASEO_SOURCE` is required and throws `new Error("NEEDS_CONTEXT: set PASEO_BETTER_PASEO_SOURCE to the Better Paseo plugin directory")` if unset, matching `createBtwRuntime`. Each test installs the plugin via `client.patchDaemonConfig({ pluginsEnabled: true })` and `client.installDirectoryPlugin(pluginDir)`, and removes the plugin + restores config + closes agents in `finally`.

### Capability test (`"capability: Better Paseo selection bar renders on assistant reply"`)

- Launch Pi agent via `launchBtwAgent(page, btwRuntime)` at `1440×900`, submit `PARENT_A`, wait for `[data-bcselection]` containing `PARENT_A_FINISHED`, select `PARENT_A_FINISHED`, assert `[data-bcselectionbar]` shadow-root buttons start with `["Copy", "Add to chat"]`, capture `00-capability-selection-bar.png`.

### Journey 0 — Paseo host contract (`"host contract: data-btw-thread lifecycle and malformed detail rejection"`)

- Install a minimal inline directory plugin in a temp folder (`id: "btw-contract-e2e"`) that renders assistant text inside `[data-bcselection]`.
- Before `/btw`, assert `page.locator("[data-btw-thread]")` has count `0`.
- Create a BTW thread (`HOLD_PARENT` + `askBtwFromRunningMainComposer(page, "CONTRACT_Q")` + release), assert `[data-btw-thread]` has count `1`.
- Dispatch `new CustomEvent("paseo:btw-insert", { bubbles: true, cancelable: true, detail: { text: "" } })` and `{ detail: null }` on `[data-btw-thread]`: assert `dispatchEvent` returns `true` (not `defaultPrevented`) and `btw-composer` stays `""`.
- Minimize `btw-window`, dispatch valid `{ detail: { text: "> CONTRACT_OK\n\n" } }`: assert `dispatchEvent` returns `false` (`defaultPrevented`), `btw-window` opens, and `btw-composer` is focused with value `"> CONTRACT_OK\n\n"`.

### Journey 1 — Full wide selection surfaces, multi-pane/multi-window isolation, and BTW lifecycle (`1440×900`)

1. **No thread yet across all 4 entry paths (AC1 negative):**
   - Launch `Agent A`, submit `RICH_PARENT`, wait for `PARENT_RICH_PROSE`, `const answer = 42;`, `GUTTER_LINE_ONE`, and table cell `42ms`.
   - (a) Select `PARENT_RICH_PROSE` -> bar buttons equal `["Copy", "Add to chat"]` (no `"Add to BTW"`). Capture `01-wide-no-thread.png`.
   - (b) Select `const answer = 42;` inside `[data-bccode]` -> bar buttons equal `["Copy", "Add to chat"]`.
   - (c) Click `Open Markdown in a window` on the `txt` block, click `Show raw text`, click line 1 in `[data-testid="preview-line-numbers"]` -> bar buttons equal `["Copy", "Add to chat"]`. Close preview (`Close`).
   - (d) `dblclick` `[data-testid="markdown-table-cell"]` with `42ms` -> `[data-testid="table-selection-menu-row"]` shows `"Copy selected cell"` and `"Add to chat"`, with zero `"Add to BTW"`. Press `Escape` to dismiss cell selection.
2. **Create BTW thread & re-read availability (AC1 dynamic):**
   - Submit `HOLD_PARENT`, run `askBtwFromRunningMainComposer(page, "FIRST_Q")`, release `"parent"`, wait for `btw-stop` count `0` and `BTW_REPLY CONTEXT_A`.
   - Click `btw-minimize` (`btw-window` hidden).
3. **Prose selection -> open minimized card & focus at end (AC1a, AC2, AC4f):**
   - Select `PARENT_RICH_PROSE` -> bar buttons equal `["Copy", "Add to chat", "Add to BTW"]`. Capture `02-wide-chip-visible.png`.
   - Click `"Add to BTW"` -> button flashes `"Added"`; `btw-window` becomes visible; `btw-composer` is focused (`selectionStart === selectionEnd === value.length`) with `"> PARENT_RICH_PROSE\n\n"`; main composer draft is `""`.
4. **Code block selection -> separator & open card stays open (AC1b, AC2, AC4f):**
   - Type `"Note"` at the end of `btw-composer` (value ends without `\n`). Select `const answer = 42;` in `[data-bccode]` and click `"Add to BTW"` -> `btw-window` stays open; `btw-composer` is focused at end with `"> PARENT_RICH_PROSE\n\nNote\n\n\`\`\`\nconst answer = 42;\n\`\`\`\n\n"`.
5. **Preview gutter whole-line selection (AC1c, AC2):**
   - Clear `btw-composer`, click `btw-minimize`. Click `Open Markdown in a window` on the `txt` block, click `Show raw text`, click line 1 in `[data-testid="preview-line-numbers"]` -> bar buttons equal `["Copy", "Add to chat", "Add to BTW"]`. Click `"Add to BTW"` -> `btw-window` opens and `btw-composer` holds `"\`\`\`\nGUTTER_LINE_ONE\n\`\`\`\n\n"`. Close the preview window via its `Close` button.
6. **Table-cell selection menu + send + BTW card self-selection (AC1d, AC1e, AC2, AC5):**
   - Click `btw-minimize`. `dblclick` `[data-testid="markdown-table-cell"]` containing `42ms` -> `[data-testid="table-selection-menu-row"]` shows `"Copy selected cell"`, `"Add to chat"`, `"Add to BTW"`. Capture `03-table-menu-btw.png`.
   - Click `"Add to BTW"` -> table menu dismisses, `btw-window` opens, `btw-composer` is focused at end with `"\`\`\`\nGUTTER_LINE_ONE\n\`\`\`\n\n> 42ms\n\n"`.
   - Click `btw-send` -> BTW timeline receives the user message and `BTW_REPLY CONTEXT_A`, `btw-composer` reconciles to `""`, and main agent user-message count (`client.fetchAgentTimeline`) is unchanged. Capture `04-sent-btw-quote.png`.
   - With `btw-window` open, select `BTW_REPLY CONTEXT_A` inside `btw-window`'s own transcript and click `"Add to BTW"` -> `btw-composer` receives `"> BTW_REPLY CONTEXT_A\n\n"`. Clear `btw-composer`.
7. **Add to chat & cross-surface boundary preserved (AC5, AC1 boundary):**
   - Select `PARENT_RICH_PROSE` and click `"Add to chat"` -> main composer receives `"> PARENT_RICH_PROSE\n\n"` and `btw-composer` stays `""`. Clear main composer.
   - Set a DOM selection spanning from `PARENT_RICH_PROSE` into the pane header outside `[data-bcselection]` -> `[data-bcselectionbar]` remains hidden.
8. **Lifecycle transitions — admission refusal, failed ask, and streaming reconciliation (AC3, AC4a–c):**
   - _8a Admission refusal:_ install `transport = await installDaemonWebSocketGate(page)`, fill `btw-composer` with `"AFTER_B held"`, call `transport.holdNextClientRequest("send_agent_message_request")`, click `btw-send`, `await transport.waitForHeldClientRequest()`. Select `PARENT_RICH_PROSE` and click `"Add to BTW"` -> bar button flashes `"Copied instead"` (refused while admitting). Release held request (`transport.releaseHeldClientRequest()`), wait for `BTW_REPLY AFTER_B` and `btw-composer` to reconcile to `""`. Select `PARENT_RICH_PROSE` and click `"Add to BTW"` -> flashes `"Added"` and `btw-composer` holds `"> PARENT_RICH_PROSE\n\n"`. Clear `btw-composer`.
   - _8b Failed ask recovery:_ `await askBtw(page, "FAIL_BTW")`, wait for `btw-provider-error` visible and `btw-composer` value `"FAIL_BTW"`. Select `PARENT_RICH_PROSE` and click `"Add to BTW"` -> `btw-composer` holds `"FAIL_BTW\n\n> PARENT_RICH_PROSE\n\n"`. Clear `btw-composer`.
   - _8c Streaming answer reconciliation:_ `await askBtw(page, "HOLD_BTW")`, wait for `stub.pending("btw") === 1`, `btw-stop` visible, and `btw-composer` cleared to `""`. While streaming, select `PARENT_RICH_PROSE` and click `"Add to BTW"` -> `btw-composer` becomes `"> PARENT_RICH_PROSE\n\n"`. Call `stub.release("btw")`, wait for `btw-stop` count `0`, and assert `btw-composer` still equals `"> PARENT_RICH_PROSE\n\n"`.
9. **Thread replacement (`btw-new`) and thread removal (`btw-clear`) (AC4d, AC1 negative):**
   - Record `firstThreadId = await window.getAttribute("aria-label")`. Click `btw-new` -> wait for `window` `aria-label` to differ from `firstThreadId` and `btw-composer` to equal `""`. Click `btw-minimize`, select `PARENT_RICH_PROSE`, click `"Add to BTW"` -> new `btw-window` opens with `"> PARENT_RICH_PROSE\n\n"`.
   - Click `btw-clear` -> `btw-window` hides and `btw-chip` count becomes `0`. Select `PARENT_RICH_PROSE` -> bar buttons equal `["Copy", "Add to chat"]` (no `"Add to BTW"`).
10. **Split-pane isolation, pane focus transfer, and archived pane (AC1 negative, AC4e, D9):**
    - Recreate a BTW thread on `Agent A` (`HOLD_PARENT` + `askBtwFromRunningMainComposer(page, "PANE_A")` + release).
    - Run `runWorkspaceActionFromCommandCenter(page, "Split pane right")` and launch `Agent B` in the right split pane; submit `PARENT_A` on `Agent B` (no BTW thread on `Agent B`).
    - Select `PARENT_A_FINISHED` in `Agent B`'s pane -> bar buttons equal `["Copy", "Add to chat"]` (no `"Add to BTW"` despite `Agent A`'s `[data-btw-thread]` mounted in the left pane).
    - Create a BTW thread on `Agent B` (`HOLD_PARENT` + `askBtwFromRunningMainComposer(page, "PANE_B")` + release). Now `Agent B`'s pane is focused (`Agent B`'s `btw-composer` is `""`) and `Agent A`'s pane is unfocused.
    - Select `PARENT_RICH_PROSE` in `Agent A`'s left pane and click `"Add to BTW"` -> `Agent A`'s pane focuses, `Agent A`'s `btw-window` opens with `"> PARENT_RICH_PROSE\n\n"`, and focusing `Agent B`'s pane confirms `Agent B`'s `btw-composer` is still `""`.
    - Archive `Agent B` (`client.archiveAgent(agentB.agentId)`) while viewing `Agent B`'s pane -> composer unmounts (`!hasActiveComposer`), `Agent B`'s `BtwWindow` and `[data-btw-thread]` unmount, and selecting `PARENT_A_FINISHED` in `Agent B`'s archived pane shows `["Copy", "Add to chat"]` with no `"Add to BTW"`.
11. **Two browser windows showing the same agent (AC4e):**
    - Open `page2 = await page.context().newPage()`, navigate `page2` to `Agent A`'s URL, wait for `page2`'s `btw-window` visible with `btw-composer` `""`.
    - Clear `page`'s `btw-composer`, select `PARENT_RICH_PROSE` in `page`, and click `"Add to BTW"` -> `page`'s `btw-composer` holds `"> PARENT_RICH_PROSE\n\n"` while `page2`'s `btw-composer` stays `""`. Close `page2`.

### Journey 2 — Compact layout (`390×844`) and `BtwSheet` portal boundary (AC1, AC2, AC4f)

- Set viewport `390×844`, launch Pi agent, submit `PARENT_A`, wait for `PARENT_A_FINISHED`.
- Before thread: select `PARENT_A_FINISHED` -> bar buttons equal `["Copy", "Add to chat"]`.
- Create BTW thread (`HOLD_PARENT` + `askBtwFromRunningMainComposer(page, "COMPACT_Q")` + release), dismiss `BtwSheet` via `btw-sheet-chip` (`btw-window` hidden).
- Select `PARENT_A_FINISHED` in main transcript -> bar buttons equal `["Copy", "Add to chat", "Add to BTW"]`. Click `"Add to BTW"` -> `BtwSheet` opens (`btw-window` visible), `btw-composer` is focused with `"> PARENT_A_FINISHED\n\n"`. Capture `05-compact-sheet-added.png`.
- Dismiss `BtwSheet` via `btw-sheet-chip` and reopen via `btw-chip` -> confirms normal toggle still works without replaying stale focus side effects.
- Select `BTW_REPLY CONTEXT_A` inside the open `BtwSheet` transcript (rendered in the root portal outside `[data-btw-thread]`) -> bar buttons equal `["Copy", "Add to chat"]` with no `"Add to BTW"`.

### Journey 3 — Pi agent without BTW extension (`btwBrowserTest(false, false)`) (AC1 negative)

- Install Better Paseo on the extension-less `btwBrowserTest(false, false)` worker (`1440×900`), launch Pi agent, submit `/btw no extension`, wait for `PARENT_A_FINISHED` in main transcript (`btw-chip` count `0`).
- Select `PARENT_A_FINISHED` -> bar buttons equal `["Copy", "Add to chat"]` with no `"Add to BTW"`. Capture `06-absent-extension-no-chip.png`.
