# BTW conversation in the Side pane — plan

Request: `/skill:e2e-feature move the btw from pop up to side panel.`

Run identity: worktree `/home/sinkerine/.paseo/worktrees/28vpgp2p/feat-btw-side-pane`, branch
`feat/btw-side-pane`, base `refs/heads/main` at `ce02bbe32df32050b1bafab8b3f97d2da3abf2b0`,
workspace `wks_a1e0afde2e6a527d`, project `prj_fd25e9856e774463`, orchestrator
`727c86fe-8ee5-4729-aaab-0d95ce7049dd`, mission `06278da1-6904-4755-b06f-24b6f365da28`, run dir
`/home/sinkerine/dev/paseo/.git/worktrees/feat-btw-side-pane/e2e-feature/btw-side-pane`.

Status: **worker integration checked; parent staging, independent acceptance and review R2 remain.**
The provisional feature checkpoint is `a231ade4865807788c1864fbfb92dc5a7b115ecf`
(tree `a898be9f69eb0871104c057fa490c74d8a596f4e`); the in-progress merge imports
committed main `8497d82207604509651c3b24a70bc24463784c98`. The original base above
remains historical. Parent owns staging, independent verification, review and merge completion. G1 is
resolved for native observation capability. The user subsequently exempted Android E2E for
this feature: AC11 is user-exempt, not passed. ASCII-only feature test inputs remain required.
Browser wide/compact proof, native JS export and the pre-E2E host inspection remain mandatory.

## 0. Findings (established from the code before design)

| #   | Finding                                                                                                                                                                                                                                                             | Source                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| F1  | BTW is mounted inside the parent agent pane as `<BtwWindow>` and gated by `hasActiveComposer && !draft`. Its chip is rendered by `<BtwPill>` in the composer track bar.                                                                                             | `packages/app/src/panels/agent-panel.tsx:1216-1229`, `packages/app/src/panels/agent-tracks.tsx:151`                      |
| F2  | Wide renders `BtwFloatingCard` (absolute 440px card, Escape hides). Compact renders `BtwSheet` (`IsolatedBottomSheetModal` 92%, `keyboardBehavior="extend"`, `keyboardBlurBehavior="restore"`, header BTW chip and Minimize).                                       | `packages/app/src/btw/floating-card.tsx`, `packages/app/src/btw/sheet.tsx`, `btw/window-content.tsx`                     |
| F3  | Draft, submitted question, failure recovery, dispatch pending and dispatch error are **component-local** (`useReducer`, `useMutation`, `admitting` ref) in `BtwThreadWindow`. This works only because minimize keeps the component mounted.                         | `packages/app/src/btw/window.tsx:57-122`                                                                                 |
| F4  | Visibility is an in-memory `byThread` map. `discover` opens a thread the first time this app session sees it, including after every page reload.                                                                                                                    | `packages/app/src/btw/window-store.ts`                                                                                   |
| F5  | A BTW thread is a provider-subagent descriptor `btw:<threadId>` with `presentation: "side_conversation"`. `/btw:new` removes the old id and upserts a new one. `/btw:clear` removes it. Empty `/btw` creates an idle thread.                                        | `packages/server/src/server/agent/providers/pi/extensions/pi-btw/index.ts:135,222-252`; pi-btw `src/commands.ts:449-458` |
| F6  | The Side pane is an ordinary pane holding workspace tabs. `open-beside.ts` owns placement: split-panes open beside, while compact and single-pane open in the main pane. Compact sheet placement comes from the panel manifest's `compactSheet`.                    | `packages/app/src/workspace-tabs/open-beside.ts`, `packages/app/src/panels/panel-manifest.ts`                            |
| F7  | The panel host retains three recent tabs plus modified tabs, and other tabs can remount. Moving a tab between sheet and pane remounts it. A component-local BTW state would lose drafts and pending guards on remount.                                              | `docs/explorer-sidebar.md` §Panel host contract, §Sheets                                                                 |
| F8  | Precedent for opening beside without interrupting the user: PR discovery uses `ensureSidePane(key, { focus: false })` plus a background `openTab`. `selectTabInPane` always sets `focusRequest` and dismisses sheets, so it cannot be used for a non-focusing show. | `packages/app/src/workspace-tabs/open-supporting-view.ts:92-133`, `stores/workspace-layout-store.ts:1530-1556`           |
| F9  | Workspace sheets (`SheetTabSheet`) use 92% snap points but the default Gorhom keyboard behavior. Every other app sheet with a text input uses `keyboardBehavior="extend"`. `SheetTab.policy` is available to the sheet container.                                   | `packages/app/src/screens/workspace/sheet-tabs.tsx:121-138`, `stores/workspace-layout-store.ts:120-124`                  |
| F10 | `supportsDesktopPaneSplits()` is `isWeb`. Headless Chromium at 1440×900 therefore runs the real split-panes Side pane. Electron uses the same renderer path, and no `.electron.*` module is involved.                                                               | `packages/app/src/constants/layout.ts:59-61`                                                                             |
| F11 | Escape interrupts an agent only through the composer whose pane is the active composer. A focused BTW pane is not that composer.                                                                                                                                    | `packages/app/src/composer/index.tsx:560-640`, `docs/keyboard-shortcuts.md` §Focus scopes                                |
| F12 | Existing BTW coverage: `packages/app/e2e/browser/pi-btw-window.spec.ts` (deterministic HTTP model stub with the real Pi 1.4.0 binary and the real pi-btw package (§5). Units use pure reducers, actual stores and typed                                             |

connection/read/send ports with in-memory adapters, following the final categorical rule in
`docs/testing.md`. Real Chromium journeys own component, DOM, focus, retention and portal proof.
The earlier component/mock R1 receipts remain historical; those suites have been migrated,
and the feature-added WebAnimations shim removed. Existing legacy repository tests are unchanged.

- **AC1 — Wide auto-open beside without taking focus (EP1, wide).** At 1440×900, the parent runs
  `HOLD_PARENT` and the user submits `/btw HOLD_BTW` from the running main composer. Then:
  - `btw-panel` becomes visible inside a `workspace-pane-*` element different from the one that
    contains the parent chat, and its bounding box lies to the right of the parent pane.
  - `workspace-tab-btw_<agentId>` exists and is the selected tab of that pane.
  - `document.activeElement` is still the parent's composer input. Typed text lands in the main
    composer and not in `btw-composer`.
  - The parent chat remains visible. Measure the parent pane's `agent-chat-scroll` as
    `scrollHeight - clientHeight - scrollTop`. It must be ≤ 2 before the submission (W0). It must
    still be ≤ 2 once the parent pane's width has stopped changing after the Side pane opens, with
    no `scroll-to-bottom-button` in the parent pane (W1b).
  - If a Side pane already holds another tab, the BTW tab is added to that pane and selected, with
    focus unchanged.
  - If the user had moved the BTW tab to another pane, a new thread leaves it in that pane. It is
    selected only when that pane is not the focused pane.
  - Evidence: E2E test `BTW wide side pane toggles during generation, retries and restores` (steps
    W0–W2), plus `packages/app/src/workspace-tabs/open-beside.test.ts` cases
    `showWorkspaceTargetBeside: new side pane without focus`, `…reuses side pane and selects
without focus`, `…leaves an existing tab in its pane`, `…does not select over the focused
pane`. The real main-composer entry matrix below additionally covers every EP1 spelling with
    both idle and held-running parents on wide layouts.
- **AC2 — Compact auto-open as a workspace sheet (EP1, compact).** At 390×844 the same action
  presents a workspace sheet:
  - `sheet-tab-header` contains `BTW`, `sheet-tab-body` contains `btw-panel`, and
    `sheet-tab-open-as-tab` has count 0.
  - The main composer keeps the text typed after submission.
  - Evidence: E2E `BTW compact sheet toggles during generation, retries and restores` (steps
    C1–C2), plus unit `open-beside.test.ts` `showWorkspaceTargetBeside: compact reveals the sheet
and keeps an existing pane tab`. The real main-composer entry matrix repeats every EP1 spelling
    with both idle and held-running parents on compact layouts.
- **AC3 — Discovery baseline (EP1, EP5).** A mounted parent pane auto-opens a BTW thread only if
  its id differs from the thread present when that pane's first successful provider-subagent list
  completed. After a reload with the BTW tab closed, the existing thread does not reopen:
  `btw-panel` count stays 0 for 5s after `btw-chip` is visible. After a reload with the tab open,
  the persisted tab is still present. A new thread id after the baseline opens exactly once. The
  same id reappearing after a transient removal does not reopen. A failed list establishes no
  baseline and opens nothing until a later successful list.
  - Evidence: E2E `BTW wide side pane lifecycle survives resize, reload and restart` (steps L4–L5),
    plus `packages/app/src/btw/auto-open.test.ts` (the production discovery controller,
    typed connection/list port, actual provider/layout stores and same-client reconnect).
- **AC4 — Chip toggles both ways without side effects (EP2).**
  - Wide: `btw-chip` has `aria-expanded="true"` while the BTW tab is the selected tab of a visible
    pane. Clicking it closes the tab: `btw-panel` count 0, and the empty Side pane is removed so the
    pane count returns to 1.
  - Clicking again reopens the same thread (`btw-panel` `aria-label` equals the previous thread id)
    in a new right split and focuses it.
  - Compact: the chip presents the sheet, and header Close or the backdrop hides it, returning to
    `btw-chip`.
  - On every layout, neither click sends a command (`stub.requests.length` unchanged), stops
    generation (`stub.pending("btw")` stays 1) or changes the thread id.
  - Evidence: E2E steps W3–W4 and C3–C4, E2E `BTW compact sheet backdrop dismissal preserves
generation and reopens the same thread`, plus `packages/app/src/btw/pill.test.ts` (real layout
    store: hidden→open beside, visible→close, present-but-unselected→reveal).
- **AC5 — Commands and duplicate prevention (EP3).**
  - Each control dispatches exactly one command, with the texts `/btw <q>`, `/btw:abort`,
    `/btw:inject`, `/btw:summarize`, `/btw:new` and `/btw:clear`, and the message id `""`.
  - While a dispatch is pending, further dispatches are ignored, including after the BTW tab is
    closed and reopened (unmount and mount) before the pending dispatch settles.
  - Send to main and Summarize to main are disabled for an empty thread and during generation.
    Stop is present only while running.
  - Evidence: `conversation-store.test.ts` covers pending ownership and retries through typed
    send functions, `send.test.ts` covers exact transport arguments and failure propagation, and
    the wide/compact browser controls exercise actual buttons, remounts and provider outcomes.

- **AC6 — Draft, error and streaming continuity across surfaces (EP3, EP4, EP5).**
  - Unsent draft text survives tab close→chip reopen, remount, and wide→compact→wide resize. The
    test uses the ASCII sample `draft line 1\nASCII line 2`.
  - A dispatch error (`btw-action-feedback` matching `/connect|socket|offline/i`) and its
    preserved draft also survive close→reopen, with `stub.requests` unchanged.
  - A locally rejected ask retires its optimistic tracking; deleting that draft stays deleted
    after later provider failures. Rejected non-ask commands keep the accepted ask's recovery
    tracking, while authoritative completion or replacement during dispatch remains final.
  - A late provider failure restores the accepted question into `btw-composer` and shows
    `btw-provider-error`. One retry sends exactly once and clears the composer.
  - Streaming output continues while the tab is closed and is shown on reopen.
  - Evidence: actual reducers/stores in `conversation-store.test.ts` and `draft.test.ts`,
    production read/reconnect lifetime in `panel-reads.test.ts`, E2E W5–W8 and L1–L3, and
    `BTW pending dispatch and read-error recovery survive real panel remount`. The last journey
    proves reconnect recovery with the same client, descriptor id and status, without resending.
- **AC7 — Scroll stability in the BTW tab (EP3).** The existing scenario runs in the BTW tab, wide
  and compact:
  - An explicit send lands once when the submitted question enters the transcript.
  - A user scroll before admission cancels the landing.
  - Streaming and completed output preserve a scrolled-up reader.
  - Opening, closing and reopening the tab triggers no landing beyond the stream's normal entry
    position.
  - Evidence: E2E `BTW wide explicit sends land once and output preserves the reader` and the
    compact variant. Each now closes and reopens the real surface during generation and before
    held question admission, waits for a fresh authoritative history response and settled entry,
    then measures frames through admission/output/completion. The reopened baseline is allowed to
    differ from the closed viewport; later scroll/visible-row movement must stay within1px.
- **AC8 — Parent isolation (EP1–EP4).**
  - BTW sends, chip toggles, tab closes and sheet dismissals add no main-chat user messages
    (`mainUserCount` unchanged). EP1 commands typed in the main composer intentionally retain
    exactly one user breadcrumb equal to the typed command; their generated message id differs
    from panel commands' empty id. The entry matrix asserts that exact row and no extra rows,
    no parent model request and no parent lifecycle interruption (host-confirmed oracle).
  - Pressing Escape in `btw-composer` while the parent runs leaves the parent running
    (`fetchAgentTimeline(...).agent.status === "running"`, `stub.pending("parent") === 1`).
  - Send to main and Summarize to main each add exactly one main user message, including while the
    parent is busy (existing `verifyBusyMainDeliveries`).
  - Two parents in one workspace get two distinct BTW tabs, drafts and pending guards.
  - Evidence: E2E W6 and W8, plus unit `conversation-store.test.ts` `parents are isolated` and
    `identity.test.ts` `btw targets are parent-scoped`.
- **AC9 — Thread replacement, clear and absent extension (EP3, EP6).**
  - New thread keeps the same BTW tab (`workspace-tab-btw_<agentId>` unchanged), changes
    `btw-panel` `aria-label` to the new id, keeps the unsent draft text, disables delivery and
    shows no `turn-footer`. The composer keeps its input identity, focus and selection across
    empty-to-thread, New and Clear; only thread-specific stream and pagination state reset.
  - Clear keeps the tab open with `btw-empty` visible and removes `btw-chip`. Sending `AFTER_CLEAR`
    from the empty tab creates a thread: the chip reappears, `aria-label` is a fresh nonempty id,
    and `BTW_REPLY CONTEXT_A` is shown in that thread. Its authoritative user timeline is exactly
    `["AFTER_CLEAR"]`; exactly one new captured BTW model request contains `AFTER_CLEAR` as its
    last question. The orchestrator corrected the original impossible response literal after
    inspecting the unchanged fixture: only `AFTER_B` gets a special reply; all other asks return
    `CONTEXT_A`. This changes the oracle and strengthens correlation, preserving the behavior.
  - Without the pi-btw extension, no `btw-panel` or `btw-chip` appears on wide or compact, and
    `/btw no extension` reaches the main agent.
  - Evidence: E2E W9–W10, E2E `BTW absent extension {wide|compact} keeps the main fallback without
a tab or pill`, plus actual store/reducer tests in `conversation-store.test.ts` and `draft.test.ts`.
  - `BTW composer stays mounted and keeps focus through empty, first thread, New and Clear`
    preserves the actual input node, focus, selection and unsent text. Both real older-page
    replacement variants in `btw-selection-insert.spec.ts` hold an actual bounded history response;
    New/Clear retire its rows, loading and error without replacing the composer.
- **AC10 — Request boundaries and history integrity (EP5).**
  - `btw-subtitle` shows `pinned turn 1` for an answer asked while the parent's second turn runs,
    and `pinned turn 2` after it finishes.
  - After agent refresh, page reload and isolated daemon restart, `fetchProviderSubagentTimeline`
    rows equal the pre-refresh rows and the tab shows the same thread id with no duplicate rows.
  - Evidence: E2E W5 and L3–L5.
- **AC11 — Android native compact: user-exempt.** The user explicitly said "skip android e2e
  test for this feature". Do not start further emulator/device journeys or APK builds solely for
  acceptance. Preserve the earlier hard-probe success and failed full old-popup replay as
  historical evidence (§G1); neither establishes a passing branch journey. The prepared
  close/reopen real-Gboard geometry regression and flow remain archived in §4.5. Report Android
  E2E skipped by explicit user instruction. The Android JavaScript export in AC12 is still required.
- **AC12 — Repository and consumer gates.**
  - `npm run typecheck`, `npm run lint` and `npm run format:check` pass at the repository root.
  - The consumer builds in §4.3 succeed: `build:app-deps`, the browser web export, the
    Electron-renderer web export and the Android JS bundle export.
  - Every unit file in §4.2 passes with one worker.

### Introduced state, lifecycle and concurrency transitions

| #   | Transition                                                                  | Expected outcome                                                                  | Criterion / named test                                                                  |
| --- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| S1  | Parent pane mounts → first successful list → baseline set                   | No open for the thread present in the list                                        | AC3; `auto-open.test.ts` `existing thread at baseline does not open`                    |
| S2  | Baseline set → new thread id                                                | `showWorkspaceTargetBeside` once; no focus change                                 | AC1, AC2; `auto-open.test.ts` `new thread after baseline opens once`                    |
| S3  | Thread A → removed → A again (transient)                                    | No reopen                                                                         | AC3; `auto-open.test.ts` `same id after removal does not reopen`                        |
| S4  | List fails → later list succeeds                                            | No open before success; baseline from the successful list                         | AC3; `auto-open.test.ts` `failed list establishes no baseline`                          |
| S5  | Reconnect after baseline                                                    | Baseline kept; a thread created while disconnected opens once                     | AC3; `auto-open.test.ts` `reconnect keeps the baseline`                                 |
| S6  | Tab absent ↔ present (chip, tab close, sheet close, Back)                   | Present = visible; absent = hidden; the thread keeps running                      | AC4, AC11; `pill.test.ts`                                                               |
| S7  | Dispatch idle → pending → accepted \| rejected                              | One send; draft cleared on accept unless failed; error kept on reject             | AC5, AC6; `conversation-store.test.ts` `accept`, `reject`                               |
| S8  | Pending dispatch + panel unmount/mount                                      | Pending kept; second dispatch ignored; settles into the store                     | AC5; `conversation-store.test.ts` + real pending/remount browser journey                |
| S9  | Accepted ask → provider `failed`                                            | Question restored into the composer; error banner shown                           | AC6; `conversation-store.test.ts`, `draft.test.ts` + real wide/compact failure journeys |
| S10 | Thread id change (New thread, Clear then ask, external `/btw:new`)          | Text kept; `failed` reset; `submitted` kept only when `after === null`            | AC9; `draft.test.ts` `thread replacement keeps text and drops a bound submission`       |
| S11 | Thread removed (Clear)                                                      | Tab stays and shows the empty state; chip hidden                                  | AC9; actual store/reducer tests + real wide/compact Clear-then-ask                      |
| S12 | Wide → compact → wide with the BTW tab in the Side pane                     | Tab stays in the layout; the chip reveals it as a pane tab on compact; draft kept | AC6; E2E L1–L2                                                                          |
| S13 | Explicit ask → question admitted \| user scrolls first \| dispatch rejected | Lands once \| landing cancelled \| landing cancelled                              | AC7; E2E land-once tests                                                                |
| S14 | Reload / daemon restart                                                     | Persisted tab restored; closed tab not reopened; rows unchanged                   | AC3, AC10; E2E L3–L5                                                                    |
| S15 | Disconnected history read → fresh caught-up history                         | Stale read error cleared; draft kept; no command resent                           | AC6; `panel-reads.test.ts` + real same-client disconnected-read recovery                |

### Decisions

- **D1 — BTW is a parent-scoped workspace tab target.** Ruling: add `{ kind: "btw"; agentId:
string }` to `WorkspaceTabTarget`. `agentId` is the parent agent, and the panel resolves the
  parent's current thread with `useBtwThread`. Why: thread ids change on `/btw:new` and disappear
  on `/btw:clear` (F5), so a thread-keyed tab (for example, reusing `provider_subagent`) would go
  stale. Cost if wrong: a later need for several simultaneous BTW threads per parent requires a
  new target field.
- **D2 — Placement uses the Side pane contract.**
  - Ruling: the BTW tab is opened only through `open-beside.ts` (implicit side location). The
    manifest entry is `supportedHosts: ["main", "explorer"]`, `singleton: false`,
    `showCloseButton: true`, `compactSheet: { openAsTab: false, keyboardBehavior: "extend" }`.
  - Single-pane layouts get a main-pane tab, per the documented contract.
  - Why: callers never branch on the shell (`docs/explorer-sidebar.md`). Compact keeps a 92% sheet
    with the same keyboard props as `BtwSheet` (F2, F9).
  - Cost if wrong: on single-pane tablets BTW replaces the visible chat until the user switches
    tabs.
- **D3 — Auto-open uses a per-mount discovery baseline and does not take focus.**
  - Ruling: `BtwAutoOpen` (mounted where `BtwWindow` was) establishes its baseline after its first
    successful `refreshProviderSubagents`. Later, a different non-null thread id calls
    `showWorkspaceTargetBeside`.
  - Split layouts add and select the tab without a `focusRequest`. Compact layouts present the
    sheet. Single-pane layouts add the tab in the background.
  - Why: it keeps the old "a new thread opens itself" behavior for EP1, follows the PR-discovery
    precedent (F8), and stops reloads from re-creating a split the user closed (F4).
  - Cost if wrong: a thread started from another device opens here too. A user who closed the tab
    and asks again in the same thread from the main composer sees only the running chip, which
    matches the old minimized behavior.
- **D4 — The chip toggles tab presence.** Ruling: a visible BTW tab (the selected tab of a visible
  pane, or any sheet holding it) is closed. Otherwise the chip calls `openWorkspaceTargetAtLocation({
location: "side" })`, which reveals and focuses the tab where it lives or opens it beside. Why:
  there is no hidden Side pane lifecycle (`docs/explorer-sidebar.md`), and the user already chose
  bidirectional chip toggling. Cost if wrong: users who expect the chip only to reveal lose one
  click.
- **D5 — Per-parent conversation store owns durable UI state.**
  - Ruling: `btw/conversation-store.ts` holds the draft reducer state, `pending`, `error` and
    `accepted` per `(serverId, agentId)` in memory.
  - `BtwPanel` keeps only the landing ref, the stream ref and the history-fetch error.
  - Why: tabs remount (F7), and pending guards and drafts must survive a remount (F3).
  - Cost if wrong: drafts still do not survive an app reload, as today.
- **D6 — The mounted BTW tab owns timeline observation.** Ruling: `BtwPanel` calls
  `observeProviderSubagentTimeline` while mounted. The parent pane no longer observes BTW
  timelines. Why: descriptor status (chip, tab status) arrives through the update feed regardless,
  and reconciliation is idempotent over the fetched timeline on remount. Cost if wrong: reconciling
  a question answered while the tab was closed waits until reopen. This is invisible because the
  composer is not shown while the tab is closed.
- **D7 — Remove the popup surfaces.** Ruling: delete `btw/window.tsx`, `btw/floating-card.tsx`,
  `btw/sheet.tsx`, `btw/window-store.ts` and their tests. Remove the in-content header (title,
  Minimize, `btw-sheet-chip`) and Escape-to-hide, because tab chrome and sheet chrome own the label
  and close. Why: one surface and one close path per shell. Cost if wrong: keyboard users lose
  Escape-to-hide and must use the tab close control or the chip.
- **D8 — Clear leaves an empty tab.** Ruling: with no thread, `BtwPanel` renders `btw-empty`
  (`t("btw.empty")`) and the composer, and only Send is shown. Send dispatches `/btw <text>`. The
  tab never auto-closes on thread removal. Why: `/btw:new` emits a remove before the upsert, and a
  daemon restart lists nothing until Pi re-syncs (F5), so auto-close would close the tab
  spuriously. Cost if wrong: the user closes an empty tab by hand.
- **D9 — Thread-replacement draft rule.** Ruling: when the observed thread id changes, keep
  `text`, reset `failed` to false before applying the new status, and keep `submitted` only when
  `submitted.after === null`. Why: a submission bound to the old thread's epoch can never
  reconcile and would later restore a stale question. A submission made with no timeline matches
  by timestamp. Cost if wrong: one stale submission per replacement, which is the same as today.
- **D10 — No protocol, server or pi-btw change.** Ruling: the change is client-only. The layout
  storage schema accepts `btw`. Why: commands, request boundaries and presentation are already
  carried (F5). Cost if wrong: an app downgrade fails to parse a persisted layout that holds a BTW
  tab. This is the same exposure as any added tab kind; persistence has no migrations.
- **D11 — Keep the existing spec files.** Ruling: update `pi-btw-window.spec.ts`,
  `pi-btw-window.real.spec.ts` and `pi-btw.android.ad` in place. Run `.real.spec.ts` only for
  selector compilation, not execution. Why: these are the existing suites and CI routing (AGENTS.md
  rule), and the live spec copies `auth.json` (F12), which this run is not authorized to use. Cost
  if wrong: the filenames keep the stale word "window".
- **D12 — Platform scope.**
  - Ruling: required journey evidence is browser wide (split-panes) and browser compact. Android
    phone E2E is user-exempt (AC11); its JavaScript consumer export remains required.
  - Real Electron is not required, because the renderer path is identical and no `.electron.*`
    module or bridge is touched (F10).
  - Native tablet single-pane and iOS are explicit gaps, covered by the unit placement tests
    `open-beside.test.ts` `single-pane opens in the background in the main pane`.
  - Compact native changes from `BtwSheet` to the workspace sheet (keyboard, Back, header), but
    those interactions remain unverified on the branch under the explicit exemption.
  - Cost if wrong: an Electron-only regression would go unobserved. If the orchestrator's merge
    policy requires Electron evidence regardless, add a `qex-e2e electron` declaration and run the
    existing real-Electron runner on a separate Xvfb display.
- **D13 — Non-focusing pane selection is a store option.** Ruling: `selectTabInPane(workspaceKey,
paneId, tabId, options?: { focus: boolean })`. With `focus: false` it sets no `focusRequest`,
  dismisses no sheets, and leaves `focusedPaneId` unchanged. The default behavior is unchanged.
  Why: this mirrors `ensureSidePane`'s option (F8). Cost if wrong: none outside BTW auto-open.
- **D14 — i18n.** Ruling: add `btw.empty` ("Ask a side question about this chat") to all 9
  locale files and remove the unused `btw.minimize`. `btw.label` ("BTW") is the tab label, and
  `btw.title` is the tooltip. Cost if wrong: none.

### Gates

- **G0 — Human design approval: not required.** The request names the destination (Side pane).
  Every remaining choice is a routine ruling above, with a stated cost. There is no destructive,
  security-sensitive, external or scope-expanding action. The user did not ask to review the
  design. Resolution: finalized autonomously.
- **G1 — Android capability resolved; subsequent user exemption controls acceptance.**
  - The orchestrator resolved observation capability from ASCII hard-probe job
    `213d6f31-f9b1-41f7-a7b9-da46ae0c4941`: exact ASCII text, selected and visible real Gboard,
    composer/Send above IME1111px, Send/Stop and Android Back. The additional full old-surface
    replay remained **FAILED** after long-press/minimize/reopen: Gboard covered Send
    (`artifacts/btw-side-pane/continuation/native-baseline-ascii-3/failure.png`). Preserve both
    receipts; this was never a complete baseline or branch pass.
  - The user subsequently said **"skip android e2e test for this feature"**. AC11 and further
    acceptance-only APK builds are user-exempt. Do not repeat tool setup, native builds or
    emulator/device E2E. Browser wide/compact journeys, targeted units, root checks and all three
    JavaScript consumer exports remain required.
  - Earlier task-only tool/license installation and build dependencies were authorized under
    `.dev/pi-btw-android`. Setup and a warm resumed development APK build passed; the build
    cgroup peak was 5,154,045,952 bytes with no OOM events/survivors. This is not a cold-build
    peak. Ten CMake/Ninja builders used x86_64 and compile/link pools of one. Keep those artifacts
    and the reviewed root declarations unchanged; no shared SDK, AVD, global policy or daemon
    changes are authorized.
  - **ASCII-only feature test inputs** remain mandatory. Draft retention uses
    `draft line 1\nASCII line 2`; archived native input is
    `HOLD_BTW Native keyboard smoke ASCII`. The temporary Unicode helper-IME module and
    dependency are removed. Unrelated repository Unicode coverage and historical failed
    receipts are preserved.
  - Before branch browser E2E, the orchestrator still inspects the three interfaces at
    **T1_CHECKPOINT_PRE_E2E** and must issue **RELEASE_E2E**.
- **G2 — Committed-main consumers are part of this integration.**
  - Main advanced 18 commits after the original base. Preserve its selection shortcuts,
    tab/window focus, attention routing, notification filtering and runtime fixes.
  - `data-btw-thread` / cancelable `paseo:btw-insert` remain the real plugin contract. The parent
    stream and separate wide BTW transcript each own a scoped target. Accepted insertion calls
    the parent/server-keyed conversation `insert`, then ordinary `revealBtwTab`; it sends nothing.
    Pending dispatch refuses insertion without preventing the event. Compact BTW transcript
    retains the existing portal boundary; the parent stream can reveal its sheet.
  - Composer focus requests survive panel mount and are consumed once. New/Clear retain the
    composer; only the thread stream and pagination reset. Discovery remains quiet.
  - Add to chat uses separate source and destination roles across pane/portal boundaries:
    `data-chat-composer-owner` on the actual parent root and BTW region, and
    `data-chat-composer-root` only on a real normal parent composer root. Both carry the opaque
    parent/server conversation key. Explicit owners resolve only to visible writable fields
    under matching destination roots in the source document; missing/hidden/archived parents
    use the existing copy fallback. Unmarked plugin surfaces retain legacy ancestry lookup.
  - The separately authorized producer is Better Paseo commit
    `7f1573052f916fe576bd2516449a9b5f25461fca`, tree
    `08a1560bf8b4b04a02486af3ce95c3d770754aaa`, from base
    `18489ac5bb0383ce861c08d441b80e9066cfef8f`. The parent owns its local integration and R2.
    The consumer uses the sealed built-install archive unchanged, never the producer's mutable
    worktree. Actual host entry priority is generated `index.client.ts` before the raw `.tsx`;
    acceptance witnesses its execution/catalog hash and the generated Tasks chunk's public RPC
    code hash. Testing only raw `.tsx` would miss the installed variant.
  - Current consumer proof is 15 Side-pane, 9 paired selection, 5 current-main tab-focus and
    2 scripted Pi workflow browser cases, all passed. The old producer's actual hidden-Alpha
    write into Beta remains the negative experiment. Closing a root tab archives and clears its
    BTW descriptors; the unavailable-view case therefore uses a genuine managed child's
    layout-only close, while archived copy fallback selects the actual archived History stream.
  - Main's background opens keep a user's launcher. Supporting discovery may consume only the
    synthetic sole launcher of a Side pane created by that same call. Reused panes keep their
    launchers; quiet creation also preserves parked focus restoration tokens. Explicit/default
    focus semantics stay current-main's.

### Documentation items

- **DOC1 — `docs/glossary.md`.** Replace **BTW window** with **BTW tab**: "The workspace tab
  that shows a parent's BTW conversation. It opens in the Side pane on split layouts, as a sheet
  on compact layouts, and as a main-pane tab on single-pane layouts. The BTW chip shows or closes
  it without stopping the conversation." Keep **BTW conversation**.
- **DOC2 — `docs/explorer-sidebar.md`.** In §Side pane, add the non-focusing show
  (`showWorkspaceTargetBeside`, used by BTW discovery, beside PR discovery). In §Sheets, state that
  `CompactSheetPolicy.keyboardBehavior` lets a sheet with a text input use `extend`.
- **DOC3 — `docs/agent-lifecycle.md:382`.** Change "belongs in the BTW window and its chip" to
  "belongs in the BTW tab and its chip".
- **DOC4 — Root `CLAUDE.md` (`AGENTS.md` symlink).**
  - The orchestrator's preflight hunk, the "E2E resource declarations" section with the initial-
    feature-only scope prose and the `qex-e2e browser` block (4 CPU / 16 GiB / 30m, one worker),
    is preserved verbatim.
  - Keep the `android-btw-build` and `android` blocks and their workload/estimate rationale in the
    [root declarations](../../CLAUDE.md#e2e-resource-declarations), following the user's staged
    claim update. The build wrapper consumes `android-btw-build`; the full runtime consumes
    `android`. They share the feature build lock and never overlap.
  - The runtime prose covers host emulator overhead, this checkout's Metro, one disposable daemon,
    real Pi test agents, automation and teardown, and names
    `packages/app/e2e/mobile/pi-btw/android.sh`. The serial development x86_64 APK producer is
    `packages/app/e2e/mobile/pi-btw/low-memory.sh build`.
  - It also records the BTW E2E environment: `PASEO_PI_BINARY` (Pi 1.4.0) and
    `PASEO_PI_BTW_PACKAGE` (a local pi-btw checkout).
  - Validate all declarations with `agent-job estimates --cwd <worktree>`.

## 2. Design

### Module boundaries

| Module (packages/app/src)                                                     | Owns                                                                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `workspace-tabs/model.ts`, `identity.ts`                                      | `btw` target type, normalization, equality, deterministic tab id `btw_<agentId>`                                   |
| `stores/workspace-layout-storage.ts`                                          | Persisted schema entry for `btw`                                                                                   |
| `stores/workspace-layout-store.ts`                                            | Quiet selection/Side-pane focus options; explicit synthetic-launcher consumption                                   |
| `panels/panel-manifest.ts`                                                    | `btw` manifest; `CompactSheetPolicy.keyboardBehavior?: "extend"`                                                   |
| `screens/workspace/sheet-tabs.tsx`                                            | Passes `keyboardBehavior` / `keyboardBlurBehavior="restore"` from `sheet.policy`                                   |
| `workspace-tabs/open-beside.ts`                                               | `showWorkspaceTargetBeside` (non-focusing show, layout-agnostic for callers)                                       |
| `btw/conversation-store.ts` (new)                                             | Per-parent draft/pending/error/accepted, selection insert/focus request and dispatch                               |
| `btw/draft.ts`                                                                | Reducer gains `threadId` and the D9 rule                                                                           |
| `btw/tab.ts` (new)                                                            | `btwTabTarget`, `selectBtwTab`, `toggleBtwTab`                                                                     |
| `btw/auto-open.tsx` (new)                                                     | `BtwAutoOpen` discovery baseline                                                                                   |
| `btw/discovery.ts`, `refresh-on-connect.ts`                                   | Pure once-per-ID discovery and typed connection/list lifetime                                                      |
| `btw/panel-reads.ts`                                                          | Standalone read/retry/error lifetime through typed connection and history ports                                    |
| `btw/selection-contract.ts`, `selection-target.ts`, `selection-target.web.ts` | Cancelable scoped insertion and platform composer-focus adapter                                                    |
| `btw/panel.tsx` (new)                                                         | `BtwPanel`, descriptor hook, `btwPanelRegistration`                                                                |
| `btw/panel-content.tsx` (renamed from `window-content.tsx`)                   | Stream, subtitle, composer, actions, empty state                                                                   |
| `btw/pill.tsx`                                                                | Chip bound to tab visibility                                                                                       |
| `panels/register-panels.ts`, `agent-panel.tsx`, `agent-tracks.tsx`            | Registration and mounting                                                                                          |
| Tab label switches                                                            | `compact-workspace-header/tab-switcher.tsx`, `workspace-tab-menu.ts` close test id `workspace-btw-close-<agentId>` |

Unchanged: `btw/send.ts`, `btw/select.ts`, server, protocol and pi-btw.
Review round 1 approved the narrow `subagents/provider-store.ts` / existing test seam:
reported descriptor-list errors must reject before replacing cached descriptors, so BTW
reconnect can establish a baseline and clear local read errors only after a valid list.
The public API and coalesced-request retry contract stay unchanged.

### Data flow

```text
main composer "/btw q" ─► daemon out-of-band ─► Pi + pi-btw ─► provider_subagent upsert(side_conversation)
                                                           └► update feed ─► provider-store.descriptors
parent agent pane (mounted, hasActiveComposer && !draft)
  BtwAutoOpen: refreshProviderSubagents ─► baseline ─► useBtwThread(id changes) ─►
      showWorkspaceTargetBeside({ workspaceKey, target: { kind:"btw", agentId } })
        split-panes: ensureSidePane(focus:false) → openTab(background, prefer side) → selectTabInPane(focus:false)
        compact:     openTab(reveal) → sheet (compactSheet policy)  | existing pane tab: unchanged
        single-pane: openTab(background)                             | existing tab: unchanged
  BtwPill (track bar): selectBtwTab → aria-expanded; press → toggleBtwTab
      visible → closeTab │ otherwise → openWorkspaceTargetAtLocation(location:"side")

BTW tab (pane, Explorer dock, or workspace sheet) → BtwPanel(target.agentId)
  useBtwThread(serverId, agentId) ─► thread | null
  observeProviderSubagentTimeline (while mounted, thread.hasTimeline !== false)
  effect: conversation.observeThread(key, { threadId, status, updatedAt, items })
  BtwPanelContent ─► dispatchBtwCommand(key, command, after, send) ─► useSendBtwCommand ─► sendAgentMessage(messageId:"")
  landing: dispatch returns a promise → pendingSendLanding until the admitted question appears → scrollToBottom("message-sent")
```

### Interfaces

```ts
// workspace-tabs/model.ts
export type WorkspaceTabTarget = /* existing */ | { kind: "btw"; agentId: string };

// workspace-tabs/identity.ts — normalize: trims agentId, null when empty;
// equality: agentId; buildDeterministicWorkspaceTabId: `btw_${agentId}`.

// stores/workspace-layout-storage.ts
z.strictObject({ kind: z.literal("btw"), agentId: z.string() });

// panels/panel-manifest.ts
export interface CompactSheetPolicy {
  openAsTab: boolean;
  /** Sheets with a text input use "extend", like the app's other input sheets. */
  keyboardBehavior?: "extend";
}
// manifests.btw = { kind:"btw", supportedHosts:["main","explorer"], showCloseButton:true,
//   singleton:false, compactSheet:{ openAsTab:false, keyboardBehavior:"extend" },
//   resourceKey: (t) => t.agentId }

// stores/workspace-layout-store.ts
selectTabInPane: (
  workspaceKey: string,
  paneId: string,
  tabId: string,
  options?: { focus: boolean }, // focus:false → no focusRequest, no sheet dismissal
) => void;

// workspace-layout-store.ts
// OpenWorkspaceTabInput.allowNewTabReplace?: boolean is also passed through openBackgroundTab.
// Only a just-created Side pane's sole synthetic launcher opts in; defaults stay main's.

// workspace-tabs/open-beside.ts
/**
 * Shows a target beside the user's work without moving workspace focus. Split panes add it to
 * the Side pane and select it there; compact layouts present it through its sheet policy; single-
 * pane layouts add it in the background. An existing tab stays in the pane the user placed it in
 * and is selected only when that pane is not the focused pane. Returns the tab id or null.
 */
export function showWorkspaceTargetBeside(input: {
  workspaceKey: string | null;
  target: WorkspaceTabTarget;
}): string | null;

// btw/conversation-store.ts
export function btwConversationKey(serverId: string, agentId: string): string; // JSON.stringify([serverId, agentId])
export interface BtwConversation {
  draft: BtwDraftState;      // from draft.ts, now including threadId
  pending: boolean;
  error: string | null;      // last dispatch error message
  accepted: boolean;         // last dispatch accepted → t("btw.accepted")
  pendingComposerFocus: boolean; // one explicit insertion, consumed after the input mounts
}
export const EMPTY_BTW_CONVERSATION: BtwConversation;
export type BtwDispatchResult = { ok: true } | { ok: false; error: string };
interface BtwConversationStore {
  byParent: Record<string, BtwConversation>;
  edit(key: string, text: string): void;
  insert(key: string, text: string): boolean; // refuses pending dispatch or empty input
  clearComposerFocus(key: string): void;
  observeThread(
    key: string,
    thread: {
      threadId: string;
      status: ProviderSubagentDescriptorPayload["status"];
      updatedAt: string;
      items: readonly StreamItem[];
    },
  ): void;
  /** Null when a dispatch for this parent is already pending; nothing is submitted then. */
  dispatch(input: {
    key: string;
    command: BtwCommand;
    after: TimelinePosition | null;
    send: (command: BtwCommand) => Promise<void>;
    submittedAt?: number; // defaults to Date.now()
  }): Promise<BtwDispatchResult> | null;
}
export const useBtwConversationStore: UseBoundStore<StoreApi<BtwConversationStore>>;
export function useBtwConversation(key: string): BtwConversation;

// btw/draft.ts
export interface BtwDraftState { threadId: string | null; text: string; submitted: …; failed: boolean }
// "thread" action gains `threadId: string`; D9 rule applies when it differs from state.threadId.

// btw/tab.ts
export function btwTabTarget(agentId: string): { kind: "btw"; agentId: string };
export function selectBtwTab(
  state: Pick<WorkspaceLayoutStore, "layoutMode" | "layoutByWorkspace" | "sheetsByWorkspace">,
  workspaceKey: string,
  agentId: string,
): { tabId: string; visible: boolean } | null;
export function revealBtwTab(input: { workspaceKey: string | null; agentId: string }): string | null;
export function toggleBtwTab(input: { workspaceKey: string | null; agentId: string }): void;

// btw/auto-open.tsx
export function BtwAutoOpen(props: { serverId: string; workspaceId: string; agentId: string; selectionTarget: RefObject<View | null> }): null;

// btw/panel.tsx
export const btwPanelRegistration: PanelRegistration<"btw">;
// descriptor: label t("btw.label"); subtitle thread?.title || t("btw.title"); tooltip t("btw.title");
// icon MessagesSquare (lucide-react-native); titleState "ready";
// statusBucket deriveSubagentStatusBucket(providerSubagentLifecycleStatus(thread.status)) or null.

// btw/panel-content.tsx
export interface BtwPanelContentProps {
  serverId: string;
  agentId: string;
  thread: ProviderSubagentDescriptorPayload | null; // null → empty state, Send only
  streamViewRef: RefObject<AgentStreamViewHandle | null>;
  onUserScrollIntent(): void;
  compact: boolean;
  selectionTarget: RefObject<View | null>;
  pendingComposerFocus?: boolean;
  onComposerFocusHandled?: () => void;
  draft: string;
  onDraft(text: string): void;
  onCommand(command: BtwCommand): void;
  pending: boolean;
  feedback: string | null;
  error: string | null;
}

// btw/pill.tsx
export function BtwPill(props: { serverId: string; workspaceId: string; agentId: string }): ReactElement | null;
```

Test ids: `btw-panel` (`accessibilityLabel` = thread id or `""`), `btw-subtitle` (rendered with
`PaneSubtitle` when present), `btw-empty`, `btw-composer`, `btw-send`, `btw-stop`, `btw-inject`,
`btw-summarize`, `btw-new`, `btw-clear`, `btw-action-feedback`, `btw-provider-error`, `btw-chip`.
`btw-window`, `btw-floating-card`, `btw-minimize` and `btw-sheet-chip` are removed.

### Errors

- A dispatch with no client rejects with `Host disconnected` (existing `send.ts`). The message goes
  to `conversation.error`, the draft is kept, and there is no retry or resend.
- Timeline fetch errors set the panel-local history error, shown in `btw-action-feedback`. A later
  stream update or remount retries (existing `observeProviderSubagentTimeline`). Standalone tabs
  also refresh descriptors on same-client reconnect. A successful empty or non-timeline list
  retires only the local read error, preserving stored command errors and drafts.
- A provider failure arrives as `thread.status === "failed"` and shows `btw-provider-error` with
  `thread.description`.
- A failed `refreshProviderSubagents` in `BtwAutoOpen` is caught. No baseline is set, and the hook
  retries on the public client's connected status, including reconnects of the same client.
  Only the first successful list establishes the baseline; later reconnects preserve it.

### Conventions

- Styles use `StyleSheet.create` and `withUnistyles`, never `useUnistyles` (`docs/unistyles.md`).
- There are no DOM APIs outside `isWeb`. The web-only Enter-key handler stays behind `isWeb`.
- Use "Side pane" and "BTW tab" terminology (`docs/glossary.md`).
- New strings go in all nine `i18n/resources/*.ts` files.
- No feature flag. The feature ships enabled.
- Callers never branch on the layout shell. Only `open-beside.ts` reads `layoutMode`, and
  `btw/tab.ts`'s visibility selector reads it to define "visible".
- Comments explain only non-obvious why: the baseline rule, the D9 rule, and the non-focusing show.

## 3. Tasks

### T1 — BTW tab, Side pane placement, wiring, tests and representative proof

One Side-pane writer owns this integration. The parent owns the separately authorized paired
producer writer, immutable handoff, independent review and local merges; this task never writes
that worktree or stages the Paseo index.

- **Depends on:** nothing. The base build artifacts exist; their freshness is unverified.
- **Owned files (create/modify/delete):**
  - `packages/app/src/subagents/provider-store.ts` and `provider-store.test.ts`: parent-approved
    review repair only, reject reported list errors before replacing cached rows.
  - `packages/app/src/btw/`: create `conversation-store.ts`, `conversation-store.test.ts`,
    `tab.ts`, `auto-open.tsx`, `auto-open.test.ts`, `discovery.ts`, `panel.tsx`, `panel-reads.ts`
    and `panel-reads.test.ts`. Remove migrated component suites. Rename
    `window-content.tsx` to `panel-content.tsx`. Modify `draft.ts`, `draft.test.ts`, `pill.tsx` and
    `pill.test.ts`. Delete `window.tsx`, `window.test.tsx`, `floating-card.tsx`, `sheet.tsx`,
    `window-store.ts` and `window-store.test.ts`.
  - `packages/app/src/workspace-tabs/model.ts`, `identity.ts`, `identity.test.ts`,
    `open-beside.ts` and `open-beside.test.ts`.
  - `packages/app/src/stores/workspace-layout-storage.ts`, `workspace-layout-store.ts`,
    `workspace-layout-store.test.ts` (D13 option) and `workspace-layout-persistence.test.ts` (btw
    round-trip).
  - `packages/app/src/panels/panel-manifest.ts`, `panel-manifest.test.ts`, `register-panels.ts`,
    `agent-panel.tsx` (replace `BtwWindow` with `BtwAutoOpen`) and `agent-tracks.tsx` (pass
    `workspaceId` to `BtwPill`).
  - `packages/app/src/screens/workspace/sheet-tabs.tsx`,
    `compact-workspace-header/tab-switcher.tsx` and `workspace-tab-menu.ts`, plus any further
    exhaustive `kind` switch that typecheck reports.
  - `packages/app/src/i18n/resources/{en,ar,es,fr,ja,ko,pt-BR,ru,zh-CN}.ts`.
  - `packages/app/test-stubs/lucide-react-native.ts`: add `MessagesSquare`. The unit project
    aliases lucide to this stub (`packages/app/vitest.config.ts:313`).
  - `packages/app/vitest.setup.ts`: remove only the feature-created WebAnimations shim after
    migrating the component suites. Preserve existing global setup and other legacy tests.
  - `packages/app/e2e/browser/pi-btw-window.spec.ts`, `pi-btw-window.real.spec.ts` (selectors
    only), `packages/app/e2e/support/helpers/pi-btw.ts`, and
    `packages/app/e2e/mobile/agent-device/pi-btw.android.ad` (and `pi-btw.ios.ad` selectors).
  - New native harness (§4.5): `packages/app/e2e/mobile/pi-btw/fixture-host.ts` and
    `packages/app/e2e/mobile/pi-btw/android.sh`. Native harness code lives next to the other
    mobile harnesses, not in `e2e/support`.
  - `docs/glossary.md`, `docs/explorer-sidebar.md`, `docs/agent-lifecycle.md` and root `CLAUDE.md`
    (DOC4: append the android block and keep the orchestrator hunk).
- **Consumes:** `useBtwThread`, `useSendBtwCommand`, `providerSubagentKey`,
  `observeProviderSubagentTimeline`, `loadOlderProviderSubagentTimeline`,
  `refreshProviderSubagents`, `AgentStreamView`, `PaneSubtitle`, `usePaneContext`, `definePanel`,
  and the layout store `openTab`, `ensureSidePane`, `closeTab` and `getTabDestination`.
- **Produces:** the interfaces in §2.
- **Order:**
  1. Browser capability probe on base code (§4.1 step 3).
  2. Author the native harness (`fixture-host.ts`, `android.sh`). Run the native baseline probe
     on base code (§4.1 step 4) under `--e2e android`.
     - If qex rejects it or tooling is missing, send `contact_supervisor` (`need_decision`,
       message prefix `G1_BLOCKED`) with the receipt, and keep working only on steps 3–4.
  3. Add behavioral regressions through pure reducers, typed ports and real browser consumers.
     Missing imports/parser failures are cannot-observe; retain actual invariant red/green receipts.
     Preserve original criteria when migrating historical component tests to permitted shapes.
  4. Update the E2E spec, helpers and `.ad` flows to the new surface. Do not run them yet.
  5. **Gate:** start only after the native baseline probe passes, or after the orchestrator relays
     an explicit user Android exemption (`G1_RESOLVED` / `G1_EXEMPT`). Then implement and wire.
  6. Turn the unit tests green and run the repository and consumer gates (§4.3, in order).
  7. **Checkpoint:** send `contact_supervisor` (`need_decision`, message prefix
     `T1_CHECKPOINT_PRE_E2E`) with the unit and gate receipts and the diffs of `open-beside.ts`,
     `workspace-layout-store.ts` and `conversation-store.ts`. Wait for the orchestrator's
     `RELEASE_E2E` reply.
  8. Browser E2E (§4.4).
  9. Android E2E is user-exempt (§4.5); retain historical evidence without another native run.
  10. Docs (DOC1–DOC4). Run `npm run format`, then commit.
- **Exact unit command** (from `packages/app`):
  `agent-job submit medium --cwd /home/sinkerine/.paseo/worktrees/28vpgp2p/feat-btw-side-pane/packages/app --timeout 15m -- npx vitest run --project unit src/btw src/workspace-tabs/open-beside.test.ts src/workspace-tabs/identity.test.ts src/stores/workspace-layout-store.test.ts src/stores/workspace-layout-persistence.test.ts src/panels/panel-manifest.test.ts src/i18n --bail=1 --maxWorkers=1`
  (a single file during iteration uses `small`).
- **Build and file conflicts:**
  - This is the only writer in the worktree. `CLAUDE.md` holds the orchestrator's uncommitted
    preflight hunk, so T1 appends below it and commits it with T1.
  - `build:app-deps` rewrites the `dist` of highlight, client, plugin and expo-two-way-audio,
    which Metro and the E2E daemons read. Never run it concurrently with an E2E job or an export.
  - Exports write only to distinct `artifacts/btw-side-pane/<attempt>/build/*` directories, never
    to `packages/app/dist` (the source for `build:daemon-web-ui`).
  - Never patch types to silence stale declarations.
- **Early interface check (orchestrator host-only inspection, not a model review):** at the step 7
  checkpoint, the orchestrator inspects the unit evidence and diffs for three properties:
  - (a) `showWorkspaceTargetBeside` never sets `focusRequest` on split and single-pane layouts
    (`open-beside.test.ts`).
  - (b) `selectTabInPane(…, { focus: false })` leaves default callers unchanged
    (`workspace-layout-store.test.ts`).
  - (c) The dispatch guard holds in the actual conversation store and the real held-RPC
    close/reopen browser journey; no component mounting or own-module mocks.
  - The browser E2E starts only after `RELEASE_E2E`.
- **Protected boundaries (no edits):** server, protocol, client package, the pi-btw checkout
  (`/home/sinkerine/dev/pi-btw`, read-only), other worktrees, and the shared daemon on 6767.
  Shared qex budgets are also protected.
- **Repair ownership:** T1's worker owns repairs to any file above. A failure in a non-owned
  module is reported to the orchestrator with evidence, not patched.

## 4. Test and verification

All expensive commands run under shared qex admission. E2E uses the root `CLAUDE.md` declarations.
Heavy jobs are serialized: one browser E2E or consumer build at a time. Android E2E and further
acceptance-only APK builds are user-exempt. Evidence goes in ignored worktree `artifacts/`.
Existing native tool/build/probe artifacts are historical; shared state and daemon changes remain
prohibited.

### 4.1 Prerequisites and completed capability probes

The baseline probes below are retained for provenance and must not be repeated without changed
relevant inputs. Native steps are archived under the subsequent user exemption (G1).

1. `agent-job estimates --cwd /home/sinkerine/.paseo/worktrees/28vpgp2p/feat-btw-side-pane` lists
   `browser`, `android-btw-build` and `android` as valid.
2. Environment for the BTW fixture: `export PASEO_PI_BINARY="$(command -v pi)"` (`pi --version`
   must print `1.4.0`) and `export PASEO_PI_BTW_PACKAGE=/home/sinkerine/dev/pi-btw` (record
   `git -C … rev-parse HEAD`, currently `7ea4f10`). Run inside the development shell
   (`docs/development.md#nix-and-direnv`) for Chromium dependencies. A missing variable surfaces
   as `NEEDS_CONTEXT`, which is an inability to observe, not a test failure.
3. **Browser representative probe (base code, unchanged spec):**
   `agent-job run --e2e browser --cwd <worktree> -- npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/pi-btw-window.spec.ts --grep "wide docked card toggles" --workers=1 --output=artifacts/btw-probe/results`.
   - Readiness: the harness reports Metro `packager-status:running`.
   - Representative action: launch a Pi agent and run `/btw HOLD_BTW` from the running composer.
   - Observation: the base floating card is visible and the stub records the BTW request.
   - Expected: pass on base. Record the qex job id, exit code, `run.log` and trace.
   - Harness, Metro, Pi or fixture errors mean "cannot observe" and block step 6 until fixed.
4. **Archived native baseline probe (do not rerun).** This was a real BTW sheet keyboard
   and Back journey on captured base selectors with the ASCII prompt correction
   (`btw-sheet-chip`, not the branch's workspace-sheet selectors).
   - Pre-check (trivial, not E2E): `command -v adb emulator agent-device`, plus
     `agent-job estimates`. Missing tooling or a missing AVD is a G1 tooling blocker.
     Provision missing tools only through `packages/app/e2e/mobile/pi-btw/setup.sh`, under
     the task-owned G1 setup declaration.
   - Build the base APK from the worktree root with
     `packages/app/e2e/mobile/pi-btw/low-memory.sh build`. The wrapper acquires the feature
     build lock before `agent-job run --e2e android-btw-build` and produces the development
     x86_64 debug APK (`sh.paseo.debug`) for the matching AVD. The old 24 GiB rejection remains
     historical evidence; current claims are owned by the root declarations.
   - After the build exits, run the baseline with the same lock:
     `flock --close <feature-build-lock> agent-job run --e2e android --cwd <worktree> --
python3 packages/app/e2e/mobile/pi-btw/measure.py <evidence-directory> bash packages/app/e2e/mobile/pi-btw/android.sh --baseline --flow <captured-base-flow-with-ascii-input>
--artifacts artifacts/btw-native-baseline`.
   - Entry: one cold VIEW launch of the dev client at this checkout's Metro. The app is connected
     to the isolated fixture host, then a deep link opens `paseo://h/<serverId>/agent/<agentId>`
     (§4.5).
   - Authoritative readiness: `wait id="message-input-root"`, then `wait id="btw-chip"` (the
     fixture seeded a completed BTW thread). Transport or Metro readiness alone does not count.
   - Representative action: press `btw-chip`, then press and fill `btw-composer` with
     `HOLD_BTW Native keyboard smoke ASCII`.
   - Observation:
     - Poll the IME top from `adb shell dumpsys window` every 250 ms until two consecutive reads
       match (10 s limit).
     - Then read `agent-device snapshot --json` rects for `btw-composer` and `btw-send`, and
       assert both bottoms are ≤ the IME top + 1 px (device pixels).
     - Press Send, then `wait id="btw-stop"`.
     - Run `agent-device back`, then `wait id="btw-chip"` with the sheet absent.
   - Evidence: screenshots before and after the keyboard, snapshot JSON, dumpsys excerpts, the qex
     job id and exit code.
   - A pass proves native capability. A failing assertion on base is a pre-existing native defect:
     report it, because it changes the AC11 baseline. Inability to boot, connect or admit is a
     G1 blocker, not a result.

### 4.2 Unit and integration inventory (vitest `unit` project, `packages/app/vitest.config.ts`)

| File                                                  | Proves                                     | Command / profile                                      |
| ----------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| `src/btw/conversation-store.test.ts`                  | S7, S8 store side, AC5, AC6, AC8 parents   | T1 unit command (`medium`); a single file uses `small` |
| `src/btw/draft.test.ts`                               | S9, S10 (D9)                               | same                                                   |
| `src/btw/panel-reads.test.ts` (Node ports)            | AC5, AC6, AC9, S8, S11                     | same                                                   |
| `src/btw/pill.test.ts` (Node store)                   | AC4, S6                                    | same                                                   |
| `src/btw/auto-open.test.ts` (Node ports)              | AC3, S1–S5                                 | same                                                   |
| `src/btw/send.test.ts`, `select.test.ts` (Node ports) | Command texts, thread selection            | same                                                   |
| `src/workspace-tabs/open-beside.test.ts`              | AC1, AC2 placement, D12 single-pane        | same                                                   |
| `src/workspace-tabs/identity.test.ts`                 | `btw` normalize/equality/id                | same                                                   |
| `src/stores/workspace-layout-store.test.ts`           | D13 default unchanged and `focus:false`    | same                                                   |
| `src/stores/workspace-layout-persistence.test.ts`     | Persisted `btw` round-trip                 | same                                                   |
| `src/panels/panel-manifest.test.ts`                   | `btw` manifest and sheet policy            | same                                                   |
| `src/i18n` resource tests                             | Key parity for `btw.empty` and the removal | same                                                   |

Consumers of the changed interfaces include the ordinary workspace store/panel/sheet hosts,
current-main selection DOM targets and tab-focus behavior, plus the paired Better Paseo producer.
Root typecheck and the three distinct app exports cover browser, Electron renderer and Android JS
module resolution. The real compiled producer is required for the selection/table/gutter/preview
entrypoints; a handcrafted selection bar is not an acceptable substitute. The migration from old
component tests is mapped declaration by declaration in
`artifacts/btw-side-pane/main-integration/attempt-1/migration-map.json`; pending/failed history
variants are real browser cases, and historical R1 component receipts are retained separately.

### 4.3 Repository and consumer gates (after implementation, serialized, producers first)

Run from the worktree root unless a different `--cwd` is shown. Run one heavy job at a time.
Receipts are tied to their relevant source, generated artifacts and environment. Reuse a producer
receipt only after validating that closure; rebuild changed producers before their consumers.
Current integration records identities and unique outputs under
`artifacts/btw-side-pane/main-integration/attempt-2/`; the initial repairs and declaration-by-
declaration migration map remain in `attempt-1/`. Historical pre-integration outputs remain
under their original resumed/repair directories. During the unmerged-index phase, Nix uses the
exact committed-main flake URI with `--offline --no-write-lock-file`; it asserts feature cwd and
byte-identical environment definitions so deletion of the obsolete popup cannot break Nix snapshot
collection. No temporary index or source restoration is permitted.

1. Integrated server producers first: `npm run build:server`. Then generated app inputs:
   `agent-job run heavy --cwd <worktree> --timeout 30m -- npm run
build:app-deps`. This writes the `dist` of highlight, client, plugin and expo-two-way-audio,
   which app typecheck, Metro and the exports consume.
2. `agent-job run medium --cwd <worktree> --timeout 20m -- npm run typecheck`
3. `agent-job run medium --cwd <worktree> --timeout 15m -- npm run lint`
4. Worker: `agent-job run small -- npm run format:files -- <owned files>`. Inspect the diff, then
   run `agent-job run small -- npm run format:check`. The parent owns full formatting before commit.
5. Browser web consumer build: `agent-job run heavy --cwd <worktree>/packages/app --timeout 30m --
npx expo export --platform web --output-dir ../../artifacts/btw-side-pane/build/web`
6. Electron renderer consumer build (same as `build:desktop`'s export step, without
   electron-builder): `agent-job run heavy --cwd <worktree>/packages/app --timeout 30m -- env
PASEO_WEB_PLATFORM=electron npx expo export --platform web --output-dir
../../artifacts/btw-side-pane/build/electron-web`
7. Native JS consumer bundle: `agent-job run heavy --cwd <worktree>/packages/app --timeout 30m --
npx expo export --platform android --output-dir ../../artifacts/btw-side-pane/build/android`.
   This is Metro only and needs no Android SDK. It runs even while G1 is open.
8. `git diff --check`. No lockfile change is expected, so `scripts/update-nix.sh --check` is
   unnecessary.

A success requires exit 0 and a non-empty output directory (`index.html` for web, a `_expo/static`
bundle for Android). Record each qex job id.

### 4.4 Browser E2E (initial-feature run, with repairs and reruns)

Run each selected file separately, one worker, under the root `browser` declaration
(4 CPU / 16 GiB). Each command takes the existing feature build lock before synchronous qex
admission and retains it through teardown. Preserve each attempt's terminal exit and JSON report.

- `pi-btw-window.spec.ts`: keep all original 13 wide/compact cases and add actual textarea
  identity/focus/New/Clear and held-RPC close/reopen/read recovery regressions.
- `btw-selection-insert.spec.ts`: real compiled Better Paseo selection/table/gutter/preview
  entrypoints, scoped Add to BTW, Copy/Add to chat, compact portal, sibling and window isolation,
  missing/archived owner fallback, plus actual old-page pending/failure retirement on New/Clear.
- `tab-focus-preservation.spec.ts`: current-main background/default focus and reload/visibility
  consumers affected by the shared store integration.
- `pi-workflow-subagent-tree.real.spec.ts`: required by `e2e-paths.yml` for `src/subagents/**`.
  Its real Pi 1.4.0 / pi-subagents 0.84.0 fixture registers local `paseo-scripted/workflow` with
  `scripted-no-network`, without external model calls or copied user auth. Use direct
  `npm exec --workspace=@getpaseo/app -- playwright test ... --project=real-provider --workers=1`
  with `E2E_FORK_PASEO_HOME_FROM` unset after entering Nix. Do not use the convenience real-suite
  wrapper that copies a dev home.

The browser group already covers added/moved BTW and layout paths. The existing pi-workflow
required-test group covers the R1 provider-store repair; no routing-map edit is necessary.
Android shared paths match, but native journeys remain explicitly user-exempt. No website runtime
path changed; the imported root script adds only the Android isolated entrypoint.

Evidence: qex job id, exit code, `run.log`, traces, and named screenshots `btw-wide-running`,
`btw-wide-side-pane-reopened`, `btw-compact-sheet`, `btw-provider-failed` and
`btw-restored-after-restart`, plus `btw-boundaries` attachments.

Classification:

- A failure that points at a BTW assertion (missing tab, wrong pane, focus moved) is a product
  failure, which the worker repairs.
- Metro readiness, `NEEDS_CONTEXT`, Pi version or fixture-port failures are inability to observe.
  Fix the environment and do not count them as test results.

### 4.5 Archived Android preparation (AC11 user-exempt)

The user explicitly exempted Android E2E and further acceptance-only APK builds. Do not execute
this harness for this feature. The following records the prepared harness and historical baseline
method; branch keyboard/Back/close-reopen behavior has no passing native journey receipt.

- **`packages/app/e2e/mobile/pi-btw/fixture-host.ts`** (run with `npx tsx`):
  - Calls `createBtwRuntime(false)` and `startIsolatedHostDaemon(serverId, { config:
runtime.daemonConfig, environment: runtime.environment })` (`e2e/support/helpers/isolated-host-daemon.ts`).
  - Launches a Pi agent in a temp workspace and finishes `PARENT_A`.
  - Asks one released BTW question, so a completed thread and `btw-chip` exist.
  - Writes `fixture.json` (`serverId`, `port`, `agentId`, `workspaceId`, `paseoHome`, pi-btw
    revision).
  - Stays alive until SIGTERM, then releases the stub and closes the daemon and runtime.
- **`packages/app/e2e/mobile/pi-btw/android.sh`**, modeled on `composer-keyboard/android.sh` and
  `scripts/test-mobile-agent-device.sh`:
  1. Use isolated `AGENT_DEVICE_STATE_DIR` and `AGENT_DEVICE_CLAIMS_DIR`, an isolated agent-device
     logs dir and `TMPDIR` under `.dev/`, and a disposable emulator (`-no-snapshot-save`) that the
     job starts and kills. Never use shared ADB or emulators.
  2. Run `agent-device metro prepare` for this checkout on a free port.
  3. Start `fixture-host.ts` and `adb reverse` the daemon and Metro ports.
  4. Install the APK. Do one cold VIEW launch
     (`exp+voice-mobile://expo-development-client/?url=…`). On a wiped debug app,
     press the Expo development-menu introduction's Continue, then Close.
  5. A wiped app starts at Welcome. Add the host with `welcome-direct-connection`,
     `direct-host-input` `127.0.0.1`, `direct-port-input <port>` and `direct-host-submit`.
     The method chooser's `add-host-method-direct` is not present on a fresh install.
     Accept the fresh app's Android notification prompt and wait for `open-project-submit`
     before delivering the agent link, so Add host's success navigation has settled.
  6. Deliver `paseo://h/<serverId>/agent/<agentId>`. Deliver it again only after the root
     navigator is live, following the existing script's documented gotcha.
  7. Run the complete `.ad` flow in the same owned session with `agent-device replay <flow>
--no-test-ime --metro-port <port> --timeout 120000 --json`, saving `flow-result.json`.
     `test` creates a derived attempt session that cannot take this session's device claim.
  8. Take the IME, snapshot and Back measurements (§4.1 step 4).
  9. Tear down: stop the agent-device daemon, the emulator and the fixture host, and kill Metro if
     the harness started it.
- The prepared branch flow includes `BTW compact reopen keeps controls above real IME`: retain
  an ASCII draft, long-press, close/reopen with real Gboard, measure both controls above the IME,
  then use an ordinary safe Send. It is **not executed** under the user exemption. Historical
  failure images and complete flow files remain intact.
- iOS is an explicit gap (no runner on Linux).

### 4.6 Independent gates after T1

- **Host test gate:** the orchestrator reruns the unit command and the repository gates on the
  final tree.
- **Consolidated review:** at most three rounds for this scope.
- **Independent acceptance:** the §5 journey on the final tree, under a fresh `--e2e browser`
  admission.

Future pushes and deploys of this feature rerun existing unit tests only, not E2E.

## 5. E2E journey

Harness: the existing isolated headless Playwright harness, Chromium, one worker, disposable
daemon homes and ports, the deterministic HTTP model stub with the real Pi 1.4.0 and pi-btw
(§4.1). Test names below are the exact titles to keep or create in `pi-btw-window.spec.ts`.

**`BTW {wide|compact} main composer aliases and empty entry preserve routing`**

Two table-driven cases reuse one real Pi agent/fixture per layout. Each executes this matrix
with an idle parent, then with a held `HOLD_PARENT` turn (16 real main-composer submissions total):

| Main command                 | Precondition                                     | Thread and model oracle                                                                     |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| empty `/btw`                 | No BTW thread/tab                                | Fresh idle descriptor and tab/sheet, no model request, no delivery                          |
| `/btw ENTRY_BTW_<state>`     | Previous empty thread cleared through real UI    | Fresh descriptor, one BTW model request and matching authoritative last question            |
| `/side ENTRY_SIDE_<state>`   | Previous thread cleared through real UI          | Fresh descriptor, one BTW model request and matching authoritative last question            |
| `/btw:new ENTRY_NEW_<state>` | Existing `/side` thread, surface closed normally | Existing descriptor replaced by a different fresh id; one BTW request and matching question |

Every row checks actual Side-pane geometry/selection or compact sheet placement, main-composer
focus/post-submit typing, exactly one intended main-composer command breadcrumb and no other
new authoritative main user rows, unchanged parent model-request count and parent status/pending
state. Empty `/btw` has zero authoritative question/answer rows and zero model calls; its
`hasTimeline` metadata only says that the backing file exists. Fresh ids must differ from prior ids. Reset uses
actual Clear/Close controls rather than descriptor injection; the parent stack is not restarted.
Evidence is `btw-main-entry-matrix` for each layout, alongside focused/full-file receipts.

**`BTW wide side pane toggles during generation, retries and restores`** (1440×900; replaces
"wide docked card…")

- W0. `PARENT_A` finishes. `HOLD_PARENT` runs (`stub.pending("parent") === 1`). Record the parent
  pane id (`workspace-pane-*` containing `message-input-root`) and its width.
  - Read its `agent-chat-scroll` with an inline `evaluate` returning `{ scrollTop, scrollHeight,
clientHeight }`.
  - If `scrollHeight - clientHeight - scrollTop > 1`, click that pane's
    `scroll-to-bottom-button`.
  - Then `expect.poll(distance).toBeLessThanOrEqual(2)`, and attach the reading as `btw-parent-
scroll-before`.
- W1. Submit `/btw HOLD_BTW` from the running main composer.
  - Expect AC1: `btw-panel` in a second `workspace-pane-*` to the right, `workspace-tab-btw_<id>`
    selected, `stub.pending("btw") === 1`, delivery disabled, `subagents-track-header` count 0.
- W1b. Parent scroll after the Side pane opens.
  - Poll the parent pane width until two reads 4 animation frames apart match, and until it is
    narrower than the W0 width.
  - Then expect the parent `agent-chat-scroll` distance to be ≤ 2, and the parent pane's
    `scroll-to-bottom-button` count to be 0.
  - Attach `btw-parent-scroll-after` with both readings and widths.
- W2. Type `typed-after` immediately.
  - Expect the main composer to hold it and `btw-composer` to be empty. Clear it. Screenshot
    `btw-wide-running`.
- W3. `btw-chip` `aria-expanded="true"`. Click it.
  - Expect `btw-panel` count 0, one `workspace-pane-*`, `stub.requests.length` unchanged,
    `stub.pending("btw") === 1`.
- W4. Click `btw-chip`.
  - Expect the same `aria-label` thread id in a new right pane. Screenshot
    `btw-wide-side-pane-reopened`.
- W5. Release the BTW request.
  - Expect `BTW_REPLY CONTEXT_A`, `btw-subtitle` showing `pinned turn 1`, parent still running.
- W6. Focus `btw-composer` and press Escape.
  - Expect the parent still running (`fetchAgentTimeline` status `running`,
    `stub.pending("parent") === 1`).
- W7. Release the parent. `AFTER_B` gives `pinned turn 2`.
  - `HOLD_BTW`, then Stop → `canceled`.
  - `FAIL_BTW` → `btw-provider-error`. Screenshot `btw-provider-failed`.
  - `AFTER_B retry` → completed, composer empty.
- W8. Drop the transport and ask `AFTER_B dispatch retry`.
  - Expect the error feedback and the draft kept.
  - Close the BTW tab with its tab close control, then reopen it with the chip. Expect the same
    error, the same draft, and `stub.requests` unchanged.
  - Restore the transport and Send. Expect the composer empty and the status `completed`.
  - `mainUserCount` is unchanged. Then `verifyBusyMainDeliveries` checks that each explicit
    delivery adds exactly one main message.
- W9. New thread.
  - Expect the same `workspace-tab-btw_<id>`, a new `aria-label`, delivery disabled, no
    `turn-footer`. A draft typed before New is kept.
- W10. Clear.
  - Expect `btw-empty`, `btw-chip` count 0, and the tab still present.
  - Send `AFTER_CLEAR`. Expect the chip back and a fresh nonempty `aria-label` different from the
    thread cleared. Its visible question is `AFTER_CLEAR`, its reply is `BTW_REPLY CONTEXT_A`,
    its authoritative user rows are exactly `["AFTER_CLEAR"]`, and the one newly captured BTW
    model request has `AFTER_CLEAR` in its last question. Save `btw-after-clear-correlation`.

**`BTW compact sheet toggles during generation, retries and restores`** (390×844)

- C1–C2. Same setup.
  - Expect AC2: a workspace sheet with `sheet-tab-header` containing `BTW`, `btw-panel` inside
    `sheet-tab-body`, `sheet-tab-open-as-tab` count 0, and the main composer keeping post-submit
    text. Screenshot `btw-compact-sheet`.
- C3. Header Close.
  - Expect `btw-panel` hidden, `stub.pending("btw") === 1` and no new request.
- C4. Click the chip. Expect the same thread id.
- C5–C8. Steps W5, W7 and W8 inside the sheet. "Close/reopen" uses header Close and the chip.
- C9–C10. W9 and W10 inside the sheet.

**`BTW wide side pane lifecycle survives resize, reload and restart`** (new)

- L1. With the BTW tab open in the Side pane, type `draft line 1\nASCII line 2`. Resize to 390×844.
  - The focused BTW tab stays visible as a pane tab (no sheet) with the draft.
  - Return to 1440×900, click the parent composer to focus it, resize to 390×844 and click its
    visible BTW chip. Expect the existing BTW pane tab revealed with the same draft and no sheet.
    The parent chip belongs to the parent's tab; it is absent while compact shows BTW itself.
- L2. Resize to 1440×900.
  - Expect the BTW tab in the Side pane with the same draft.
- L3. `client.refreshAgent`.
  - Expect the same thread id and timeline rows equal to the rows before the refresh.
- L4. Close the BTW tab and run `page.reload()`.
  - Expect `btw-chip` visible with `aria-expanded="false"`, and `btw-panel` count 0 for 5s.
- L5. Click the chip and reload.
  - Expect `btw-panel` visible from the persisted tab.
  - Restart the isolated daemon (`client.restartServer`) and reload. Expect the chip, the panel
    and identical rows. Screenshot `btw-restored-after-restart`.

**Kept and updated:**

- `BTW {wide|compact} explicit sends land once and output preserves the reader` (AC7). Existing
  send/gesture/output checks remain. Added reopen phases use normal tab/sheet Close and chip,
  a new `agent.provider_subagents.timeline.get.response`, settled sheet and eight stable viewport
  frames, then record the normal-entry baseline and30 quiet frames. Releasing held output or a
  pre-admission transport request is observed over60 frames plus settled completion frames;
  scrollTop and the visible row anchor stay within1px of that new baseline. No gesture after
  reopen cancels a stale pending landing and no old reader position is required. JSON phases
  `reopen-*` in `btw-scroll-geometry` preserve the measurements.
- `BTW compact sheet backdrop dismissal preserves generation and reopens the same thread` (AC4,
  workspace-sheet backdrop).
- `BTW absent extension {wide|compact} keeps the main fallback without a tab or pill` (AC9).
- `BTW wide Send shortcut follows the existing preference`.
- `BTW compact Send shortcut keeps editing ({enter|mod-enter})`.

**Android (AC11): user-exempt, not passed.** The prepared `pi-btw.android.ad` flow is archived
below for provenance; do not execute it. Historical keyboard/Back observations are in G1.

- `wait btw-chip`, press it, then `wait sheet-tab-header`.
- Press and fill `btw-composer` with the software keyboard up. Assert `btw-send` is visible above
  the keyboard and take a screenshot.
- Press header Close, then `wait btw-chip`, press the chip, `wait sheet-tab-header`.
- Press `btw-send`, then `wait btw-stop`.
- Android `back`, then `wait btw-chip`, press the chip, `wait sheet-tab-header`.

**Regressions guarded:**

- Parent focus and draft on auto-open (W2).
- Parent scroll pinned through Side pane creation (W0/W1b).
- Escape isolation (W6).
- No resend across close/reopen (W8).
- No auto-open after reload of a closed tab (L4).
- History integrity across refresh, reload and restart (L3–L5).
- Absent-extension fallback.
- Land-once scroll behavior.
