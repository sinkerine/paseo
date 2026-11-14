# Prevent unwanted automatic focus switching to newly opened tabs

Design only. Branch: `wicked-racoon`; base: `2e9d69649f39770d3ced777900d6be8bcfba269e`
(`refs/remotes/origin/main`). Workspace: `wks_dc503b895d03d796`.

Design decisions are finalized autonomously; human input and explicit user approval are not required.
**G0 (visible Design tab gate) resolved:** verified by orchestrator (`paseo agent open` returned
`status: "opened"`). No feature code has been implemented, no software has been installed outside
the worktree, and no commit has been created during design.

## 1. Goal and acceptance criteria

Paseo must never steal OS window focus, hijack another window's active workspace, switch the active
pane or tab, disturb reading scroll position, or pull keyboard focus out of an active composer when
a tab opens through background automation, directory/terminal reconciliation, non-focused browser
activity, or multi-window layout persistence. Deliberate human tab opens keep their existing
foreground behavior, and in multi-window Paseo Desktop an explicit external agent open targets a
window already viewing that agent's workspace instead of hijacking an unrelated focused window.

### Root cause findings

Investigation across CLI, Electron Desktop, workspace layout reconciliation, browser tab opening,
and multi-window storage established four concrete mechanisms behind unwanted focus switches:

1. **Agent-triggered `paseo agent open` and blind multi-window routing (`packages/cli/src/commands/agent/open.ts`, `packages/desktop/src/window/desktop-window-owner.ts`, `packages/app/src/desktop/agent-navigation.tsx`).**
   Daemon-spawned agent shells export `PASEO_AGENT_ID`, which CLI commands such as `paseo run` and
   `paseo send` already inspect via `resolveCallerAgentId` (`packages/cli/src/utils/caller-agent.ts`).
   `paseo agent open` ignores `PASEO_AGENT_ID` and offers no `--no-focus` / `--focus` option: every
   call launches `paseo://h/<serverId>/agent/<agentId>`, `DesktopWindowOwner.openOrFocusAgent`
   selects `focusedWindow() ?? visible ?? windows[0]`, unconditionally calls `restore()`, `show()`,
   and `focus()`, and `AgentNavigationListener` calls `navigateToAgent` (`intent: "reveal"`). With
   Window 1 on Workspace A (running an orchestrator workflow that calls `paseo agent open`) and
   Window 2 focused on Workspace B (where the user is typing), `focusedWindow()` selects **Window 2**,
   navigates Window 2 away from Workspace B to Workspace A, switches its active tab to the newly
   opened agent, and auto-focuses the new composer—leaving Window 1 without the opened tab while
   hijacking Window 2. Even for a human-invoked `paseo agent open`, `openOrFocusAgent` has no
   workspace affinity and hijacks Window 2 instead of focusing Window 1 when Window 1 already
   displays Workspace A.
2. **Background and reconciled tab insertion replacing `new_tab` and targeting secondary split panes (`packages/app/src/stores/workspace-layout-actions.ts`, `packages/app/src/stores/workspace-layout-store.ts`).**
   - `resolvePlacementPane` and `getOpenTabPlacement` resolve `AMBIENT_PLACEMENT` (`{ mode: "ambient" }`)
     through `layout.focusedPaneId` before `DEFAULT_PANE_ID` (`"main"`). When focus is in a right
     split pane (an empty `new_tab` split or a side pane holding files/diffs), reconciled agents,
     standalone terminals, and `intent: "background"` opens land in that focused split pane instead
     of `main`.
   - `insertNewTabIntoPane` checks `isSoleNewTabPane(targetPane)` and replaces `new_tab` in place
     even when `focus: false`. After initial workspace hydration—such as in an empty split pane, an
     empty workspace launcher, or a user-opened `+` (`new_tab`) tab—a reconciled entity or
     `intent: "background"` open (`browser_new_tab`, failed `setup`, `autoOpenPullRequestTab`)
     replaces `new_tab`, becomes `focusedTabId` of the focused pane, and steals composer focus.
   - `WorkspaceLayoutStore.openTab` unconditionally clears `focusRestorationByWorkspace` even when
     `input.intent === "background"`, dropping parked pane focus restoration while Command Center or
     a modal is open.
3. **In-app browser new-tab requests ignoring background disposition and unfocused guests (`packages/desktop/src/features/browser-webviews/window-open.ts`, `packages/app/src/desktop/browser/new-tab-requests/index.ts`, `packages/app/src/screens/workspace/workspace-screen.tsx`).**
   `decideBrowserWindowOpenRequest` drops Electron's `disposition === "background-tab"` (middle-click
   or Cmd/Ctrl-click), and `handleOpenUrlInBrowserTab` always calls `openWorkspaceTabFocused`
   (`intent: "reveal"`), even when `sourceBrowserId` is not the active tab of the focused pane (for
   example, an agent clicking a `target="_blank"` link via `browser_click` in a resident background
   `<webview>` while the user is typing in Chat).
4. **Multi-window `workspace-layout-state` persistence clobbering (`packages/app/src/stores/workspace-layout-store.ts`, `packages/app/src/storage/validated-persist-storage.ts`).**
   All Electron windows share `window.localStorage["workspace-layout-state"]`. Each window holds a
   startup snapshot of `layoutByWorkspace` across all workspaces and writes its entire map whenever
   any workspace layout changes, overwriting tab selections that another window persisted in other
   workspaces. Reloading a window or restarting the app then jumps a workspace back to a stale
   focused tab from the other window's snapshot.

### Classification, decisions, and gate resolution

- **D1. Feature vs bug-fix classification.** Ruling: classify as a **new feature addition** that
  resolves unwanted existing focus-switching behavior — avoiding auto-focus across multiple windows
  introduces new CLI flags (`--focus` / `--no-focus`), an optional `?focus=0` deep-link contract,
  Electron multi-window active-workspace affinity and background open IPC, browser background-tab
  propagation, and per-workspace multi-window persistence merging alongside background layout bug
  fixes — cost if wrong: running the initial isolated E2E verification phase (~2–4 min) when unit
  tests alone would not prove real two-window Electron focus and `second-instance` routing.
  **E2E rule:** E2E tests are required for this initial feature addition (including repairs and
  reruns during this workflow). Future pushes or deployments of existing features do not require E2E
  reruns, though existing unit tests must still be run. Do not add push/deploy E2E requirements to
  `AGENTS.md` or `CLAUDE.md`.
- **D2. Behavior over settings.** Ruling: fix focus ownership directly by source intent rather than
  adding an app preference toggle — background automation, reconciliation, `background-tab` link
  clicks, and unfocused `<webview>` opens must never steal focus by default, while deliberate human
  clicks in a window must continue to reveal the clicked target (`CLAUDE.md`: ship enabled by
  default, no unnecessary settings gates) — cost if wrong: a user who wants direct in-pane file or
  subagent clicks to open behind the current tab would still need a separate modifier gesture later.
- **D3. Agent-invoked `paseo agent open` defaults to non-focusing; human CLI defaults to focusing, with explicit `--focus` / `--no-focus` overrides.**
  Ruling: add `.option("--focus", ...)` and `.option("--no-focus", ...)` on `paseo agent open`
  (avoiding `--background`, which Paseo's glossary reserves for hidden `agent.background` discovery).
  When neither flag is passed, `paseo agent open` defaults to `focus = false` when invoked from a
  live agent shell (`resolveCallerAgentId(client, env)` when connected, or non-empty
  `PASEO_AGENT_ID` when `--server` bypasses daemon lookup) and `focus = true` when invoked from a
  human shell or workspace terminal (which exports `PASEO_WORKSPACE_ID`, never `PASEO_AGENT_ID`) —
  existing skills and agent scripts (`paseo agent open <id>`) stop stealing focus immediately
  without editing outside-worktree skills, while human terminal users keep explicit focus unless
  they pass `--no-focus` — cost if wrong: an automation script running outside any Paseo agent shell
  without `PASEO_AGENT_ID` must pass `--no-focus` to open silently.
- **D4. Deep-link wire shape stays workspace-free.** Ruling: extend `AgentDeepLinkTarget` with
  optional `focus?: boolean`; `buildAgentDeepLink` emits `paseo://h/<serverId>/agent/<agentId>` when
  `focus !== false` and appends `?focus=0` only when `focus === false`; `parseAgentDeepLink` accepts
  either empty search or the exact single parameter `?focus=0`, rejecting all other query strings or
  hashes — preserves `docs/expo-router.md` ("Keep the stable agent URL free of a workspace hint")
  and full backward compatibility in `packages/protocol` — cost if wrong: Electron main queries a
  ready renderer over local IPC when `windows.length > 1` instead of reading a URL workspace hint.
- **D5. Multi-window routing policy in `DesktopWindowOwner`.** Ruling: each renderer publishes its
  current `ActiveWorkspaceSelection | null` (`{ serverId, workspaceId } | null`) to main; when
  `windows.length > 1`, main resolves the target agent's `workspaceId` via a bounded (1,500 ms)
  typed IPC query to a ready renderer:
  - For **non-focusing opens (`target.focus === false`)**: never call `restore()`, `show()`, or
    `focus()` on any window. If one or more windows currently view `(serverId, workspaceId)`, deliver
    `{ serverId, agentId, focus: false }` to all matching windows so the tab appears immediately in
    their tab bars without changing their active tab; if no window currently views that workspace,
    deliver `{ serverId, agentId, focus: false }` to one fallback live window so it persists the
    background tab under `layoutByWorkspace["<serverId>:<workspaceId>"]` without changing its own
    route or active tab. If zero windows exist, open the primary window at `initialRoute: null` with
    `showInactive: true` and queue `{ serverId, agentId, focus: false }` in `AgentNavigationInbox`.
  - For **focusing opens (`target.focus !== false`)**: prefer windows already viewing
    `(serverId, workspaceId)` (focused among them → visible among them → first among them) before
    falling back to `focusedWindow() ?? visible ?? windows[0]`; then `restore()`, `show()`, `focus()`,
    and deliver `{ serverId, agentId }` to that single window.
    — prevents Workspace B windows from ever being hijacked onto Workspace A when Workspace A is
    already open in another window, and eliminates OS/window/tab focus theft on background opens —
    cost if wrong: one bounded local IPC round-trip when `windows.length > 1`.
- **D6. Separate foreground and background queues in `AgentNavigationInbox`.** Ruling: retain
  latest-wins replacement for queued foreground agent navigations (`focus !== false`), while storing
  queued non-focusing opens (`focus === false`) in a separate per-window deduplicated FIFO queue
  flushed when `paseo:agent-navigation:ready` fires — prevents multiple rapid background opens from
  dropping each other or clobbering a startup foreground deep link — cost if wrong: ~20 lines of
  state in `AgentNavigationInbox`.
- **D7. Background agent-tab open bypasses Expo Router navigation and `pendingOpenByWorkspace`.**
  Ruling: when `AgentNavigationListener` receives `focus === false`, it resolves `workspaceId` via
  `useSessionStore` or `client.fetchAgent({ agentId })`, waits for `useWorkspaceLayoutStore`
  hydration, and calls `openTab({ workspaceKey, target: { kind: "agent", agentId }, intent: "background", pin: true })`
  directly without calling `navigateToAgent`, `navigateToWorkspace`, `revealWorkspaceTab`,
  `rememberLastWorkspace`, or `deferOpenTab` — preserves the `pendingOpenByWorkspace` explicit-open
  handoff, `stable-scroll` initial-entry landing, and `agent-attention` deliberate-focus rules
  untouched — cost if wrong: `AgentNavigationListener` owns a small cancellable lookup helper for
  offline/unhydrated hosts.
- **D8. Ambient placement and `new_tab` replacement boundaries.** Ruling:
  - `AMBIENT_PLACEMENT` resolves to `DEFAULT_PANE_ID` (`"main"`) when visible and target-compatible,
    otherwise the first visible compatible non-explorer pane that is not a sole `new_tab` pane,
    otherwise the first visible compatible non-explorer pane (falling back to Explorer only when no
    main-host pane exists). Explicit `openTab` calls with `intent !== "background"` and omitted
    `placement` keep `FOCUSED_PANE_PLACEMENT`; `intent === "background"` with omitted `placement`
    uses `AMBIENT_PLACEMENT`.
  - Track non-persisted `reconciledWorkspaceKeys: Set<string>` in `WorkspaceLayoutStore`. Replacing
    a sole `new_tab` tab when `focus === false` is permitted **only** during the initial unhydrated/first
    hydrated `reconcileTabs` pass of a workspace that has not yet been reconciled or mutated in this
    store session and has only a single visible ordinary pane holding `new_tab`. Every subsequent
    `reconcileTabs` pass and every `openTab(..., intent: "background")` call keeps any existing
    `new_tab` tab in place and preserves `focusedTabId`, `focusedPaneId`, and
    `focusRestorationByWorkspace`.
    — preserves landing on an existing agent when first opening a workspace while stopping later
    background/reconciled tabs from hijacking `new_tab` launchers or split panes — cost if wrong: none.
- **D9. Browser new-tab focus gating.** Ruling: propagate `background: true` from
  `decideBrowserWindowOpenRequest` when `disposition === "background-tab"`. In the workspace screen,
  focus a newly requested browser tab (`intent: "reveal"`) **only** when `request.background !== true`,
  `isRouteFocused === true`, and `getFocusedBrowserId(workspaceLayout) === request.sourceBrowserId`;
  otherwise open it with `intent: "background"` in the source browser tab's pane — respects
  middle/Cmd/Ctrl-click and prevents agent-driven `<webview>` link opens from stealing chat focus —
  cost if wrong: a link opened asynchronously by page timer after the user already switched to
  another tab opens in the background instead of yanking them back, which is desirable.
- **D10. Per-workspace multi-window persistence merge; live in-memory independence.** Ruling: keep
  live in-memory `useWorkspaceLayoutStore` state independent per window (never subscribe to DOM
  `storage` events, which would synchronize tab switches across two windows viewing the same
  workspace), and wrap `workspace-layout-state` persistence so each store write diffs its projection
  against its own last hydrated/written baseline and merges only changed/purged workspace keys onto
  the latest valid envelope in `backingStorage` — prevents Window 2 from clobbering Window 1's saved
  tab selection in other workspaces on reload/restart — cost if wrong: one `backingStorage.getItem`
  read per actual layout mutation (unchanged reconciliations remain skipped before serialization via
  `skipUnchanged`).
- **Gates:**
  - **G0 (Visible Design tab open):** Resolved (`paseo agent open` returned `status: "opened"`).
  - **G1 (Human design input / approval):** Not required; no ambiguous product scope or user
    approval request exists.
  - **G2 (Outside-worktree software installation):** Not required; Node, npm, `node_modules`,
    Playwright, Electron (`packages/desktop/node_modules/electron`), and `xvfb-run` / display are
    already present. Do not install software outside the worktree without user approval.

### Acceptance criteria

| ID       | Observable behavior, entry paths, and state transitions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Exact acceptance evidence                                                                                                                                                                                                                                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AC1**  | **Agent-invoked and `--no-focus` CLI opens in multi-window Desktop:** When Window 1 views Workspace A (focused on Chat A1 with a composer draft and scrolled-up transcript) and Window 2 is OS-focused on Workspace B (focused on Chat B1 with active composer focus and draft), running `paseo agent open <agentA2>` with `PASEO_AGENT_ID` set **or** `paseo agent open <agentA2> --no-focus` (without `PASEO_AGENT_ID`) adds `<agentA2>` to Workspace A's tab strip in Window 1 (`status: "opened"`), stamps `paseo.open-agent-tab.<clientId>` if `<agentA2>` is a subagent, keeps Window 1's active tab on Chat A1 with its scroll offset and draft intact, and leaves Window 2 OS-focused on Workspace B / Chat B1 with `document.activeElement` and composer draft unchanged. Repeating the same command is an idempotent no-op that neither duplicates the tab nor changes focus.                                                                                                                                                                                                                                                                                                                                       | U1 (`agent-deep-link.test.ts`), U2 (`open.test.ts`), U3 (`desktop-window-owner.test.ts`, `agent-navigation.test.ts`), U4 (`agent-navigation.test.tsx`), E2 (`tab-focus-multiwindow.electron.mjs` J1, J2).                                                                                                                                                   |
| **AC2**  | **Background CLI open for unseen workspaces, minimized windows, archived agents, and zero-window / cold-launch Desktop:** (a) When no open window views Workspace C (and another window is minimized), `paseo agent open <agentC> --no-focus` (or `PASEO_AGENT_ID` default) leaves the minimized window minimized (`isMinimized() === true`), leaves the focused window on Workspace B with its active tab and composer focus unchanged, and persists `<agentC>` in `layoutByWorkspace` for Workspace C so navigating to Workspace C later reveals `<agentC>` in its tab strip. (b) Opening an **archived** agent via `paseo agent open <archivedAgentId> --no-focus` persists it with `pin: true` so `reconcileWorkspaceTabs` retains the tab when Workspace A is opened and renders the archived callout on selection without having stolen focus earlier. (c) When Desktop is not running or has zero windows (`windows.length === 0`), a `--no-focus` / `PASEO_AGENT_ID` open starts the primary window at `initialRoute: null` (`showInactive: true`), restores the user's remembered workspace instead of routing to `/h/<serverId>/agent/<agentId>`, and adds the target agent tab in the background of its workspace. | U3 (`desktop-window-owner.test.ts` resident zero-window + minimized), U4 (`agent-navigation.test.tsx`), U5 (`workspace-layout-store.test.ts` pinned archived background open), E2 (`tab-focus-multiwindow.electron.mjs` J3a unseen/minimized, J3b archived agent, J3c real cold-launch zero-window `?focus=0`).                                             |
| **AC3**  | **Explicit human CLI open (`paseo agent open <id>` without `PASEO_AGENT_ID`, or `paseo agent open <id> --focus` with `PASEO_AGENT_ID`) and external `paseo://h/<serverId>/agent/<agentId>` deep links:** In multi-window Desktop where Window 1 views Workspace A and Window 2 is focused on Workspace B, an explicit focusing open for `<agentA2>` in Workspace A restores/shows/focuses **Window 1** and reveals `<agentA2>` in Window 1 while leaving **Window 2** on Workspace B untouched. When no open window views Workspace A, the focused/visible/first window navigates to Workspace A and focuses `<agentA2>` as before, preserving initial-entry bottom landing and deliberate attention clearing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | U1, U2, U3, E2 (`tab-focus-multiwindow.electron.mjs` J4).                                                                                                                                                                                                                                                                                                   |
| **AC4**  | **Startup / loading inbox queueing and overlapping triggers:** While a Desktop window is still loading, multiple background `open-agent` deliveries (`focus: false`) are retained in FIFO order without dropping earlier background targets and without overwriting or being overwritten by a concurrent foreground `open-agent` (`focus !== false`); duplicate background deliveries for the same `(serverId, agentId)` coalesce cleanly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | U3 (`agent-navigation.test.ts`), U4 (`agent-navigation.test.tsx`).                                                                                                                                                                                                                                                                                          |
| **AC5**  | **Automatic tab reconciliation (`reconcileWorkspaceTabs`) across single-pane, split-pane, and multi-window layouts:** When `SessionStore` directory sync or `useWorkspaceTerminals` delivers a new workspace-root agent, cross-workspace subagent, or standalone terminal into the shared `deriveWorkspaceAgentVisibility` → `reconcileWorkspaceTabs` boundary (upstream daemon producers such as MCP `create_agent`/`terminal_create` and cron schedules are unmodified and converge on this same boundary), its tab opens in the background of `main` without changing `focusedPaneId`, `focusedTabId`, `focusRequest`, composer focus/draft, or chat scroll offset—including when (a) a split pane holds a focused `new_tab` launcher, (b) focus is in a side pane viewing a file/diff, (c) the workspace already hydrated empty (`new_tab`) or the user opened `+` (`new_tab`), or (d) two windows view the same or different workspaces. First-time hydration of an uninitialized single-pane workspace with existing agents still replaces the bootstrap `new_tab` placeholder so opening an existing workspace lands on its agent.                                                                                     | U5 (`workspace-layout-store.test.ts`, `agent-visibility.test.ts`, `workspace-subagents-integration.test.ts`), E1 (`tab-focus-preservation.spec.ts` root agent, cross-workspace subagent, and standalone terminal across split/side/`new_tab`), E2 (`tab-focus-multiwindow.electron.mjs` J5 `paseo run --no-wait` + standalone terminal across two windows). |
| **AC6**  | **Explicit `intent: "background"` tab opens (`browser_new_tab`, failed `setup` auto-seed, `autoOpenPullRequestTab`, background agent open) under `new_tab` and parked focus:** Calling `openTab` with `intent: "background"` never replaces an open `new_tab` launcher, never changes `focusedPaneId` or `focusedTabId`, never sets `focusRequest`, never dismisses compact sheets, and never clears `focusRestorationByWorkspace` tokens while pane focus is parked by an overlay; closing the overlay restores focus to the originally focused pane/tab.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | U5 (`workspace-layout-store.test.ts`), E1 (`tab-focus-preservation.spec.ts`).                                                                                                                                                                                                                                                                               |
| **AC7**  | **In-app browser new-tab requests (`BROWSER_NEW_TAB_REQUEST_EVENT`):** Clicking a link with `disposition: "background-tab"` (Cmd/Ctrl-click or middle-click) in a focused browser tab, or triggering `window.open` / `target="_blank"` from an unfocused or background resident `<webview>` (such as `browser_click` automation while the user is focused in an agent chat tab or another split pane), opens the new browser tab in the background of the source browser's pane without switching the active tab, pane focus, or composer focus. Foreground clicks (`foreground-tab` / `new-window` non-popup) inside the currently focused browser tab of a focused workspace route continue to focus the new browser tab; OAuth/POST popups and denied URL schemes remain unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                        | U6 (`window-open.test.ts`, `new-tab-requests/index.test.ts`), E1 (`tab-focus-preservation.spec.ts`), E2 (`tab-focus-multiwindow.electron.mjs` J6).                                                                                                                                                                                                          |
| **AC8**  | **Multi-window `workspace-layout-state` persistence isolation across reload/restart:** When Window 1 changes tab selection/layout in Workspace A and Window 2 subsequently changes tab selection/layout (or reconciles tabs) in Workspace B, `localStorage["workspace-layout-state"]` retains both Window 1's latest Workspace A layout and Window 2's latest Workspace B layout; reloading Window 1 or restarting restores Workspace A's selected tab without snapping back to Window 2's stale snapshot, and `purgeWorkspace` in a window removes only the purged workspace key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | U7 (`workspace-layout-persistence.test.ts`), E1 (`tab-focus-preservation.spec.ts`), E2 (`tab-focus-multiwindow.electron.mjs` J7).                                                                                                                                                                                                                           |
| **AC9**  | **Failure and recovery handling:** `paseo agent open <missing-id>` (with or without `--no-focus` / `--focus`) still fails with `AGENT_NOT_FOUND` and never launches Desktop. If a background `open-agent` arrives while its host is offline or before the agent appears in `SessionStore`, `AgentNavigationListener` retries cleanly on host connection without navigating routes or surfacing blank screens; if the daemon confirms the agent does not exist (`fetchAgent` returns `null`), the background request settles as a clean no-op without mutating any layout or route. If `resolveAgentWorkspace` times out or fails in Electron main, `openOrFocusAgent` falls back cleanly without hanging or crashing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | U2 (`open.test.ts`, `42-agent-open.test.ts`), U3 (`desktop-window-owner.test.ts`), U4 (`agent-navigation.test.tsx`).                                                                                                                                                                                                                                        |
| **AC10** | **Preserved explicit in-window opens, stable scroll, deliberate attention clearing, and preload sandbox:** Direct foreground user actions modified or shared by `openTab` (`intent: "new"` and `intent: "reveal"`)—specifically `+` → **New agent**, `+` → **New terminal**, `+` → **New browser** (Desktop), clicking a file in the Explorer sidebar, clicking a subagent row in the Subagents track, and clicking an existing tab in the tab strip—continue to activate the target tab immediately, focus its composer/terminal when applicable, run bounded one-shot scroll landing on new chat entry/send, and clear unread agent attention only on deliberate focus while active streaming viewport position stays stationary during background tab opens. `preload.ts` retains zero non-Electron runtime imports. Untouched `intent: "reveal"` callers (`useAgentProfileStartShortcut` and `NotificationOpenRouter`) remain protected invariants verified at their existing unit boundaries.                                                                                                                                                                                                                            | U3 (`preload-sandbox.test.ts`), U5 (`workspace-layout-store.test.ts`, `agent-attention.test.ts`, `use-start-shortcut.test.tsx`, `notification-open/model.test.ts`), E1 (`tab-focus-preservation.spec.ts` J8), E2 (`tab-focus-multiwindow.electron.mjs` J5, J8), E3 (`subagent-origin-pane.spec.ts`, `sidebar-workspace-mark-unread.spec.ts`).               |
| **AC11** | **Static, type, lint, format, build, and consumer verification:** Protocol/client/server/desktop builds, root `npm run typecheck`, root `npm run lint`, `npm run format:check`, targeted Vitest suites, isolated app Playwright specs, and isolated Desktop multi-window Electron E2E pass without touching the main daemon on port `6767`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | §4 checks `B0`, `C1–C5`, `K1–K4`, `U1–U7`, `E1`, `E2`, `E3`.                                                                                                                                                                                                                                                                                                |
| **AC12** | **Documentation accuracy:** `docs/development.md` and `docs/architecture.md` accurately describe `paseo agent open` focus behavior (`--focus` / `--no-focus`, `PASEO_AGENT_ID` automation default, `?focus=0`) and multi-window workspace-affinity / per-workspace layout persistence without adding push/deploy E2E rules to `AGENTS.md` or `CLAUDE.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | **DOC1** (`docs/development.md`), **DOC2** (`docs/architecture.md`).                                                                                                                                                                                                                                                                                        |

### Documentation items

- **DOC1 (`docs/development.md`):** Update the CLI quick-reference and Desktop deep-link paragraph
  around lines 669–690 to document `--no-focus` / `--focus`, automatic non-focusing behavior when
  called from an agent shell (`PASEO_AGENT_ID`), and `?focus=0` on `paseo://h/<server-id>/agent/<agent-id>`.
- **DOC2 (`docs/architecture.md`):** Integrate multi-window agent-open workspace affinity, non-focusing
  background delivery, and per-workspace `workspace-layout-state` persistence merging into the
  `packages/desktop` Multi-window section (~line 217).

## 2. Design

### Module boundaries

| Package / Module                                                                                                         | Responsibility                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/protocol/src/agent-deep-link.ts`                                                                               | Pure URL codec for `AgentDeepLinkTarget` (`{ serverId, agentId, focus?: boolean }`) with exact `?focus=0` parsing and zero workspace hints.                                                                                                                                                                                                      |
| `packages/cli/src/commands/agent/open.ts`                                                                                | Parses `--focus` / `--no-focus`, detects live caller agent via `resolveCallerAgentId` (or `PASEO_AGENT_ID` when `--server` is explicit), validates target existence on the daemon, and launches Desktop with `AgentDeepLinkTarget`.                                                                                                              |
| `packages/desktop/src/agent-navigation.ts`                                                                               | Parses argv deep links and owns `AgentNavigationInbox` with independent foreground (latest-wins) and background (deduplicated FIFO) queues per `webContentsId`.                                                                                                                                                                                  |
| `packages/desktop/src/window/desktop-window-owner.ts`                                                                    | Pure multi-window routing coordinator: tracks each window's reported `{ serverId, workspaceId }`, queries `resolveAgentWorkspace` when `windows.length > 1`, routes focusing opens to workspace-matching windows first, and delivers non-focusing opens without calling `restore()`, `show()`, or `focus()`.                                     |
| `packages/desktop/src/main.ts` & `packages/desktop/src/preload.ts`                                                       | Wires `paseo:window:setActiveWorkspace`, `paseo:agent-navigation:resolve-workspace-request` / `reply` (1,500 ms timeout), `showInactive` option on background cold window creation, and `background` flag on `BROWSER_NEW_TAB_REQUEST_EVENT`. `preload.ts` uses zero non-Electron runtime imports.                                               |
| `packages/desktop/src/features/browser-webviews/window-open.ts`                                                          | Preserves `background: true` on `workspace-tab` decisions and `PendingBrowserWindowOpenRequests` when `disposition === "background-tab"`.                                                                                                                                                                                                        |
| `packages/app/src/desktop/host.ts` & `packages/app/src/desktop/agent-navigation.tsx`                                     | Publishes `useActiveWorkspaceSelection()` to Desktop main, answers workspace-lookup IPC from `useSessionStore` / `fetchAgent`, routes `focus !== false` payloads to `navigateToAgent({ serverId, agentId, pin: true })`, and routes `focus === false` payloads to background `openTab` without touching Expo Router or `pendingOpenByWorkspace`. |
| `packages/app/src/desktop/browser/new-tab-requests/index.ts` & `packages/app/src/screens/workspace/workspace-screen.tsx` | Focuses guest-requested browser tabs only when `!request.background && isRouteFocused && getFocusedBrowserId(workspaceLayout) === request.sourceBrowserId`; otherwise opens in the background of the source browser's pane.                                                                                                                      |
| `packages/app/src/stores/workspace-layout-actions.ts` & `packages/app/src/stores/workspace-layout-store.ts`              | Routes `AMBIENT_PLACEMENT` to `main` (avoiding focused side/split `new_tab` panes), restricts `focus: false` replacement of a sole `new_tab` tab to the first unhydrated/initial reconciliation of a single-pane workspace (`reconciledWorkspaceKeys`), and preserves `focusRestorationByWorkspace` during `intent: "background"` opens.         |
| `packages/app/src/stores/workspace-layout-persist-storage.ts` (collocated under `packages/app/src/stores/`)              | Per-store-instance persistence adapter wrapping `createValidatedPersistStorage` so writes diff against this window's baseline and merge only changed/purged workspace keys onto the latest stored `workspace-layout-state`.                                                                                                                      |

### Data flow

```text
1. Automated / non-focusing CLI open (PASEO_AGENT_ID set or --no-focus):
   paseo agent open <agentId>
     -> resolveOpenFocusMode({ explicitFocus, hasCallerAgent }) => false
     -> launchDesktop(["paseo://h/<serverId>/agent/<agentId>?focus=0"])
     -> Electron second-instance / open-url -> desktopWindowOwner.openOrFocusAgent({ ..., focus: false })
     -> NO restore/show/focus on any BrowserWindow
     -> windows viewing (serverId, workspaceId) [or 1 fallback window] receive "paseo:event:open-agent"
     -> AgentNavigationListener -> openAgentTabInBackground({ serverId, agentId })
     -> useWorkspaceLayoutStore.openTab({ workspaceKey, target, intent: "background", pin: true })
     -> Tab appears in Workspace A's tab strip; Window 2 on Workspace B & active composer untouched.

2. Explicit human CLI / deep-link open (no PASEO_AGENT_ID, or --focus):
   paseo agent open <agentId>
     -> launchDesktop(["paseo://h/<serverId>/agent/<agentId>"])
     -> desktopWindowOwner.openOrFocusAgent({ serverId, agentId })
     -> if windows.length > 1: resolveAgentWorkspace -> prefer window viewing (serverId, workspaceId)
     -> chosenWindow.restore()/show()/focus() + send "paseo:event:open-agent"
     -> AgentNavigationListener -> navigateToAgent({ serverId, agentId, pin: true })

3. Reconciliation & background opens in WorkspaceLayoutStore:
   reconcileTabs / openTab(intent: "background")
     -> placement defaults to AMBIENT_PLACEMENT -> resolves to "main" (never focused side/split new_tab)
     -> allowInitialNewTabReplace is true ONLY before workspaceKey's first hydrated reconcile/mutation
     -> preserves focusedPaneId, focusedTabId, focusRestorationByWorkspace, sheets, and composer focus.

4. Multi-window workspace-layout-state persistence:
   Window N mutates workspaceKey K
     -> projection diffs against Window N's baseline -> changedKeys = {K}, purgedKeys = {...}
     -> reads latest backingStorage["workspace-layout-state"], overlays only changedKeys / deletes purgedKeys
     -> updates Window N baseline and writes merged state (other windows' workspaces preserved).
```

### Exact interface signatures

#### `packages/protocol/src/agent-deep-link.ts`

```ts
export interface AgentDeepLinkTarget {
  serverId: string;
  agentId: string;
  focus?: boolean;
}

export function buildAgentDeepLinkRoute(
  target: Pick<AgentDeepLinkTarget, "serverId" | "agentId">,
): `/h/${string}/agent/${string}`;

export function buildAgentDeepLink(target: AgentDeepLinkTarget): string;
// focus === false -> `paseo://h/${enc(serverId)}/agent/${enc(agentId)}?focus=0`
// otherwise       -> `paseo://h/${enc(serverId)}/agent/${enc(agentId)}`

export function parseAgentDeepLink(input: string): AgentDeepLinkTarget | null;
// Empty search -> { serverId, agentId }
// Exact single query param `?focus=0` (url.search === "?focus=0") -> { serverId, agentId, focus: false }
// Any other search or any hash -> null
```

#### `packages/cli/src/commands/agent/open.ts`

```ts
export interface OpenAgentCommandOptions extends CommandOptions {
  server?: string;
  focus?: boolean;
}

export function resolveOpenFocusMode(input: {
  explicitFocus: boolean | undefined;
  hasCallerAgent: boolean;
}): boolean;
// explicitFocus !== undefined ? explicitFocus : !input.hasCallerAgent

export function addOpenOptions(command: Command): Command;
// Adds:
//   .option("--focus", "Focus Paseo Desktop and switch to the agent tab")
//   .option("--no-focus", "Open the agent tab without focusing a window or switching the active tab")
```

When `options.server` is omitted, `resolveAgentTarget` reuses its existing `DaemonClient` to run
`resolveCallerAgentId(client, env)` alongside `client.fetchAgent({ agentId })`. When
`options.server` is provided, `hasCallerAgent` is `Boolean(env.PASEO_AGENT_ID?.trim())`. When
`resolveOpenFocusMode(...) === false`, `runOpenCommand` passes `{ ...target, focus: false }` to
`openDesktopWithAgent`. Output schema `{ agentId, serverId, status: "opened" }` remains unchanged
so CLI callers (including `e2e-feature`) stay 100% compatible.

#### `packages/desktop/src/agent-navigation.ts`

```ts
export class AgentNavigationInbox {
  windowLoading(webContentsId: number): void;
  windowReady(webContentsId: number): AgentDeepLinkTarget | null;
  drainBackground(webContentsId: number): AgentDeepLinkTarget[];
  deliverOrQueue(webContentsId: number, target: AgentDeepLinkTarget): AgentDeepLinkTarget | null;
  removeWindow(webContentsId: number): void;
}
```

- When `webContentsId` is in `readyWindows`, `deliverOrQueue` returns `target` immediately for both
  foreground and background targets.
- When not yet ready:
  - `target.focus === false`: appends `{ serverId: target.serverId, agentId: target.agentId, focus: false }`
    to `pendingBackgroundByWindow` unless an entry with the same `serverId` and `agentId` is already
    queued (nor equal to `pendingForegroundByWindow`'s target), and returns `null`.
  - `target.focus !== false`: overwrites `pendingForegroundByWindow.set(webContentsId, { serverId: target.serverId, agentId: target.agentId })`,
    removes any matching `(serverId, agentId)` from `pendingBackgroundByWindow` (since foreground
    supersedes background for the same agent), and returns `null`.
- On `ipcMain.handle("paseo:agent-navigation:ready")`, main reads `const foreground = inbox.windowReady(id)`
  and `for (const bg of inbox.drainBackground(id)) event.sender.send("paseo:event:open-agent", bg)`,
  returning `foreground`.

#### `packages/desktop/src/window/desktop-window-owner.ts`

```ts
export interface DesktopActiveWorkspaceSelection {
  serverId: string;
  workspaceId: string;
}

export interface OwnedDesktopWindow<
  TAgentTarget extends { serverId: string; agentId: string; focus?: boolean },
> {
  webContentsId: number;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  sendAgent(target: TAgentTarget): void;
}

export interface DesktopWindowOwnerPort<
  TAgentTarget extends { serverId: string; agentId: string; focus?: boolean },
> {
  create(input: {
    initialRoute: string | null;
    restoreWindowState: boolean;
    showInactive?: boolean;
    onCreated(webContentsId: number): void;
    onClosed(webContentsId: number): void;
  }): Promise<OwnedDesktopWindow<TAgentTarget>>;
  windows(): OwnedDesktopWindow<TAgentTarget>[];
  focusedWindow(): OwnedDesktopWindow<TAgentTarget> | null;
  agentRoute(target: TAgentTarget): string;
  deliverAgent(webContentsId: number, target: TAgentTarget): TAgentTarget | null;
  resolveAgentWorkspace?(
    target: Pick<TAgentTarget, "serverId" | "agentId">,
  ): Promise<string | null>;
}

export interface DesktopWindowOwner<
  TAgentTarget extends { serverId: string; agentId: string; focus?: boolean },
> {
  openPrimary(input?: {
    initialRoute?: string | null;
    pendingProjectPath?: string | null;
    showInactive?: boolean;
  }): Promise<void>;
  openAdditional(input?: { pendingProjectPath?: string | null }): Promise<void>;
  openOrFocusAgent(target: TAgentTarget): Promise<void>;
  restoreWhenActivated(): Promise<void>;
  setActiveWorkspace(
    webContentsId: number,
    selection: DesktopActiveWorkspaceSelection | null,
  ): void;
  takePendingProject(webContentsId: number): string | null;
}
```

`showWindowWhenReady` (`packages/desktop/src/window/show-when-ready.ts`) accepts optional
`showInactive?: boolean` and calls `win.showInactive()` (falling back to `win.show()` if unavailable
in a minimal test double) without focusing when `showInactive === true`.

In `packages/desktop/src/main.ts` (`bootstrap()`), cold-start `initialAgentNavigation` distinguishes
foreground vs background launch arguments:

- When `initialAgentNavigation` is present and `initialAgentNavigation.focus !== false`: pass
  `initialRoute: buildAgentDeepLinkRoute(initialAgentNavigation)` to `desktopWindowOwner.openPrimary`
  (existing cold deep-link behavior).
- When `initialAgentNavigation?.focus === false` (cold Desktop launch triggered by `paseo agent open --no-focus`
  or `PASEO_AGENT_ID` automation): pass `initialRoute: null` and `showInactive: true` to
  `desktopWindowOwner.openPrimary`, then call `await desktopWindowOwner.openOrFocusAgent(initialAgentNavigation)`
  so the window restores the user's remembered workspace selection while `agentNavigationInbox`
  delivers the background tab once the renderer reports ready.

#### `packages/desktop/src/preload.ts` & `packages/app/src/desktop/host.ts`

In `preload.ts` (using only `ipcRenderer` from `"electron"`—zero local runtime imports):

```ts
agentNavigation: {
  ready: () =>
    ipcRenderer.invoke("paseo:agent-navigation:ready") as Promise<{
      serverId: string;
      agentId: string;
      focus?: boolean;
    } | null>,
  setActiveWorkspace: (
    selection: { serverId: string; workspaceId: string } | null,
  ) => ipcRenderer.invoke("paseo:window:setActiveWorkspace", selection) as Promise<void>,
  onResolveWorkspaceRequest: (
    handler: (
      requestId: string,
      target: { serverId: string; agentId: string },
    ) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      requestId: string,
      target: { serverId: string; agentId: string },
    ) => handler(requestId, target);
    ipcRenderer.on("paseo:agent-navigation:resolve-workspace-request", listener);
    return () =>
      ipcRenderer.removeListener("paseo:agent-navigation:resolve-workspace-request", listener);
  },
  replyResolveWorkspace: (
    requestId: string,
    response: { workspaceId: string | null },
  ) => ipcRenderer.invoke("paseo:agent-navigation:resolve-workspace-reply", requestId, response),
},
```

Matching optional methods are added to `DesktopAgentNavigationBridge` in
`packages/app/src/desktop/host.ts`.

#### `packages/app/src/desktop/agent-navigation.tsx`

```ts
export interface OpenAgentTabInBackgroundDeps {
  readCachedWorkspaceId: (target: { serverId: string; agentId: string }) => string | null;
  fetchWorkspaceId: (target: { serverId: string; agentId: string }) => Promise<string | null>;
  subscribeHostReady: (serverId: string, onChange: () => void) => () => void;
  waitForLayoutHydration: () => Promise<void>;
  openBackgroundTab: (input: { workspaceKey: string; agentId: string }) => void;
}

export function createBackgroundAgentTabOpener(deps: OpenAgentTabInBackgroundDeps): {
  open: (target: { serverId: string; agentId: string }) => void;
  dispose: () => void;
};
```

- Deduplicates concurrent background requests by `${serverId}:${agentId}`.
- Checks `readCachedWorkspaceId`; if null, calls `getHostRuntimeStore().prepareAgentRoute(serverId, agentId)`
  and `fetchWorkspaceId` (`client.fetchAgent({ agentId })`). If the host is currently offline or
  connecting (throws connection error or client not yet ready), subscribes via `subscribeHostReady`
  and retries when the host session becomes connected; if the daemon responds `null` (agent not
  found), drops the request cleanly without opening a tab.
- Once `workspaceId` resolves and `waitForLayoutHydration()` settles, calls
  `useWorkspaceLayoutStore.getState().openTab({ workspaceKey, target: { kind: "agent", agentId }, intent: "background", pin: true })`.
- Also syncs `useActiveWorkspaceSelection()` to `host.agentNavigation?.setActiveWorkspace` and
  responds to `onResolveWorkspaceRequest` using the same `readCachedWorkspaceId` + `fetchWorkspaceId`
  lookup.

#### Browser new-tab request contracts

`packages/desktop/src/features/browser-webviews/window-open.ts`:

```ts
export type BrowserWindowOpenDecision =
  | { kind: "deny" }
  | { kind: "popup" }
  | { kind: "workspace-tab"; url: string; background?: true };

export interface PendingBrowserWindowOpenRequest {
  url: string;
  background?: true;
}

export class PendingBrowserWindowOpenRequests {
  public add(webContentsId: number, url: string, options?: { background?: boolean }): void;
  public take(webContentsId: number): PendingBrowserWindowOpenRequest[];
  public delete(webContentsId: number): void;
}
```

`packages/app/src/desktop/browser/new-tab-requests/index.ts`:

```ts
export interface BrowserNewTabRequest {
  sourceBrowserId: string;
  url: string;
  background?: boolean;
}

export function resolveBrowserNewTabRequest(input: {
  payload: unknown;
  workspaceLayout: WorkspaceLayout | null | undefined;
}): BrowserNewTabRequest | null;

export function shouldFocusBrowserNewTabRequest(input: {
  request: BrowserNewTabRequest;
  workspaceLayout: WorkspaceLayout | null | undefined;
  isRouteFocused: boolean;
}): boolean;
// !input.request.background &&
// input.isRouteFocused &&
// getFocusedBrowserId(input.workspaceLayout) === input.request.sourceBrowserId
```

In `packages/app/src/screens/workspace/workspace-screen.tsx`, `handleOpenUrlInBrowserTab` becomes
`(request: BrowserNewTabRequest) => void`: resolves `sourcePane = findPaneContainingTab(...)` for
`request.sourceBrowserId`, uses `{ mode: "prefer", paneId: sourcePane.id }` (falling back to
`FOCUSED_PANE_PLACEMENT` when focusing or `AMBIENT_PLACEMENT` when background), and calls
`openWorkspaceTabFocused` when `shouldFocusBrowserNewTabRequest` is `true` vs
`openWorkspaceTabInBackground` when `false`.

#### Workspace layout actions & multi-window persistence merge

`packages/app/src/stores/workspace-layout-actions.ts`:

- In `resolvePlacementPane`:
  - When `input.placement.mode === "ambient"`: prefer `DEFAULT_PANE_ID` if visible, not
    `explorerSidebarPaneId`, and `supportsTarget`; else first visible non-explorer pane supporting
    `target` where `!isSoleNewTabPane(pane)`; else first visible non-explorer pane supporting
    `target`; else hidden explorer if supported.
  - When `input.placement.mode === "focused"`: retain existing `layout.focusedPaneId` preference.
- In `insertNewTabIntoPane`:
  - Add optional `allowNewTabReplace?: boolean` (defaults to `true` when `input.focus === true`,
    `false` when `input.focus === false` unless explicitly passed `allowNewTabReplace: true`).
  - Replace `isSoleNewTabPane(targetPane)` only when `(input.focus || input.allowNewTabReplace === true) && currentTab && input.target.kind !== "new_tab"`.
- In `reconcileWorkspaceTabs`:
  - Accept optional `allowInitialNewTabReplace?: boolean` on `WorkspaceTabReconcileState`.
  - Pass `allowNewTabReplace: Boolean(state.allowInitialNewTabReplace)` through
    `addMissingEntityTabs` → `openEntityTabWithoutFocusing` → `insertNewTabIntoPane`.
  - Only invoke trailing `focusTabInLayout({ layout: nextLayout, tabId: reconciledFocusedTabId })`
    when `originalFocusedTabId !== null` and the focused pane's tab changed due to entity-group
    deduplication (already true, verify `focusedPaneId === null` stays `null`).

`packages/app/src/stores/workspace-layout-store.ts`:

- Add non-persisted `reconciledWorkspaceKeys: Set<string>` to `WorkspaceLayoutStore` (cleared per
  key in `purgeWorkspace`).
- In `getOpenTabPlacement`: accept `intent: WorkspaceTabOpenIntent`; default `placement` when
  omitted is `intent === "background" ? AMBIENT_PLACEMENT : FOCUSED_PANE_PLACEMENT`, and when
  `resolvedPlacement.mode === "ambient"`, mirror the `DEFAULT_PANE_ID`-first pane selection.
- In `openTab`:
  - Mark `reconciledWorkspaceKeys` as containing `normalizedWorkspaceKey`.
  - Guard `...(input.intent === "background" ? {} : withoutFocusRestoration(state, normalizedWorkspaceKey))`.
- In `reconcileTabs`:
  - Compute `allowInitialNewTabReplace = !state.reconciledWorkspaceKeys.has(normalizedWorkspaceKey) && hasSingleBootstrapNewTabOrdinaryPane(currentLayout, explorerSidebarPaneId)`.
  - Once `snapshot.agentsHydrated && snapshot.terminalsHydrated` (or `nextLayout !== rawLayout`),
    add `normalizedWorkspaceKey` to `reconciledWorkspaceKeys`.

`packages/app/src/stores/workspace-layout-persist-storage.ts`:

```ts
export function createWorkspaceLayoutPersistStorage(
  backingStorage: StateStorage,
): PersistStorage<WorkspaceLayoutPersistedState>;
```

- Wraps `backingStorage` using `WorkspaceLayoutPersistedStateSchema` validation (`skipUnchanged: true`).
- Records `baselineByWorkspace` on `getItem` and after each committed `setItem`.
- Serializes `setItem` calls on a per-instance promise queue. For each changed projection, computes
  `changedWorkspaceKeys` (any workspace key whose serialized slice entry in `layoutByWorkspace`,
  `pinnedAgentIdsByWorkspace`, `splitSizesByWorkspace`, `explorerSidebarWidthByWorkspace`,
  `explorerPaneIdByWorkspace`, `sidePaneIdByWorkspace`, or `pullRequestTabAutoOpenedByWorkspace`
  differs from `baseline`) and `purgedWorkspaceKeys` (present in `baseline` across any slice, now
  absent across all slices). Reads the current envelope from `backingStorage.getItem(name)`: if valid
  and `version === WORKSPACE_LAYOUT_PERSIST_VERSION`, overlays `changedWorkspaceKeys` and deletes
  `purgedWorkspaceKeys` onto the stored state before writing; otherwise writes the current
  projection directly.

### Protected behavior and invariants

- **Preload sandbox (`packages/desktop/src/preload-sandbox.test.ts`):** `preload.ts` must never add
  a runtime import outside `"electron"`. Type-only imports are erased at compile time and allowed.
- **Expo Router topology (`docs/expo-router.md`):** Do not modify `packages/app/src/app` route
  ownership, startup `/` → `/h/[serverId]` split, `paseo:last-workspace-route-selection` restore, or
  `pendingOpenByWorkspace` explicit-open handoff. Keep `paseo://h/<serverId>/agent/<agentId>` free
  of workspace hints.
- **Stable scroll (`packages/app/src/agent-stream/`):** Do not alter `end-landing.ts`,
  `strategy-web.tsx`, `strategy-native.tsx`, or `deriveRouteBottomAnchorIntent`. Background tab
  opens never mount or activate the opened tab in the focused pane, so an active streaming chat's
  viewport stays stationary.
- **Agent attention & open-tab labels (`docs/agent-lifecycle.md`):** Background tab opens never emit
  `focusRequest` and therefore never clear unread `finished` / `error` attention prematurely;
  `useOpenAgentTabLabels` continues to stamp `paseo.open-agent-tab.<clientId>` for all open
  subagent tabs in `uiTabs` (including background-opened tabs) so parent archive still detaches
  rather than cascade-archiving them.
- **Untouched `intent: "reveal"` callers (`useAgentProfileStartShortcut`, `NotificationOpenRouter`, and Electron `notifications.ts`):**
  Profile start shortcuts (`packages/app/src/agent-profiles/use-start-shortcut.ts` → `handleImportedAgent`)
  and notification taps (`packages/desktop/src/features/notifications.ts` +
  `packages/app/src/notification-open/`) are not modified by `T1` and enter `WorkspaceLayoutStore.openTab`
  exclusively with `intent: "reveal"` (where `FOCUSED_PANE_PLACEMENT`, `focusRequest`, and
  `withoutFocusRestoration` remain unchanged). Their caller contracts are guarded by existing unit
  suites (`use-start-shortcut.test.tsx`, `notification-open/model.test.ts` in `U5`) without
  requiring OS notification-center E2E harnesses.

## 3. Tasks

Single end-to-end task **T1** (no split: protocol, CLI, Desktop main/preload, and app store/listeners
form one tightly coupled vertical contract with shared build artifacts `packages/protocol/dist` and
`packages/desktop/dist`, well within one worker's context). Default consolidated review runs once
after **T1** completes; no early design/implementation split review is needed.

### T1 — Implement non-focusing external/automated opens, multi-window workspace affinity, ambient/background tab focus guards, and per-workspace layout persistence

- **Dependencies:** None.
- **Owned files:**
  - `packages/protocol/src/agent-deep-link.ts`
  - `packages/protocol/src/agent-deep-link.test.ts`
  - `packages/cli/src/commands/agent/open.ts`
  - `packages/cli/src/commands/agent/open.test.ts` (new collocated unit test)
  - `packages/cli/src/cli-surface.test.ts`
  - `packages/cli/tests/42-agent-open.test.ts`
  - `packages/desktop/src/agent-navigation.ts`
  - `packages/desktop/src/agent-navigation.test.ts`
  - `packages/desktop/src/window/desktop-window-owner.ts`
  - `packages/desktop/src/window/desktop-window-owner.test.ts`
  - `packages/desktop/src/window/show-when-ready.ts`
  - `packages/desktop/src/window/show-when-ready.test.ts`
  - `packages/desktop/src/features/browser-webviews/window-open.ts`
  - `packages/desktop/src/features/browser-webviews/window-open.test.ts`
  - `packages/desktop/src/preload.ts`
  - `packages/desktop/src/main.ts`
  - `packages/desktop/e2e/support/runtime.ts` (mock bridge support for `agentNavigation` additions if needed)
  - `packages/desktop/e2e/browser-tabs.e2e.mjs`
  - `packages/desktop/e2e/tab-focus-multiwindow.electron.mjs` (new modular Electron regression wired into `browser-tabs.e2e.mjs`)
  - `packages/app/src/desktop/host.ts`
  - `packages/app/src/desktop/agent-navigation.tsx`
  - `packages/app/src/desktop/agent-navigation.test.tsx` (new collocated unit test)
  - `packages/app/src/desktop/browser/new-tab-requests/index.ts`
  - `packages/app/src/desktop/browser/new-tab-requests/index.test.ts`
  - `packages/app/src/screens/workspace/workspace-screen.tsx`
  - `packages/app/src/stores/workspace-layout-actions.ts`
  - `packages/app/src/stores/workspace-layout-store.ts`
  - `packages/app/src/stores/workspace-layout-persist-storage.ts` (new helper)
  - `packages/app/src/stores/workspace-layout-store.test.ts`
  - `packages/app/src/stores/workspace-layout-persistence.test.ts`
  - `packages/app/e2e/browser/tab-focus-preservation.spec.ts` (new Playwright browser spec)
  - `docs/development.md`
  - `docs/architecture.md`
- **Produced / consumed interfaces:** All exact signatures in §2.
- **Required build sequence during T1:**
  1. Edit `packages/protocol/src/agent-deep-link.ts` first, then run `npm run build:server` (rebuilds `@getpaseo/protocol`, `@getpaseo/client`, `@getpaseo/server`, and `@getpaseo/cli` declarations) before typechecking or testing `@getpaseo/cli`, `@getpaseo/desktop`, or `@getpaseo/app`.
  2. After `packages/desktop/src/**` edits, run `npm run build:main --workspace=@getpaseo/desktop` before running real-Electron E2E (`E2`).
- **Targeted unit command:**
  ```bash
  npx vitest run \
    packages/protocol/src/agent-deep-link.test.ts \
    packages/cli/src/commands/agent/open.test.ts \
    packages/cli/src/cli-surface.test.ts \
    packages/desktop/src/agent-navigation.test.ts \
    packages/desktop/src/window/desktop-window-owner.test.ts \
    packages/desktop/src/window/show-when-ready.test.ts \
    packages/desktop/src/features/browser-webviews/window-open.test.ts \
    packages/desktop/src/preload-sandbox.test.ts --bail=1 && \
  npx vitest run --dir packages/app \
    src/desktop/agent-navigation.test.tsx \
    src/desktop/browser/new-tab-requests/index.test.ts \
    src/stores/workspace-layout-store.test.ts \
    src/stores/workspace-layout-persistence.test.ts \
    src/workspace-tabs/agent-visibility.test.ts \
    src/stores/workspace-subagents-integration.test.ts \
    src/utils/agent-attention.test.ts \
    src/agent-profiles/use-start-shortcut.test.tsx \
    src/notification-open/model.test.ts --bail=1
  ```

## 4. Test and verification

### 4.1 Runner, project, and environment discovery

- **Host environment (verified):** Linux worktree `/home/sinkerine/.paseo/worktrees/28vpgp2p/wicked-racoon`,
  Node `v24.21.0`, npm `11.19.0`, ~21 GiB available RAM, ~222 GiB free disk, `DISPLAY=:0`,
  `WAYLAND_DISPLAY=wayland-1`, `node_modules` installed, `xvfb-run` available in the dev shell.
- **Unit runners:**
  - Root/server/protocol/cli/desktop Vitest: `npx vitest run <file> --bail=1`
  - App Vitest (`packages/app/vitest.config.ts` provides `@/` path aliases and `vitest.setup.ts`):
    `npx vitest run --dir packages/app <relative-file> --bail=1`
  - Standalone CLI integration script: `npx tsx packages/cli/tests/42-agent-open.test.ts` (spawns its
    own disposable test daemon on a dynamic port and cleans up).
- **Playwright browser runner (`packages/app/playwright.config.ts`):**
  - Project: `browser` (Desktop Chrome). `globalSetup` (`packages/app/e2e/support/global-setup.ts`)
    starts a warmed Metro server on a dynamic free port (`EXPO_UNSTABLE_HEADLESS=1`) and gives the
    worker an isolated daemon + `PASEO_HOME`.
- **Real-Electron runner (`packages/desktop/e2e/browser-tabs.e2e.mjs`):**
  - Invoked via `PASEO_DESKTOP_TAB_FOCUS_ONLY=1 npm run test:e2e:browser-tabs --workspace=@getpaseo/desktop`
    (runs `npm run build:main` first, reserves dynamic free ports for daemon, Metro, CDP, and Node
    inspector, uses isolated `PASEO_HOME` and `PASEO_ELECTRON_USER_DATA_DIR` under `os.tmpdir()`,
    and runs under `xvfb-run` on Linux).

### 4.2 Complete verification inventory and execution order

Never run `npm run test` across a workspace or the full Playwright suite locally. Never touch or
restart the shared main daemon on port `6767`. Serialize heavy steps (`B0` → `U1–U7` → `C1–C5` →
`E1` → `E3` → `E2`) so builds never race running Metro/Electron processes.

| ID        | Category                                                                   | Exact command                                                                                                                                                                                                                                                                                                                                    | Purpose / consumers covered                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B0**    | Generated workspace artifacts (mutating `dist/`)                           | `npm run build:server && npm run build:app-deps && npm run build:main --workspace=@getpaseo/desktop`                                                                                                                                                                                                                                             | Rebuilds `@getpaseo/protocol`, `@getpaseo/client`, `@getpaseo/highlight`, `@getpaseo/plugin`, `@getpaseo/relay`, `@getpaseo/server`, `@getpaseo/cli`, `@getpaseo/expo-two-way-audio`, and `@getpaseo/desktop` `dist/` before diagnosing types or launching CLI/Electron.                                                                                                                                                                                                                                 |
| **U1**    | Protocol unit                                                              | `npx vitest run packages/protocol/src/agent-deep-link.test.ts --bail=1`                                                                                                                                                                                                                                                                          | Deep-link round-trip for default and `?focus=0`, rejection of invalid queries/hashes.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **U2**    | CLI unit + isolated daemon integration                                     | `npx vitest run packages/cli/src/commands/agent/open.test.ts packages/cli/src/cli-surface.test.ts --bail=1 && npx tsx packages/cli/tests/42-agent-open.test.ts`                                                                                                                                                                                  | `--focus` / `--no-focus` flag parsing, `PASEO_AGENT_ID` caller detection (`resolveCallerAgentId` vs workspace terminal `PASEO_WORKSPACE_ID`), `--server` fallback, unknown-agent failure (`AGENT_NOT_FOUND`), emitted `paseo://...?focus=0` argv.                                                                                                                                                                                                                                                        |
| **U3**    | Desktop unit + preload sandbox                                             | `npx vitest run packages/desktop/src/agent-navigation.test.ts packages/desktop/src/window/desktop-window-owner.test.ts packages/desktop/src/window/show-when-ready.test.ts packages/desktop/src/preload-sandbox.test.ts --bail=1`                                                                                                                | Multi-window workspace-affinity selection, non-focusing delivery without `restore/show/focus`, fallback when no window matches workspace, resident zero-window `showInactive` creation, separate foreground/background inbox queues, preload sandbox allowlist.                                                                                                                                                                                                                                          |
| **U4**    | App desktop agent-navigation unit                                          | `npx vitest run --dir packages/app src/desktop/agent-navigation.test.tsx --bail=1`                                                                                                                                                                                                                                                               | Foreground `navigateToAgent({ ..., pin: true })` vs background `openTab(..., intent: "background", pin: true)`, offline/unhydrated host retry, missing-agent clean no-op, active-workspace reporting and workspace-resolution reply.                                                                                                                                                                                                                                                                     |
| **U5**    | App workspace layout, visibility, attention, and protected caller units    | `npx vitest run --dir packages/app src/stores/workspace-layout-store.test.ts src/workspace-tabs/navigation.test.ts src/workspace-tabs/agent-visibility.test.ts src/stores/workspace-subagents-integration.test.ts src/utils/agent-attention.test.ts src/agent-profiles/use-start-shortcut.test.tsx src/notification-open/model.test.ts --bail=1` | `AMBIENT_PLACEMENT` routing to `main`, `reconciledWorkspaceKeys` bootstrap-only `new_tab` replacement, split `new_tab` and user `+` (`new_tab`) preservation, pinned archived background open, `focusRestorationByWorkspace` preservation on `intent: "background"`, compact sheet non-dismissal, cross-workspace subagent visibility, attention clearing, and protected `intent: "reveal"` caller contracts.                                                                                            |
| **U6**    | Browser new-tab focus unit                                                 | `npx vitest run packages/desktop/src/features/browser-webviews/window-open.test.ts --bail=1 && npx vitest run --dir packages/app src/desktop/browser/new-tab-requests/index.test.ts --bail=1`                                                                                                                                                    | `disposition: "background-tab"` propagation, `shouldFocusBrowserNewTabRequest` gating on focused route + focused `sourceBrowserId`, popup/deny preservation.                                                                                                                                                                                                                                                                                                                                             |
| **U7**    | Multi-window layout persistence unit                                       | `npx vitest run --dir packages/app src/stores/workspace-layout-persistence.test.ts --bail=1`                                                                                                                                                                                                                                                     | Two independent `createWorkspaceLayoutStore` instances sharing one `StateStorage`: non-clobbering per-workspace merge across interleaved writes, `skipUnchanged` zero-write fast path, and `purgeWorkspace` key deletion.                                                                                                                                                                                                                                                                                |
| **K1–K4** | Consumer type/build checks                                                 | **K1:** `npm run typecheck --workspace=@getpaseo/protocol` · **K2:** `npm run typecheck --workspace=@getpaseo/cli` · **K3:** `npm run typecheck --workspace=@getpaseo/desktop` · **K4:** `npm run typecheck --workspace=@getpaseo/app` (all included in **C1**).                                                                                 | Verifies every package consuming `AgentDeepLinkTarget`, `DesktopHostBridge`, `BrowserWindowOpenDecision`, and `WorkspaceLayoutStore`.                                                                                                                                                                                                                                                                                                                                                                    |
| **C1**    | Root typecheck                                                             | `npm run typecheck`                                                                                                                                                                                                                                                                                                                              | Full workspace TypeScript verification after `B0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **C2**    | Root lint                                                                  | `npm run lint`                                                                                                                                                                                                                                                                                                                                   | Oxlint across all workspaces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **C3**    | Formatting                                                                 | `npm run format:files -- <changed-files>` then `npm run format:check`                                                                                                                                                                                                                                                                            | Required npm formatter check (`oxfmt`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **C4**    | Highlight closure                                                          | `npx vitest run packages/highlight/src/__tests__/dependency-closure.test.ts --bail=1`                                                                                                                                                                                                                                                            | Guards `app.asar` production dependency closure if any shared deps are touched.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **C5**    | Nix hash check                                                             | `bash scripts/update-nix.sh --check`                                                                                                                                                                                                                                                                                                             | Confirms `package-lock.json` / Nix dependency hashes remain in sync (no new dependencies planned).                                                                                                                                                                                                                                                                                                                                                                                                       |
| **E1**    | Isolated Playwright browser E2E (new spec)                                 | `npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/tab-focus-preservation.spec.ts --project=browser`                                                                                                                                                                                                                                     | Real browser + Metro + disposable daemon proving reconciliation (root agent, cross-workspace subagent, standalone terminal), split/side/`new_tab` preservation, parked focus restoration, desktop bridge `open-agent` (`focus: false` vs `focus: true`), browser `new-tab-request` (`background: true` and unfocused `sourceBrowserId`), two-page `localStorage` persistence merge, and explicit foreground opens (`+` → New agent, `+` → New terminal, Explorer file click, Subagents track row click). |
| **E2**    | Isolated real-Electron two-window E2E                                      | `PASEO_DESKTOP_TAB_FOCUS_ONLY=1 PASEO_DESKTOP_E2E_ARTIFACT_DIR="$PWD/artifacts/tab-focus/electron" npm run test:e2e:browser-tabs --workspace=@getpaseo/desktop`                                                                                                                                                                                  | Real two-window Electron main + preload + Metro + disposable daemon + real `paseo` CLI `agent open` (`second-instance` + cold zero-window launch), archived-agent background open, `paseo run --no-wait` reconciliation, real `<webview>` new-tab disposition, reload persistence, and `+` → New agent/terminal/browser foreground opens.                                                                                                                                                                |
| **E3**    | Existing Playwright regression specs for subagent & unread-attention focus | `npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/subagent-origin-pane.spec.ts e2e/browser/sidebar-workspace-mark-unread.spec.ts --project=browser`                                                                                                                                                                                     | Verifies existing subagent pane placement/focus and unread-workspace / deliberate-focus attention acknowledgement do not regress.                                                                                                                                                                                                                                                                                                                                                                        |

### 4.3 Representative executable capability probes

Before relying on E1 or E2 assertions, execute and record these capability checks so any harness or
display issue is distinguished from an unimplemented-feature baseline failure:

- **P1 (App Playwright + disposable daemon capability):**
  - **Real entry:** `npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/tab-focus-preservation.spec.ts --project=browser`
  - **Authoritative readiness:** `global-setup.ts` confirms Metro `/status` returns
    `packager-status:running` and warms bundle scripts; worker fixture confirms disposable daemon
    `/api/status` handshake and `seedMockAgentWorkspace` agent readiness.
  - **Representative action & observation:** Open two Playwright `Page`s in one `BrowserContext`
    against two seeded workspaces; assert visible `[data-testid="workspace-header-title"]`, tab chip
    counts, `document.activeElement` tag/testID, composer draft value, and `agent-chat-scroll`
    `scrollTop` sampled over animation frames.
  - **Baseline vs observation failure:** Missing Metro/Chromium/daemon handshake is an **observation
    inability** (infrastructure); visible workspaces where a background open steals active tab or
    clobbers `localStorage` is an **expected unimplemented-feature baseline failure**.
- **P2 (Two-window real-Electron + CDP + `second-instance` CLI handoff capability):**
  - **Real entry:** `PASEO_DESKTOP_TAB_FOCUS_ONLY=1 npm run test:e2e:browser-tabs --workspace=@getpaseo/desktop`
  - **Authoritative readiness:** Disposable daemon listening on reserved `daemonPort`; Metro ready
    on reserved `expoPort`; Electron launched under `xvfb-run -a` with isolated
    `PASEO_ELECTRON_USER_DATA_DIR` and `--remote-debugging-port=${cdpPort}` +
    `--inspect=127.0.0.1:${inspectorPort}`; `chromium.connectOverCDP` attaches to Window 1; calling
    `window.paseoDesktop.window.openNew({ pendingOpenProjectPath: workspace2Path })` produces a
    second CDP `Page` (Window 2), and Electron main inspector confirms
    `BrowserWindow.getAllWindows().length === 2` with distinct `webContents.id`s.
  - **Representative action & observation:** Place an executable wrapper at
    `${isolatedCliHome}/Applications/Paseo.AppImage` that invokes the checkout's Electron binary +
    `packages/desktop/dist/main.js` with `PASEO_ELECTRON_USER_DATA_DIR=${userData}` and `"$@"`. Run
    real `node packages/cli/dist/index.js agent open <agentId> --host 127.0.0.1:${daemonPort} --json`
    with `HOME=${isolatedCliHome}` (both with `PASEO_AGENT_ID=<callerId>` and without). Observe
    every 100 ms for 1,500 ms after CLI exit:
    1. Electron main `BrowserWindow.getFocusedWindow()?.webContents.id` via inspector CDP,
    2. Each window's `window.location.pathname`, visible workspace title, tab strip items, and
       active tab chip,
    3. Each window's `document.activeElement` composer identity, draft text, and `scrollTop`,
    4. Screenshots of both windows saved to `artifacts/tab-focus/electron/`.
  - **Baseline vs observation failure:** Failure to attach CDP to two `BrowserWindow`s or invoke
    `second-instance` is an **observation inability**; Window 2 switching pathname/tab or losing
    focus on `PASEO_AGENT_ID` `agent open` is the **expected baseline failure** on unpatched code.

### 4.4 Resource conflicts, repair ownership, and protected boundaries

- **Resource conflicts:** Never run `B0` (`tsc` / `npm run build:*`) concurrently with `E1`, `E2`,
  or `E3` (rewriting `dist/` mid-run breaks live daemon/CLI/Electron imports), and do not overlap
  `E1`/`E3` with `E2`. Note that `E1` and `E3` share the same app Playwright `browser` project and
  can be invoked either sequentially or in one single-worker command
  (`npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/tab-focus-preservation.spec.ts e2e/browser/subagent-origin-pane.spec.ts e2e/browser/sidebar-workspace-mark-unread.spec.ts --project=browser`).
  Never touch ports `6767`, `6768`, `8081`, `5037`, `5047`, `6793`, or `8093`; `E1`, `E2`, and `E3`
  allocate ephemeral `127.0.0.1:0` ports and isolated temp directories cleaned up in `finally`.
- **Evidence location:** Write screenshots, JSON reports, and logs only under git-ignored
  `artifacts/tab-focus/` inside this worktree.
- **Repair ownership & boundaries:** Implementation/repair worker owns only the files listed in §3
  `T1` inside `/home/sinkerine/.paseo/worktrees/28vpgp2p/wicked-racoon`. Never edit outside the
  worktree, never modify patches under `patches/`, never weaken `preload-sandbox.test.ts`, and never
  skip or mock away real IPC/daemon behavior in `E1`/`E2`. Automated repairs and deterministic
  verification reruns have no fixed attempt cap; code review remains capped at three rounds.
- **Platform matrix note:** Web (Playwright Chromium) and Desktop Linux (real Electron) are verified
  on this host; native Android/iOS and macOS/Windows Desktop window managers are not exercised on
  this Linux host (note explicitly in QA summary; shared `workspace-layout-store` logic is covered
  by unit tests across `compact`, `single-pane`, and `split-panes` modes).

## 5. E2E journey

E2E verification is required for this initial feature addition (including any repairs and reruns
during this workflow). Future pushes or deployments of existing features do not require E2E reruns,
though existing unit tests must still be run.

### Multi-window Electron & Browser journeys (`J1–J8`)

Setup: disposable daemon with Mock Load Test provider, two registered projects/workspaces
**Workspace A** (containing active root chat **Agent A1** with a multi-turn overflowing transcript,
plus orchestrator **Agent A-Orch**) and **Workspace B** (containing active root chat **Agent B1**).

1. **J1 — Two independent windows + automated `paseo agent open` (`PASEO_AGENT_ID` set):**
   - Open **Window 1** on **Workspace A** → select **Agent A1**, scroll up 250 px in the transcript,
     and type unsent draft `"Reviewing A1 notes"` in Window 1's composer.
   - Open **Window 2** (`Open in new window` on Project B) on **Workspace B** → select **Agent B1**,
     focus Window 2 (`BrowserWindow` focused), click Window 2's composer, and type unsent draft
     `"Typing in Window 2"`.
   - Create subagent **Agent A-Sub** (`parentAgentId = Agent A-Orch.id`) in **Workspace A** (same-workspace
     subagent, so it does not auto-open via reconciliation).
   - Run real CLI `paseo agent open <Agent A-Sub.id> --json` with `PASEO_AGENT_ID=<Agent A-Orch.id>`.
   - **Expected:** CLI exits `0` with `status: "opened"`. **Window 2** remains the OS-focused
     `BrowserWindow`, stays on **Workspace B** / **Agent B1**, keeps `document.activeElement` inside
     Window 2's composer, and preserves `"Typing in Window 2"`. **Window 1** stays on **Workspace A**
     with **Agent A1** as the active tab, preserves its scrolled-up `scrollTop` (within ≤1 px) and
     draft `"Reviewing A1 notes"`, and displays the new **Agent A-Sub** tab in Workspace A's tab
     strip with `paseo.open-agent-tab.<clientId> = "true"` stamped on the daemon.
2. **J2 — Human CLI `--no-focus` and repeated idempotent open:**
   - Without `PASEO_AGENT_ID`, run `paseo agent open <Agent A-Orch.id> --no-focus --json` and repeat
     `paseo agent open <Agent A-Sub.id> --no-focus --json`.
   - **Expected:** Neither Window 1 nor Window 2 changes OS focus, workspace route, active tab,
     composer focus, or draft; no duplicate tab is created.
3. **J3 — Unseen workspace, minimized window, archived agent, and zero-window / cold-launch background opens (`AC2`):**
   - **J3a (Unseen workspace & minimized window):** Create **Workspace C** with subagent **Agent C-Sub**.
     Minimize Window 1, keep Window 2 focused on **Workspace B**, and run
     `paseo agent open <Agent C-Sub.id> --no-focus --json`. Assert minimized Window 1 stays minimized
     (`isMinimized() === true`), Window 2 stays on **Workspace B**, and navigating Window 1 later to
     **Workspace C** shows **Agent C-Sub** already present in Workspace C's tab strip.
   - **J3b (Archived agent background open):** Create and archive **Agent A-Archived** in **Workspace A**
     (`client.archiveAgent`), keep Window 2 focused on **Workspace B**, and run
     `paseo agent open <Agent A-Archived.id> --no-focus --json`. Assert Window 2 stays on **Workspace B**
     untouched, and in **Workspace A** the **Agent A-Archived** tab remains pinned across
     `reconcileWorkspaceTabs` and displays the archived-agent callout when selected.
   - **J3c (Zero-window / cold-launch background open):** With `paseo:last-workspace-route-selection`
     saved as **Workspace B** (**Agent B1**) in `PASEO_ELECTRON_USER_DATA_DIR`, cleanly stop the
     Electron process while keeping the disposable daemon and Metro running (`windows.length === 0`),
     then invoke `paseo agent open <Agent A-ColdBg.id> --no-focus --json` so Desktop launches cold
     with `paseo://h/<serverId>/agent/<Agent A-ColdBg.id>?focus=0`. Attach CDP to the launched
     primary window and assert it restores **Workspace B** / **Agent B1** (never routing to
     `/h/<serverId>/agent/<Agent A-ColdBg.id>`) while persisting **Agent A-ColdBg** in **Workspace A**'s
     tab strip; reopen Window 2 on **Workspace B** and restore Window 1 on **Workspace A** for J4–J8.
4. **J4 — Explicit human `paseo agent open` (and `--focus` override) routes to the matching workspace window (`AC3`):**
   - With Window 1 on **Workspace A** (active tab **Agent A1**) and **Window 2** focused on
     **Workspace B** (typing `"Still in B1"`), run human CLI `paseo agent open <Agent A-Sub.id> --json`
     (no `PASEO_AGENT_ID`), and separately test
     `PASEO_AGENT_ID=<Agent A-Orch.id> paseo agent open <Agent A1.id> --focus --json`.
   - **Expected:** Electron focuses **Window 1** (because Window 1 already displays Workspace A) and
     activates the requested tab in Window 1; **Window 2** remains on **Workspace B** / **Agent B1**
     with its `"Still in B1"` draft intact instead of being navigated to Workspace A.
5. **J5 — Automatic appearance across root agents, cross-workspace subagents, standalone terminals, split `new_tab` panes, side panes, and streaming chats (`AC5`):**
   - In **Window 1** (**Workspace A**), split right (`Split right`) so the right pane holds the
     focused `new_tab` launcher while the left `main` pane holds **Agent A1**; also cover focusing a
     file tab in the side pane and an already-hydrated empty workspace showing `new_tab` (in `E1`).
     Meanwhile stream a live response in **Window 2** (**Workspace B**, **Agent B1**) resting at the
     end of an overflowing chat.
   - Trigger the shared client reconciliation boundary via: (a) real `paseo run --no-wait` /
     `client.createAgent` creating root agent **Agent A-Root2** in **Workspace A** and **Agent B-Root2**
     in **Workspace B**, (b) `client.createAgent` with `parentAgentId = Agent B1.id` and
     `workspaceId = Workspace A` creating cross-workspace subagent **Agent A-CrossSub** (`E1`), and
     (c) `client.createTerminal` creating a standalone terminal in **Workspace A**.
   - **Expected:** In **Window 1**, **Agent A-Root2**, **Agent A-CrossSub** (`E1`), and the
     standalone terminal appear as background tabs in `main` while the right split / side / `new_tab`
     pane keeps its active tab and focus unchanged. In **Window 2**, **Agent B-Root2** appears in
     Workspace B's tab strip without switching away from **Agent B1**, without blurring **Agent B1**'s
     composer, and without moving **Agent B1**'s streaming viewport (`scrollTop` drift ≤1 px).
6. **J6 — In-app browser `background-tab` and unfocused `<webview>` opens (`AC7`):**
   - With **Agent A1** active and composer focused in **Workspace A** (and a resident browser tab
     **Browser 1** open in the background of Workspace A), emit a guest `window.open` /
     `target="_blank"` from **Browser 1** (and test `disposition: "background-tab"` while **Browser 1**
     is focused).
   - **Expected:** The new browser tab opens in the background of **Browser 1**'s pane without
     switching away from **Agent A1** (or away from **Browser 1** on `background-tab`), while an
     ordinary foreground link open from a focused **Browser 1** tab still activates the new browser
     tab.
7. **J7 — Multi-window `workspace-layout-state` persistence across reload (`AC8`):**
   - Select **Agent A-Sub** in **Window 1** (**Workspace A**), then select **Agent B-Root2** in
     **Window 2** (**Workspace B**).
   - Reload **Window 1** and **Window 2**.
   - **Expected:** **Window 1** restores **Agent A-Sub** in **Workspace A**, and **Window 2**
     restores **Agent B-Root2** in **Workspace B**—neither window's write clobbered the other's
     workspace layout in `localStorage`.
8. **J8 — Explicit in-window foreground user opens, attention clearing, and parked focus restoration (`AC6`, `AC10`):**
   - In `E2` (**Window 1**), click `+` → **New agent** (submit a prompt and verify one-shot bottom
     landing + retarget), click `+` → **New terminal**, and click `+` → **New browser**; verify each
     immediately activates the created tab.
   - In `E1` (`tab-focus-preservation.spec.ts`), also click a file in the Explorer sidebar, click a
     subagent row in the Subagents track, open Command Center (`unfocusPane`) while triggering a
     background tab open then close Command Center (`restorePaneFocus`), and click an unread finished
     agent tab in the tab strip.
   - **Expected:** Every explicit foreground open activates and focuses its target tab immediately;
     closing Command Center restores focus to the pre-overlay pane/tab despite the background open;
     background-opened unread tabs keep their unread dot until clicked, and clicking the tab clears
     attention.
