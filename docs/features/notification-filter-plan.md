# Notification ownership by window filter

Status: approved by the user on 2026-11-14 ("approve. agree notification hard to e2e, I'll manual
QA"). See [Gate resolution](#gate-resolution). Revision 2 closes the orchestrator's
plan-inspection gaps: replay after reconnect or restart, a real reload assertion, the AC11
evidence, test categories, and consumer builds.

User request: "fix this to only allow a notification in the current window's filter to be owned by
the window". The window's filter is the sidebar display menu's **Host** and **Project** pages
(All projects or selected projects). The user's screenshot also showed **Show background**.

## 1. Goal

A window (an Electron window, browser tab or app instance, meaning one `DaemonClient` connection per
host) may own an agent or terminal attention notification only when that window's sidebar filter,
as currently applied, includes the notification's project. The daemon elects the owner. It
already elects exactly one in-app recipient per notification. This change limits that election to
windows whose filter includes the target, so a notification goes to a window that shows its project
instead of being lost or shown in a window that hides it.

### Premise correction

The brief assumed that each window decides on its own whether to notify, so a window-side check would
be enough. That is not how the code works. `computeNotificationPlan`
(`packages/server/src/server/agent-attention-policy.ts:42`) picks exactly one client per host. It
picks the present client with the most recent activity, and only that client receives
`shouldNotify: true` (`packages/server/src/server/websocket-server.ts:2947`, `:3059`). A
renderer-side suppression would make that elected window drop the notification while the matching
window never gets `shouldNotify`, and the notification would be lost. Filter eligibility therefore
has to enter the daemon's existing election. The plan adds no new election. It restricts the
candidates of the one that already exists. The orchestrator verified and accepted this. Windows
that overlap and both match all remain eligible, and the existing recency rule picks between them.

### Acceptance criteria

Terms: a window is _present_ when the daemon's presence rule holds (activity within
`PRESENCE_THRESHOLD_MS`). A window is _in scope_ for a target when its reported
`notificationScope` is absent, or when it lists the target's host-local `projectId`. The _target
project_ is the daemon's `workspaceRegistry` record `projectId` for the agent's current
`workspaceId`, or for the terminal's `workspaceId`.

E2E test names below refer to `packages/app/e2e/browser/notification-window-filter.spec.ts`
([section 5](#5-e2e-journey)). Unit test files are listed in [section 4](#4-test-and-verification).

- **AC1: excluded project, matching window elected.** Window A filters to project Alpha. Window B
  filters to project Beta and is the most recently active window. An Alpha agent finishes. A shows
  exactly one OS notification for that agent and B shows none. Before the fix, B shows it and A shows
  none.
  Evidence: E2E J1 step 3 (red before, green after). `websocket-server.notifications.test.ts`
  "elects the in-scope client over a more recent out-of-scope client", through
  `broadcastAgentAttention`. `agent-attention-policy.test.ts` in-scope winner case.
- **AC2: All projects and overlap.** A window whose Project page is **All projects**, or whose stored
  project filter resolves to empty because no pinned project is currently available, reports no
  scope and is in scope for every project on every host its host filter includes. When several
  present windows are in scope, the existing rule elects exactly one: greatest clamped activity,
  with the lower index on ties. No window gets a duplicate.
  Evidence: E2E J1 step 5 (B switches to All projects and becomes the single recipient), J2
  (overlap). Policy overlap and tie cases. `sidebar-notification-scope.test.ts` cases for All and
  for a stale key.
- **AC3: host filter.** A window whose Host page excludes host H is out of scope for every agent and
  terminal notification from H. To H it reports `notificationScope: { projectIds: [] }`. When no
  pinned host exists after the host registry loads, the sidebar falls back to all hosts, and the
  scope follows that same fallback.
  Evidence: E2E J3. `sidebar-notification-scope.test.ts` cases for an excluded host and for the
  fallback.
- **AC4: no matching present window.** When present windows exist but none is in scope, no window
  shows an OS notification and the daemon sends no push. The notification is dropped, as the request
  requires.
  Evidence: E2E J4, fenced by a later in-scope notification. Policy case for
  `{ inAppRecipientIndex: null, shouldPush: false }`. Server case asserting
  `pushNotificationSender.send` is not called.
- **AC5: presence, focus suppression and push are unchanged.** A present, app-visible window focused
  on the target still suppresses everything, even when its filter excludes the target. When no window
  is present, push follows `pushEligible` exactly as before, whatever the scopes. Error attention
  still never pushes. Native apps still never create a local OS notification (`sendOsNotification`
  returns `false` when `isNative`), and remote push generation is unchanged.
  Evidence: every existing `agent-attention-policy.test.ts` case passes unmodified (each existing
  state gets `notificationProjectIds: null`), plus new cases for "focused out-of-scope client
  suppresses" and "no present client pushes despite restrictive scopes". The existing
  `os-notifications.test.ts` passes.
- **AC6: filter change, no-op, stale keys, hydration, reconnect and restart.**
  - (a) Toggling a project or host filter, or choosing All projects or All hosts, changes the scope
    and sends one heartbeat immediately. The heartbeat bypasses the activity throttle and does not
    record user activity. Later notifications use the new scope.
    Evidence: E2E J1 step 5 (the filter change alone moves the election to B). Tracker cases
    "scope change sends one heartbeat with the scope" and "scope change does not move lastActivityAt".
  - (b) A change that leaves the scope deep-equal sends nothing.
    Evidence: tracker case "deep-equal scope sends nothing".
  - (c) Stored project keys that name no available project resolve to "all projects", the same way
    `resolveActiveProjectFilters` treats them for the sidebar.
    Evidence: `sidebar-notification-scope.test.ts` stale-key case.
  - (d) Under an active project filter, a host whose directory is not yet hydrated reports
    `projectIds: []`. When hydration lands, the scope is recomputed to that host's ids.
    Evidence: `sidebar-notification-scope.test.ts` partial-hydration case, which runs the selector
    on the snapshots before and after. E2E J1 step 4: after a reload, B's directory hydrates and a
    Beta finish must reach B, which fails if the scope does not recompute after hydration.
  - (e) Every heartbeat carries the current scope, including the first heartbeat after a reconnect.
    A daemon restart loses all client activity, and the scope is restored by the reconnect
    heartbeat that `useClientActivity` sends on `connected`.
    Evidence: E2E J6 "restores window scopes after the daemon restarts". It uses a real isolated
    daemon restart, after which the new process can know the scopes only from heartbeats sent after
    reconnect. Tracker case "scope set while disconnected is sent with the first connected
    heartbeat".
- **AC7: terminal notifications.** `terminal_attention_required` uses the same election. The target
  project is the terminal's `workspaceId` record. A terminal without a `workspaceId`, or with an
  unknown workspace, is in scope only for windows with no scope.
  Evidence: `websocket-server.terminal-notifications.test.ts` cases through
  `broadcastTerminalAttention` (in-scope winner, no-workspace terminal, unknown workspace).
- **AC8: agent target resolution.** The daemon uses the agent's current `workspaceId`, not the
  payload hint. A missing workspace record, or a registry read error (logged as a warning), leaves
  only windows with no scope in scope.
  Evidence: `websocket-server.notifications.test.ts` cases for a missing record and for a rejecting
  registry (asserting the `warn` call).
- **AC9: labels and Show background do not affect ownership.** A window keeps owning a project its
  Host and Project filters include, even when its label filter or **Show background** being off
  hides that project's workspaces.
  Evidence: E2E J5. In A, a label filter hides Alpha's workspace and **Show background** off hides
  a background workspace's project, yet A is still elected for both agents (red before, because B is
  more recent). Structurally, `selectHostNotificationScope` takes no label or background input
  ([Design](#module-boundaries-and-interfaces)).
- **AC10: each window uses its own filter, including across persistence and reload.** The scope reads
  the window's in-memory `useSidebarViewStore`. Another window writing the persisted `sidebar-view`
  key does not change a running window's scope. A reload adopts the persisted filter, and the scope
  follows what the sidebar applies after the reload.
  Evidence: E2E J1 steps 2–4. B opens after A has persisted Alpha, hydrates Alpha, then switches to
  Beta. A still shows Alpha only and is elected for Alpha. B is then reloaded, the test asserts that
  B's sidebar shows Beta only, B receives the Beta finish, and A receives the Alpha finish.
- **AC11: previously issued notifications and click routing are a protected invariant.**
  Notifications already shown stay where they are. A click still routes to the window that
  requested the notification. Nothing is retracted or rerouted. This is not proved by a new behavior
  test, because no code on that path changes. `packages/desktop/src/features/notifications.ts`
  has no unit tests today.
  Evidence: the command
  `git diff --exit-code refs/remotes/origin/main -- packages/desktop/src/features/notifications.ts packages/desktop/src/preload.ts packages/app/src/notification-open packages/app/src/utils/os-notifications.ts`
  exits 0. The existing targeted regressions `packages/app/src/notification-open/model.test.ts`
  and `packages/app/src/utils/os-notifications.test.ts` pass (commands in section 4).
- **AC12: protocol compatibility.** An old client sends no scope and stays in scope for everything,
  which is the old behavior. An old daemon strips the unknown heartbeat field and keeps the old
  election. The wire schema stays pure and optional.
  Evidence: `messages.client-heartbeat.test.ts` (parses with and without the field, rejects a
  non-array). `session.test.ts` "notification scope" cases (an absent scope stores `null`).

Named regressions that must stay green: `agent-attention-policy.test.ts`,
`websocket-server.notifications.test.ts`, `websocket-server.terminal-notifications.test.ts`,
`client-activity-tracker.test.ts`, `session.test.ts`, `selectors.test.ts`,
`sidebar-workspaces-view-model.test.ts`, `sidebar-project-filter.test.ts`,
`notification-open/model.test.ts` and `os-notifications.test.ts`. E2E `sidebar-project-filter.spec.ts`
does not need a rerun. The only sidebar code change is moving `resolveSidebarServerIds` without
changing behavior, and that move is covered by its pure test plus J3.

### Decisions

- **D1.** Ownership means the daemon's existing single in-app recipient election, restricted to
  in-scope present clients. Ruling: restrict the existing election and do not invent another one —
  windows do not notify independently, so a window-side check alone loses notifications — cost if
  wrong: if the user wanted every matching window to notify, the recipient loop would have to change
  to multi-recipient, which is a contained policy change.
- **D2.** The scope is the host filter plus the project filter, exactly as the sidebar applies them:
  the same host fallback, `resolveActiveProjectFilters`, and view keys from the same
  `buildWorkspaceStructureProjects` inputs. Ruling: one definition of "in the window's filter" — the
  sidebar already declares `resolveActiveProjectFilters` the only definition — cost if wrong: if the
  definitions diverge, the sidebar and notifications disagree. A pure parity test guards this.
- **D3.** Labels and **Show background** are excluded from ownership. Ruling: they are presentation
  filters over workspaces, not ownership of projects. Show background defaults to off, so including
  it would silently drop background-workspace notifications for every default single-window user.
  Labels need hydrated entries and catalog reconciliation the daemon does not mirror — cost if wrong:
  a follow-up adds `labels` or `includeBackground` to `ClientNotificationScope` and to the policy
  predicate.
- **D4.** The client reports host-local `projectIds` in `client_heartbeat.notificationScope`.
  Absent means all projects. An array is an allowlist, and an empty array means none. Ruling: the
  heartbeat already carries per-connection presence that the election reads, and it already replays
  on every reconnect. View keys are app-only constructs the daemon cannot interpret — cost if wrong:
  a dedicated RPC would also need reconnect replay.
- **D5.** When no present window is in scope, the daemon drops the notification. It does not fall
  back to an excluded window, and it does not push. Ruling: the user asked that excluded windows
  never own the notification. Presence means the user is at a client, so pushing to a phone would
  change native push behavior — cost if wrong: the user loses a notification they wanted
  somewhere. The fix would be a fallback branch in one function.
- **D6.** Focus suppression and push eligibility are still computed over all present clients,
  whatever their scope. Ruling: preserves native push and the "user is looking at it" rule — cost if
  wrong: none expected.
- **D7.** An unresolvable target project (no workspace record, no terminal workspace, or a registry
  error) is in scope only for clients with no scope. Ruling: a restrictive filter names projects,
  and an unknown project is not among them, while unrestricted windows keep today's behavior — cost
  if wrong: a narrow class of notifications skips filtered windows.
- **D8.** The renderer trusts `shouldNotify` and adds no local filter re-check in `session-context`.
  Ruling: one owner of the election, and the docs already say notification eligibility belongs to the
  daemon. A local re-check would lose notifications on old daemons and in the heartbeat race — cost
  if wrong: within milliseconds of a filter change, or with a pre-change daemon, one notification can
  appear in an excluded window.
- **D9.** Previously issued notifications are not retracted or rerouted, and click routing is
  unchanged (AC11 is a protected invariant). Ruling: they are already OS-owned, and the desktop
  main process does not know filters — cost if wrong: clicking an old notification opens an excluded
  project in its sender window.
- **D10.** Under an active project filter, a host whose directory is not hydrated in this window
  reports `projectIds: []`. Ruling: this matches what the sidebar shows, and the scope updates the
  moment hydration lands — cost if wrong: an early notification from a partly hydrated multi-host
  setup is dropped.
- **D11.** No capability gate and no feature flag. The behavior ships enabled. Ruling: per
  `CLAUDE.md`, and the optional field degrades to the old behavior — cost if wrong: none.
- **D12.** The E2E runs in the browser project only. There is no Electron or native E2E. Ruling: the
  change lives in the shared renderer JavaScript and the daemon, and the Electron main process and
  preload bridge are unchanged (AC11 diff check). Each Electron window is its own renderer and
  `DaemonClient` connection, which a browser page reproduces. Native runs the same cross-platform
  scope code and never shows a local notification — cost if wrong: an Electron-only regression in
  window-to-client mapping, or a native election change, surfaces only in manual QA. The user
  accepted this and owns manual QA of real Electron windows and native, using the checklist in
  [Manual QA](#manual-qa-user-owned).
- **D13.** Test categories follow `docs/testing.md`. Derivation, policy, tracker and protocol logic
  get pure `*.test.ts` tests through real data structures and existing ports (the `HeartbeatClient`
  adapter, real session-store snapshot objects, the existing websocket-server harness). React hook
  wiring and store transitions are proved only by the real browser E2E. No React-mounting hook test
  and no module mocks. Ruling: matches the repo's two categories — cost if wrong: none.
- **D14. Required docs.** Update `docs/notifications.md` with a short "Window eligibility" section:
  the daemon elects one present in-scope client, the scope is the host and project filter (labels and
  background excluded), what happens with no in-scope window, and that renderers must not re-check
  filters. Replace its stale #6875 sentence if it no longer applies. No other doc changes.
  `CLAUDE.md` is owned by the orchestrator; the browser `qex-e2e` declaration it added covers this
  spec.

### Gate resolution

The design agent originally judged human input unnecessary. The user then explicitly approved
Revision 2 on 2026-11-14 and took ownership of manual QA for real Electron and native notification
behavior.

Ruling: keep the browser E2E (J0–J6) as the required initial-feature E2E, and add user-owned
manual QA for Electron and native rather than replacing the E2E with it — the user's "hard to
e2e" agreed with the stated Electron and native limitation, the repository requires initial
feature E2E, and the browser spec exercises the real renderer and daemon — cost if wrong: the
browser E2E runs although the user meant to skip it, which costs one qex browser job and nothing
else. If the user says to skip it, the orchestrator drops section 5.

The overlap question was settled by the orchestrator's ruling, and D1 refines that ruling with a code fact the orchestrator has since accepted. The
remaining choices (D3, D5, D7, D10) are routine semantics, each recorded with its cost. Nothing is
destructive, security-sensitive, or outside the worktree.

## 2. Design

### Data flow

1. A sidebar filter changes in a window (`useSidebarViewStore`), or the host registry or session store
   project data changes.
2. In `SessionProviderInternal` (one per host), `useHostNotificationScope(serverId)` runs the pure
   `selectHostNotificationScope` over the current store values and returns
   `ClientNotificationScope | undefined`.
3. `useClientActivity({ ..., notificationScope })` calls `tracker.setNotificationScope(scope)`.
   On a change, the tracker sends a heartbeat immediately. Every heartbeat carries the current scope,
   including the one sent on each `connected` transition.
4. `DaemonClient.sendHeartbeat` puts `notificationScope` on `client_heartbeat`, and the daemon's
   `Session.handleClientHeartbeat` stores it per source as
   `ClientActivity.notificationProjectIds: ReadonlySet<string> | null`.
5. `broadcastAgentAttention` and `broadcastTerminalAttention` resolve `targetProjectId` through
   `workspaceRegistry.get`. `getClientActivityState` passes `notificationProjectIds` through, and
   `computeNotificationPlan` elects the most recent present client that is in scope.
6. The elected client receives `shouldNotify: true`, and `session-context.tsx` calls
   `sendOsNotification` unchanged.

### Module boundaries and interfaces

**Protocol**, `packages/protocol/src/messages.ts`:

```ts
export const ClientNotificationScopeSchema = z.object({
  // Host-local project ids this connection's window currently shows. Empty means none.
  projectIds: z.array(z.string()),
});
export type ClientNotificationScope = z.infer<typeof ClientNotificationScopeSchema>;

// Added to ClientHeartbeatMessageSchema. Absent means every project on this host.
notificationScope: ClientNotificationScopeSchema.optional(),
```

There is no `.default()` or `.transform()`. Absence is the canonical "all projects" value, which new
clients also send, so absence is not a compatibility shim and needs no `COMPAT` tag. Inbound
heartbeat parsing is server-side Zod, so no zod-aot regeneration is needed for this field.

**Client**, `packages/client/src/daemon-client.ts`: `sendHeartbeat(params)` gains
`notificationScope?: ClientNotificationScope` and passes it through only when it is defined.

**App**:

- `packages/app/src/hooks/sidebar-workspaces-view-model.ts`: move the inline server-id resolution
  out of `use-sidebar-workspaces-list.ts` into
  `export function resolveSidebarServerIds(input: { allServerIds: readonly string[]; hostFilters: readonly string[]; hostRegistryLoaded: boolean }): string[]`.
  `useSidebarWorkspacesList` calls it, with no behavior change.
- `packages/app/src/stores/session-store-hooks/selectors.ts`:
  `export interface ProjectViewPlacement { viewKey: string; hosts: Array<{ serverId: string; projectId: string }> }`
  and
  `export function selectProjectViewPlacements(state: SessionsSnapshot, serverIds: readonly string[]): ProjectViewPlacement[]`.
  It reads only each session's `projects` map and calls `buildWorkspaceStructureProjects` with empty
  workspaces, so view-key allocation is identical to the sidebar's. In `index.ts`, the supported
  hook is `useProjectViewPlacements(serverIds: string[]): ProjectViewPlacement[]`, using deep
  equality.
- New `packages/app/src/components/sidebar/sidebar-notification-scope.ts`, pure:

  ```ts
  export function deriveHostNotificationScope(input: {
    serverId: string;
    sidebarServerIds: readonly string[]; // resolveSidebarServerIds output
    projects: readonly ProjectViewPlacement[]; // placements of the hydrated sidebar hosts
    projectFilters: readonly string[]; // raw store value
  }): ClientNotificationScope | undefined;

  // Pure composition over plain store snapshots. Takes no label or background input.
  export function selectHostNotificationScope(input: {
    serverId: string;
    allServerIds: readonly string[];
    hostRegistryLoaded: boolean;
    hostFilters: readonly string[];
    projectFilters: readonly string[];
    sessions: SessionsSnapshot;
  }): ClientNotificationScope | undefined;
  ```

  `selectHostNotificationScope` composes four steps. `resolveSidebarServerIds` gives
  `sidebarServerIds`. `selectWorkspaceDirectoryServerIds(sessions, sidebarServerIds)` gives the
  hydrated ids. `selectProjectViewPlacements(sessions, hydratedIds)` gives `projects`.
  `deriveHostNotificationScope` turns those into the scope. That last function returns
  `{ projectIds: [] }` when `serverId` is not in `sidebarServerIds`. It returns `undefined` when
  `resolveActiveProjectFilters(projectFilters, viewKeys)` is empty. Otherwise it returns the sorted,
  unique `projectId`s of the included projects' placements on `serverId`.

- New `packages/app/src/hooks/use-host-notification-scope.ts`:
  `export function useHostNotificationScope(serverId: string): ClientNotificationScope | undefined`.
  This is thin wiring with no logic of its own. It reads `useHosts`, `useHostRegistryLoaded`,
  `useSidebarViewStore` `hostFilters` and `projectFilters`, and the session store, and keeps the
  previous object while the result is deep-equal. The session store is read only through supported
  hooks: `useWorkspaceDirectoryServerIds` and `useProjectViewPlacements`, with the same composition
  as `selectHostNotificationScope`. To keep one definition, the hook calls
  `deriveHostNotificationScope` and `resolveSidebarServerIds`. It acquires no directory demand.
- `packages/app/src/hooks/client-activity-tracker.ts`:
  - `HeartbeatPayload.notificationScope?: ClientNotificationScope`.
  - `ClientActivityTrackerInput.initialNotificationScope?: ClientNotificationScope`.
  - The new method `setNotificationScope(scope: ClientNotificationScope | undefined): void` is a
    no-op when the projectIds are deep-equal. On a change it stores the scope and calls
    `sendHeartbeat()` without `recordUserActivity()`. While disconnected, `sendHeartbeat` sends
    nothing, as it does today.
  - `sendHeartbeat` includes the current `notificationScope` only when it is defined.
- `packages/app/src/hooks/use-client-activity.ts`: the `ClientActivityOptions.notificationScope?: ClientNotificationScope`
  option, plus an effect `tracker.setNotificationScope(notificationScope)`. The existing `connected`
  handler already calls `tracker.sendHeartbeat()`, which then carries the scope.
- `packages/app/src/contexts/session-context.tsx`:
  `const notificationScope = useHostNotificationScope(serverId)`, passed to `useClientActivity`.
  The notification handlers do not change.

**Server**:

- `packages/server/src/server/session.ts`: `ClientActivity.notificationProjectIds: ReadonlySet<string> | null`.
  `handleClientHeartbeat` accepts `notificationScope?: { projectIds: string[] }` and stores
  `new Set(projectIds)` or `null`.
- `packages/server/src/server/agent-attention-policy.ts`:
  - `ClientPresenceState.notificationProjectIds: ReadonlySet<string> | null`.
  - `ComputeNotificationPlanInput.targetProjectId: string | null`.
  - Exported `isClientInNotificationScope(state: ClientPresenceState, targetProjectId: string | null): boolean`.
    It returns `ids === null || (targetProjectId !== null && ids.has(targetProjectId))`.
  - Loop: skip non-present clients. A visible client focused on the target returns a suppression.
    Mark `anyPresent`. If the client is in scope, track the most recent one with the same
    tie-break. Result: the in-scope winner, then `{ null, false }` when `anyPresent`, otherwise
    `{ null, pushEligible }`.
- `packages/server/src/server/websocket-server.ts`: `getClientActivityState` maps the new field (`null`
  without activity). A private `resolveNotificationProjectId(workspaceId: string | undefined): Promise<string | null>`
  wraps `workspaceRegistry.get`, and on rejection it logs `warn` and returns `null`. Both broadcasts
  pass `targetProjectId`. The push payloads and the per-client message construction do not change.

### Error handling and conventions

- A registry failure becomes `null` (D7) and never throws out of a broadcast.
- Wire schemas stay pure (`docs/protocol-validation.md`).
- Follow `docs/coding-standards.md`: derived state is not stored, the store is read through the
  supported session-store hooks, there is no `useUnistyles`, and there are no platform gates (the
  scope is cross-platform).
- Terminology: use "Host" and "Project" filter, matching the UI labels in `docs/glossary.md`.

## 3. Tasks

### T1: Filter-scoped notification election, end to end

One task, because the producer (app scope), the wire field and the consumer (daemon election) form
one contract that has to change and be tested together. No split earns its cost.

- **Owned files**:
  - `packages/protocol/src/messages.ts` and new `packages/protocol/src/messages.client-heartbeat.test.ts`
  - `packages/client/src/daemon-client.ts`
  - `packages/app/src/hooks/sidebar-workspaces-view-model.ts` and its existing `.test.ts`, plus
    `use-sidebar-workspaces-list.ts`
  - `packages/app/src/stores/session-store-hooks/{selectors.ts,index.ts,selectors.test.ts}`
  - New `packages/app/src/components/sidebar/sidebar-notification-scope.ts` and `.test.ts`
  - New `packages/app/src/hooks/use-host-notification-scope.ts` (no unit test; E2E covers it)
  - `packages/app/src/hooks/client-activity-tracker.ts` and `.test.ts`, plus
    `use-client-activity.ts`
  - `packages/app/src/contexts/session-context.tsx`
  - `packages/server/src/server/{session.ts,agent-attention-policy.ts,websocket-server.ts}` and
    `agent-attention-policy.test.ts`, `websocket-server.notifications.test.ts`,
    `websocket-server.terminal-notifications.test.ts`, `session.test.ts`
  - New E2E `packages/app/e2e/browser/notification-window-filter.spec.ts` and helper
    `packages/app/e2e/support/helpers/notification-recorder.ts`
  - `docs/notifications.md`
- **Produces**: `ClientNotificationScope`, `client_heartbeat.notificationScope`,
  `selectHostNotificationScope` and `useHostNotificationScope`,
  `computeNotificationPlan({ targetProjectId })`.
- **Consumes**: `resolveActiveProjectFilters`, `buildWorkspaceStructureProjects`,
  `selectWorkspaceDirectoryServerIds`, host runtime hooks, `workspaceRegistry.get`, and the E2E
  helpers `seedWorkspace`, `createMockIdleAgent`, `startIsolatedHostDaemon`,
  `seedSavedSettingsHosts`, `addOfflineHostAndReload` and the sidebar filter helpers.
- **Order within T1**:
  1. The protocol field, then the client.
  2. The server policy, session and websocket-server, each with its pure tests red then green.
  3. The app pure selector and tracker, red then green.
  4. App wiring.
  5. The E2E: capability smoke first, then J1–J6 red against the unchanged baseline, then green.
  6. Builds and static checks, then docs.
- **Dependencies**: none external. No installs.
- **File and build conflicts**: the orchestrator owns `CLAUDE.md`, which T1 does not touch. Builds
  write `dist/` for protocol, relay, client, highlight, plugin, server and cli, plus the app web
  export. Never overlap a build with an E2E run or another build in this worktree. Run them
  sequentially.

## 4. Test and verification

All commands run from `WT=/home/sinkerine/.paseo/worktrees/28vpgp2p/pleasant-sloth` through qex, one
at a time.

### Unit (pure `*.test.ts`, red before and green after, one file per job)

```bash
agent-job run small --cwd $WT/packages/protocol -- npx vitest run src/messages.client-heartbeat.test.ts --bail=1 --maxWorkers=1
agent-job run small --cwd $WT/packages/server   -- npx vitest run src/server/agent-attention-policy.test.ts --bail=1 --maxWorkers=1
agent-job run small --cwd $WT/packages/server   -- npx vitest run src/server/websocket-server.notifications.test.ts --bail=1 --maxWorkers=1
agent-job run small --cwd $WT/packages/server   -- npx vitest run src/server/websocket-server.terminal-notifications.test.ts --bail=1 --maxWorkers=1
agent-job run small --cwd $WT/packages/server   -- npx vitest run src/server/session.test.ts -t "notification scope" --bail=1 --maxWorkers=1
agent-job run small --cwd $WT/packages/app -- npx vitest run --project unit src/components/sidebar/sidebar-notification-scope.test.ts --bail=1 --maxWorkers=1
agent-job run small --cwd $WT/packages/app -- npx vitest run --project unit src/stores/session-store-hooks/selectors.test.ts --bail=1 --maxWorkers=1
agent-job run small --cwd $WT/packages/app -- npx vitest run --project unit src/hooks/client-activity-tracker.test.ts --bail=1 --maxWorkers=1
agent-job run small --cwd $WT/packages/app -- npx vitest run --project unit src/hooks/sidebar-workspaces-view-model.test.ts --bail=1 --maxWorkers=1
# Protected-invariant regressions (AC11, AC5)
agent-job run small --cwd $WT/packages/app -- npx vitest run --project unit src/notification-open/model.test.ts --bail=1 --maxWorkers=1
agent-job run small --cwd $WT/packages/app -- npx vitest run --project unit src/utils/os-notifications.test.ts --bail=1 --maxWorkers=1
git -C $WT diff --exit-code refs/remotes/origin/main -- packages/desktop/src/features/notifications.ts packages/desktop/src/preload.ts packages/app/src/notification-open packages/app/src/utils/os-notifications.ts
```

Before implementing, check discovery: `packages/app/vitest.config.ts` defines the `unit` project
over `src/**/*.{test,spec}.{ts,tsx}` (excluding `*.browser.*`), which picks up the new app file. The server and
protocol packages use their default vitest configs.

What each file proves:

- `messages.client-heartbeat.test.ts`: the schema accepts no scope, an empty list and a list of
  ids, and rejects a non-array (AC12).
- `agent-attention-policy.test.ts`:
  - the in-scope winner beats a more recent out-of-scope client (AC1)
  - overlap and ties (AC2)
  - present clients but none in scope gives no push (AC4)
  - a focused out-of-scope client suppresses, and no present client pushes despite scopes (AC5)
  - `targetProjectId: null` admits only unrestricted clients (AC7, AC8)
  - existing cases stay unchanged (AC5)
- `websocket-server.notifications.test.ts` and `websocket-server.terminal-notifications.test.ts`:
  real `broadcastAgentAttention` and `broadcastTerminalAttention` with two connected clients whose
  `getClientActivity` carries `notificationProjectIds`, and a stub `WorkspaceRegistry` port that
  maps the workspace to a project. They assert which socket gets `shouldNotify: true` and whether
  `pushNotificationSender.send` is called. They cover a missing record, a rejecting registry (with
  the `warn`), and a terminal with no workspace (AC1, AC4, AC7, AC8).
- `session.test.ts` "notification scope": a `client_heartbeat` with and without the field stores a
  `Set` or `null` in `getClientActivity()` (AC12).
- `sidebar-notification-scope.test.ts`: `selectHostNotificationScope` over real
  `SessionsSnapshot` objects built the way `selectors.test.ts` builds them.
  - All projects gives `undefined`. A pinned project gives that host's ids. A shared `projectKey`
    on two hosts gives each host its own `projectId` (AC1, AC2).
  - An excluded host gives `[]`. A pinned host missing after the registry loads falls back (AC3).
  - A stale key gives `undefined` (AC6c).
  - Partial hydration gives `[]`, and the after-hydration snapshot gives the ids (AC6d).
  - D2 parity: for a fixture with shared keys and a placement collision, the view-key set from
    `selectProjectViewPlacements` equals that of
    `buildSidebarWorkspacePlacementModel({ projects: selectWorkspaceStructureProjects(...) }).projects`,
    which is the sidebar's `allProjects` source.
- `selectors.test.ts`: `selectProjectViewPlacements` is ordered and stable, returns the same
  reference when the project maps are unchanged, and ignores workspace churn.
- `client-activity-tracker.test.ts`, through the existing `HeartbeatClient` port (AC6a, b, e):
  - a scope change sends exactly one heartbeat with the scope, bypasses the throttle, and does not
    move `lastActivityAt`
  - a deep-equal scope sends nothing
  - a scope set while disconnected is sent with the first heartbeat after `isConnected` becomes
    true
  - interval heartbeats carry the scope
- `sidebar-workspaces-view-model.test.ts`: `resolveSidebarServerIds` covers none pinned, pinned
  subset, and pinned-all-missing after the registry loads (AC3).

### Builds and static checks (after the unit tests pass, in this order)

Consuming graph for the changed interfaces:

- `@getpaseo/protocol` (heartbeat schema and type) is consumed by client, server, cli and app.
- `@getpaseo/client` (`sendHeartbeat`) is consumed by app and cli.
- `@getpaseo/server` (internal session and policy) is consumed by cli and desktop, which bundles the
  server.
- The app is the end consumer of the client.

Desktop imports no changed module (it uses `@getpaseo/protocol/{agent-deep-link,app-config,browser-automation/rpc-schemas,ssh-transport}`
and `@getpaseo/server/{daemon-control,process}`), but its main build compiles against the rebuilt
server declarations.

```bash
agent-job run heavy  --cwd $WT -- npm run build:server        # protocol, relay, client, highlight, plugin, server, cli builds
agent-job run medium --cwd $WT -- npm run build:main --workspace=@getpaseo/desktop   # desktop main tsc against fresh server/protocol dist
agent-job run heavy  --cwd $WT -- npm run build:web --workspace=@getpaseo/app        # build:app-deps + expo web export of the app
agent-job run medium --cwd $WT -- npm run typecheck            # all workspaces, after builds so declarations are current
agent-job run medium --cwd $WT -- npm run lint
agent-job run small  --cwd $WT -- npm run format
agent-job run small  --cwd $WT -- npm run format:check
```

Do not run the full desktop `build`: electron-builder packaging is out of scope because main-process
code is unchanged. There is no native build, because no native module changes (D12). Do not run
any workspace-wide `npm run test`. CI runs the full suites.

### Hardest representative capability check (run before implementation)

Two Playwright pages in one browser context, each a separate app renderer with its own
`DaemonClient`, receive daemon-elected attention notifications. The recorder captures the browser
`Notification` constructor.

- Entry: `gotoAppShell` in page A, then page B.
- Readiness: both pages show seeded workspace rows.
- Action: a mock agent turn finishes through `client.sendAgentMessage`, and the test waits for
  idle with `waitForAgentUpsert`.
- Observation: `window.__paseoNotifications` in each page.
- Precision: exactly one record across both pages, carrying the agent id.
- Evidence: the Playwright trace, the attached recorder JSON and screenshots in ignored `artifacts/`.

This is the spec's first test, J0. It must pass on the unchanged baseline. If J0 fails on the
baseline, the harness cannot observe, and the problem must be fixed before any red result counts.
A baseline failure of J1–J6 at their "A received" or "B received" assertion while J0 passes is the
expected assertion red.

The recorder is an observation shim at the OS boundary: an `addInitScript` that replaces
`window.Notification` with a class whose `permission` is `"granted"` and which records `{ title,
body, data }`. It implements no Paseo logic. Scope derivation, heartbeat, election and
`sendOsNotification` all run for real.

### Protected boundaries

Never touch the daemon on port 6767, `~/.paseo`, or the user's desktop app or state. Use only the
harness's disposable daemon homes, ports and workspaces. J6's daemon is a
`startIsolatedHostDaemon` instance with its own home and port. Run no full suites. Every E2E
execution, including J0 and retries, goes through `agent-job run --e2e browser` (the declaration in
root `CLAUDE.md`/`AGENTS.md`: 4 CPU, 16 GiB, 30 min). The spec runs with one worker, and the claim
covers Metro, Chromium, the worker daemon, J6's isolated daemon and teardown. No new declaration is
needed.

## 5. E2E journey

Spec: `packages/app/e2e/browser/notification-window-filter.spec.ts`. Every test opens page A and then
page B in one context, installs the recorder, seeds through `seedWorkspace` and
`createMockIdleAgent` (cleanup in `finally`), and finishes agents with `sendAgentMessage` followed
by `waitForAgentUpsert` to idle. Notification counts are asserted per agent id per page.

- **J0, smoke.** Alpha and Beta are seeded, and Alpha has an agent. A and B are both on All projects.
  An Alpha finish produces exactly one record across A and B.
- **J1, routes to the window whose project filter includes the agent** (AC1, AC2, AC6a/d, AC10).
  Alpha and Beta each have an agent.
  1. A pins Alpha. Expect Alpha visible and Beta hidden in A.
  2. Open B. Expect B to show Alpha only (it hydrated the persisted filter). B selects All projects,
     then pins Beta, and expects Beta only. Expect A still to show Alpha only. From here on, do not
     touch A.
  3. An Alpha finish: A has one record, B has none.
  4. Reload B. Assert B's sidebar shows Beta only after the reload. A Beta finish: B has one, and
     this fails if B's scope did not recompute after hydration. An Alpha finish: A has two, and B
     still has none for Alpha.
  5. In B, select All projects. An Alpha finish: B has one, and A stays at two.
- **J2, keeps overlapping matching windows on the existing recency rule** (AC2). A pins Alpha. B
  stays on All projects and is the most recent window. An Alpha finish: one record in B and none in
  A.
- **J3, excludes a window whose host filter omits the host** (AC3). Add an offline secondary host
  with `addOfflineHostAndReload` in A. A uses all hosts. B pins only the secondary host and is the
  most recent window. An Alpha finish on the primary host: one record in A and none in B.
- **J4, drops a notification no present window's filter includes** (AC4). Add a project Gamma with
  an agent. A pins Alpha and B pins Beta. Finish the Gamma agent, then finish the Alpha agent as a
  fence. Expect exactly one record overall, in A for Alpha, and none for Gamma in either page.
- **J5, presentation filters do not remove ownership** (AC9).
  - Setup: assign the label "Focus" to Beta's workspace with `client.setWorkspaceLabel`. Seed a
    background workspace, BgProj (`seedWorkspace({ background: true })`), with a non-background
    mock agent.
  - A pins the projects Alpha and BgProj, selects the label "Focus", and leaves **Show background**
    off. Expect A to show neither Alpha's workspace nor BgProj's.
  - Open B. B clears the label filter, pins Beta, and is the most recent window.
  - An Alpha finish gives one record in A, and a BgProj finish gives one record in A. B has none for
    either.
- **J6, restores window scopes after the daemon restarts** (AC6e). The spec has a file-local fixture
  modeled on `background-reconnect.spec.ts`. It starts an isolated host with
  `startIsolatedHostDaemon("notification-window-filter")`, points both pages at it with
  `seedSavedSettingsHosts`, and seeds Alpha and Beta with `port: daemon.port`.
  1. A pins Alpha, then B opens, pins Beta and is the most recent window.
  2. Call `daemon.restart()`. Wait until both pages show the seeded workspace rows again and the host
     is online (the same readiness `background-reconnect.spec.ts` uses).
  3. Create a fresh mock agent in the persisted Alpha workspace through a new seed client on
     `daemon.port`, and finish it.
  4. Expect one record in A and none in B. The restarted daemon has no client state from before
     the restart, so only the reconnect heartbeats can have supplied A's and B's scopes.

Run (sequential, one worker, under qex):

```bash
agent-job run --e2e browser --cwd /home/sinkerine/.paseo/worktrees/28vpgp2p/pleasant-sloth -- \
  npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/notification-window-filter.spec.ts --workers=1
```

Use the [development shell](../development.md#nix-and-direnv) for Chromium dependencies. Record red
before the change and green after it:

- On the unchanged implementation, J0 passes and J1, J3, J4, J5 and J6 fail at their first
  ownership assertion.
- J2 may pass on the baseline.

Evidence goes in the worktree's ignored `artifacts/notification-filter/`: the Playwright report,
traces, recorder JSON per page per test, screenshots of both sidebars at each assertion, and the qex
job ids. Teardown is owned by the harness. Every seed cleanup runs in `finally`, and the fixture
fails on a leaked project. J6's isolated daemon closes in its fixture `finally`. Pages and the
context close with the test. The worker daemon and Metro stop at global teardown, inside the qex
reservation.

Timing notes for implementers:

- Keep each test well under `PRESENCE_THRESHOLD_MS` (180 s) from A's last activity.
- Do not call `bringToFront` on A after B opens, because a focus or visibility change records
  activity in A.
- Do not use sleeps. Recency comes from ordering: B's tracker is created, or recreated on reload,
  after A's last action.
- Before each finish, wait for the sidebar state that the scope derives from. The agent turn
  duration covers delivery of the scope heartbeat, because the seed client is a separate
  connection.

### Manual QA (user-owned)

The user runs this after implementation, against a dev build with disposable state, never on the
6767 daemon:

1. Desktop, two Electron windows. Window A is filtered to project Alpha and window B to Beta.
   Interact last with B. An Alpha agent finishes: the OS notification comes from A, and clicking it
   focuses A and opens the agent. Repeat with B on All projects, and B owns it.
2. Desktop host filter. B is pinned to another host, and a primary-host agent finishes: A owns it.
3. Both windows exclude the project: no notification anywhere, and no phone push while desktop is
   present.
4. Native: the phone app is the only present client, on All projects, and nothing local appears,
   as before. With no client present, the push arrives as before.

The browser E2E above is required only for this initial feature run. Later pushes and deployments do not rerun
it, but the unit tests above still run.
