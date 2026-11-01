# Shared agent profile shortcuts across hosts — plan

Status: **approved by the user (2026-10-31)**
Branch: `share-agent-profile-shortcuts-remote-hosts` (base `b2541b34c`, `origin/main`)

User decisions:

- Match by profile name.
- One merged settings section.
- On a legacy migration conflict, the first migrated binding wins.
- Show a toast when the active host has no profile of that name.

## Problem

Profile shortcuts (added in `653f03f4c`) are stored client-side in the `@paseo:keyboard-shortcut-overrides` AsyncStorage map under `JSON.stringify([action, serverId, profileId])` (`packages/app/src/agent-profiles/shortcuts.ts:5`). Profile IDs are random per host (`internal/profile-id.ts`), so a binding made for kazuki's `Claude` profile never matches sachi's `Claude`. Settings shows one section per host, and sachi's rows read "Not set".

A second defect follows from the same identity: the matcher takes the first binding whose chord completes (`keyboard-shortcuts.ts` `resolveInitialChordStep`) and the handlers then reject a non-matching `serverId`. Binding the same combo to profiles on two hosts lets only one of them ever fire.

## Goal and acceptance criteria

Goal: a profile shortcut binds a profile **name**. It fires against the same-named profile on whichever host owns the active composer or workspace. Nothing about a profile's provider config moves between hosts — only the client-local key map changes.

- **AC1 — inherit.** Bind `Select profile: Claude` while kazuki is the only host. Add sachi, which has its own `Claude` with a different ID. The binding fires on sachi with no further setup.
- **AC2 — correct target, select.** With a composer on sachi focused, the select chord applies sachi's `Claude` (sachi's profile ID) to that composer. On kazuki it applies kazuki's.
- **AC3 — correct target, start.** On a focused sachi workspace, the start chord creates the agent on sachi, in that workspace, from sachi's profile config. No RPC goes to kazuki.
- **AC4 — missing profile.** Sachi's profiles are loaded and it has no profile with that name. The select chord with a sachi composer focused, or the start chord on a focused sachi workspace, shows a warning toast "No agent profile named Pi Opus on sachi". No agent is created and the composer is unchanged. The toast uses the display name from any connected host's cached profiles, or the normalized key if none has it. While sachi's profiles are still loading, the chord does nothing and shows no toast.
- **AC5 — one merged section.** Settings › Shortcuts has a single `Agent profiles` section. It lists each distinct profile name once, as a select row and a start row. Each row's secondary line names the connected hosts that have that profile (`kazuki, sachi`). The section header's info tip says shortcuts apply to every host's profile with that name. Binding, clearing and `Reset all` act once for all hosts.
- **AC6 — legacy preservation.** An existing `[action, serverId, profileId]` override becomes a shared override for that profile's name once that host's profile list loads. The legacy key is then removed. Overrides for other hosts, for unloaded hosts, and non-profile overrides are untouched.
- **AC7 — legacy conflict.** First migrated wins. If a shared override for that name already exists, whether set by the user or by an earlier host's migration, it stays and the legacy key is dropped. Within one host, the first profile in that host's list order wins.
- **AC8 — name matching.** Matching ignores case, leading/trailing whitespace and repeated inner whitespace (`" Pi  Opus"` ≡ `"pi opus"`). Profiles with a blank name get no shortcut row and can't be targeted.
- **AC9 — duplicates.** Several profiles with one normalized name, on one host or many, show one row pair. The label uses the first display name in host order, then list order. On a host with duplicates, the shortcut resolves to the first in that host's list order.
- **AC10 — CLI.** `paseo app config shortcuts` lists the new IDs. `paseo app config set shortcuts.<new id> <combo>` is accepted. Legacy IDs are rejected for writes.
- **AC11 — no protocol change.** `packages/protocol` and `packages/server` are untouched. Old daemons work unchanged.

Documented, not fixed:

- Renaming a profile detaches it from its binding. The binding stays keyed by the old name and keeps working on any host where that name still exists.
- A name that exists only on offline or unsupported hosts has no settings row until one of them loads. Its binding stays stored.
- A combo bound to two **different** names matches the first binding only. That is today's behavior for any duplicate combo.

## Design

### Identity — `agent-profiles/shortcuts.ts`

A shortcut ID is `JSON.stringify([action, profileKey])`, a 2-tuple. Legacy IDs are 3-tuples, so the two shapes can't collide. `profileKey` is the normalized name. It is stored rather than the display name, so two hosts that differ only in case or spacing share one key.

```ts
export type AgentProfileShortcutAction = "agent-profile.select" | "agent-profile.start";

/** NFC, trim, collapse whitespace runs to one space, lowercase. "" for a blank name. */
export function agentProfileShortcutKey(name: string): string;

export function agentProfileShortcutId(
  action: AgentProfileShortcutAction,
  profileKey: string,
): string;

/** Accepts only the 2-tuple shape with a non-empty key. Payload: { type: "agent-profile", profileKey }. */
export function agentProfileShortcutBinding(id: string): ParsedShortcutBinding | null;

/** First profile, in list order, whose normalized name equals `profileKey`. */
export function findAgentProfileForShortcut<T extends { name: string }>(
  profiles: readonly T[] | null | undefined,
  profileKey: string,
): T | null;

// COMPAT(sharedProfileShortcuts): legacy per-host IDs, added 2026-10-31, remove after 2027-04-30
export function hasLegacyAgentProfileShortcuts(
  overrides: ShortcutOverrides,
  serverId: string,
): boolean;
export function migrateLegacyAgentProfileShortcuts(
  overrides: ShortcutOverrides,
  serverId: string,
  profiles: readonly AgentProfile[],
): ShortcutOverrides; // returns `overrides` itself when nothing changed
```

The module comment states the identity rule (name-keyed, host supplied at dispatch). That is where the code-level fact lives. No `docs/` page owns shortcuts.

Migration rules for each legacy key `[action, serverId, profileId]` of the given host, iterated in that host's profile list order:

1. Profile ID not in the list → drop the key (the profile was deleted).
2. Value `null` (unassigned) → drop the key. A profile binding has no default, so `null` and absent mean the same thing.
3. Shared ID for `(action, key)` absent → set it to the legacy value, drop the legacy key.
4. Shared ID present → keep it, drop the legacy key.

Legacy keys for other servers and malformed keys are left alone.

### Dispatch

The payload loses `serverId`, so no binding names a host. The active surface supplies it.

| File                                     | Change                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keyboard/keyboard-shortcuts.ts`         | `ShortcutPayloadDef` agent-profile variant → `{ type: "agent-profile"; profileKey: string }`; `resolvePayload` → `{ profileKey }`                                                                                                                                                                                 |
| `keyboard/actions.ts`                    | `KeyboardShortcutPayload` variant → `{ profileKey: string }`                                                                                                                                                                                                                                                      |
| `keyboard/keyboard-action-dispatcher.ts` | action → `{ id: "agent-profile.select" \| "agent-profile.start"; scope; profileKey: string }`                                                                                                                                                                                                                     |
| `keyboard/route-shortcut.ts`             | `routeAgentProfile` checks `"profileKey" in payload`                                                                                                                                                                                                                                                              |
| `composer/agent-controls/index.tsx`      | `useAgentProfileSelectShortcut` resolves `findAgentProfileForShortcut(agentProfiles?.rows, action.profileKey)` and calls `onApplyAgentProfile(row.id)`. Drop the `serverId` comparison. `modelSelectorServerId` stays as the toast's host. Rows `null` → return `false`. No match → missing toast, return `true`. |
| `agent-profiles/use-start-shortcut.ts`   | Resolve against `useAgentProfiles(input.serverId)` by key. Drop the `serverId` comparison. `profiles === null` → `false`. No match → missing toast, return `true`. `client` stays `useHostRuntimeClient(input.serverId)`.                                                                                         |

The host is correct by construction. The select handler is enabled only for the active composer (`isActiveComposer && isRouteFocused && isPanelActive`). The start handler is enabled only on the focused workspace route (`workspace-screen.tsx:2745`). Each handler reads its own host's profile list.

Missing-profile toast:

```ts
// agent-profiles/internal/use-missing-profile-toast.ts, exported from @/agent-profiles
export function useMissingAgentProfileToast(serverId: string | null): (profileKey: string) => void;
```

It shows `t("settings.shortcuts.profiles.missing", { name, host })` with `variant: "warning"`. `host` is the host's label from `useHosts()`, falling back to `serverId`. `name` is resolved at call time from `queryClient.getQueriesData({ queryKey: daemonConfigQueryRoot })`: the first cached profile across hosts whose key matches, else `profileKey`. It reads the cache only, so composers open no extra subscriptions. Add `daemonConfigQueryRoot = ["daemon-config"] as const` to `data/daemon-config.ts`, and build `daemonConfigQueryKey` from it.

### Migration runtime

- `keyboard/shortcut-override-store.ts`: add `update(transform: (current: ShortcutOverrides) => ShortcutOverrides): Promise<void>`. It goes through the same serialized queue as the other operations. It skips the write when `transform` returns `current`, and rolls back the cache plus calls `onError` on a failed write.
- `keyboard/profile-shortcut-migration.tsx`: `export function ProfileShortcutMigration({ serverId }: { serverId: string }): ReactNode`.
  - Reads `useKeyboardShortcutOverrides()`. Does nothing while `isLoading`. The store's cache reads `{}` before the query resolves, so an early write would erase every override.
  - Renders an inner component only when `hasLegacyAgentProfileShortcuts(overrides, serverId)`. Hosts without legacy keys then never open a daemon-config subscription for this.
  - The inner component calls `useAgentProfiles(serverId)` from `@/agent-profiles` (already exported). Once `isSupported && profiles !== null`, its effect calls `getShortcutOverrideStore(queryClient).update((current) => migrateLegacyAgentProfileShortcuts(current, serverId, profiles))`. The transform runs on the queue's latest map, not on the render snapshot, so migrations from several hosts compose and the first to run wins (AC7). A failure is logged through the store's `onError` and retried on the next profiles change or app start.
  - It lives in `keyboard/`, not `agent-profiles/`, so wave 2 tasks don't both edit `agent-profiles/index.ts`. It uses only the module's public surface plus `@/agent-profiles/shortcuts`, the same way `keyboard-shortcuts.ts` does today.
- `app/_layout.tsx`: mount `<ProfileShortcutMigration serverId={daemon.serverId} />` inside `ManagedDaemonSession`, next to `LegacyFavoriteProfileMigrationBootstrap`. This adds no route, redirect or startup-routing change (checked against `docs/expo-router.md`).

Until a host's profiles load, its legacy keys are inert, because `agentProfileShortcutBinding` no longer parses them. Nothing is lost: dispatch on that host needs its profiles anyway.

### Settings — merged section

Reading profiles for every host in one component:

- `data/query.ts`: add `useReplicaQueries<TData>(inputs: ReplicaQueryInput<TData, Error, TData, QueryKey>[]): UseQueryResult<TData, Error>[]`, mirroring `useFetchQueries`.
- `hooks/use-daemon-config.ts`: extract `daemonConfigReplicaInput(input: { serverId: string | null; client: DaemonClient | null; isConnected: boolean; disconnectedMessage: string })`. `useDaemonConfig` uses it. Both observers share `daemonConfigQueryKey(serverId)`, so `push-router.ts` updates reach them.
- `agent-profiles/internal/use-agent-profiles.ts`: add

  ```ts
  export interface HostAgentProfiles {
    serverId: string;
    profiles: AgentProfile[];
  }
  /** Hosts whose daemon supports profiles and whose config has loaded, in `serverIds` order. */
  export function useAgentProfilesForHosts(serverIds: readonly string[]): HostAgentProfiles[];
  ```

  Clients come from `getHostRuntimeStore().getClient(serverId)`. Connection state comes from `useHostRuntimeConnectionStatuses(serverIds)`. Support comes from one `useSessionStore` selector that joins per-host booleans into a string (the same value-comparison trick as `useHostRuntimeConnectionStatuses`). Export it from `@/agent-profiles`.

- `screens/settings/profile-shortcut-rows.ts` (new):

  ```ts
  export function buildProfileShortcutRows(input: {
    hosts: readonly HostAgentProfiles[];
    hostLabel: (serverId: string) => string;
    t: TFunction;
  }): KeyboardShortcutHelpRow[];
  ```

  It iterates hosts in order, then profiles in order, and keeps the first display name per non-blank key. It emits a select row then a start row per key. `id` is the shared binding ID, `label`/`labelKey` is the translated label, and `note` is the joined host labels (each host once, in host order).

- `keyboard-shortcuts-section.tsx`: replace the per-host `ProfileShortcutSection` with one section: `useAgentProfilesForHosts(hosts.map(h => h.serverId))` (memoize the ID list), then `buildProfileShortcutRows`. Title `settings.shortcuts.profiles.title` becomes "Agent profiles" (drop `{{host}}`). `info={t("settings.shortcuts.profiles.sharedHint")}`. Hide the section when there are no rows. `ShortcutRow` renders `row.note` as a muted secondary line under the label when present. Default rows carry no `note` in settings, so they are unchanged. Capture stays keyed by binding ID, because each binding has one row.
- i18n, all 9 locale files: change `title`, add `sharedHint` ("Shortcuts apply to every host's profile with the same name.") and `missing` ("No agent profile named {{name}} on {{host}}"). `missing` is added in T1, `title`/`sharedHint` in T3.

### CLI / desktop app config

`desktop/settings/app-config.ts` validates IDs through `agentProfileShortcutBinding`, so the new shape is accepted and legacy writes are rejected with no code change (AC10). Cover it in the existing test.

### Error handling and conventions

- No new error surfaces beyond the missing-profile toast. Malformed IDs parse to `null`, as today. Migration write failures go through the store's existing `onError`. Start failures keep today's error toast.
- Tag every legacy-only site `// COMPAT(sharedProfileShortcuts): added 2026-10-31, remove after 2027-04-30`.
- No protocol, server or daemon-config schema change. Bindings never leave the client's AsyncStorage, and no profile config or credentials are copied between hosts.
- Follow `docs/coding-standards.md`: derived rows are computed in render or `useMemo`; the only effect is the migration write, which synchronizes with storage.

## Tasks

### Wave 1

**T1 — Name-keyed profile shortcut identity, dispatch and missing-profile toast**

- Goal: bindings carry `profileKey`; handlers resolve it against their own host and toast when it's missing; the pure migration function is ready.
- Owned files:
  - `packages/app/src/agent-profiles/`: `shortcuts.ts`, `shortcuts.test.ts` (new), `use-start-shortcut.ts`, `use-start-shortcut.test.tsx`, `internal/use-missing-profile-toast.ts` (new), `index.ts`
  - `packages/app/src/keyboard/`: `keyboard-shortcuts.ts`, `keyboard-shortcuts.test.ts`, `actions.ts`, `keyboard-action-dispatcher.ts`, `route-shortcut.ts`, `route-shortcut.test.ts`
  - `packages/app/src/composer/agent-controls/index.tsx`
  - `packages/app/src/data/daemon-config.ts`
  - `packages/app/src/desktop/settings/app-config.test.ts`
  - `packages/app/src/screens/settings/keyboard-shortcuts-section.tsx`, call-site update only: `agentProfileShortcutId(action, agentProfileShortcutKey(profile.name))`, skip blank keys. T3 replaces this code.
  - `packages/app/src/i18n/resources/{ar,en,es,fr,ja,ko,pt-BR,ru,zh-CN}.ts`, `missing` key only
  - Any other call site the payload change breaks in typecheck
- Produces: the `shortcuts.ts` signatures above; dispatcher action `{ id, scope, profileKey }`; `useMissingAgentProfileToast`; `daemonConfigQueryRoot`.
- Consumes: nothing new.
- Dependencies: none.
- Tests:
  - `shortcuts.test.ts`: key normalization (AC8). ID round-trip. Legacy 3-tuple rejected by `agentProfileShortcutBinding`. `findAgentProfileForShortcut` first-wins (AC9). `migrateLegacyAgentProfileShortcuts` rules 1–4, other-host and non-profile keys untouched, identity return when nothing changes (AC6, AC7).
  - `keyboard-shortcuts.test.ts`: existing profile cases move to `{ profileKey }` payloads.
  - `route-shortcut.test.ts`: routes `{ profileKey }`.
  - `use-start-shortcut.test.tsx`: two hosts with different IDs for `Saved`. Dispatch `{ profileKey: "saved" }` with the probe on host B. `createAgent` runs on B's client with B's profile config (AC3). An unknown key shows the warning toast, returns `true` and makes no RPC (AC4). Profiles `null` → `false`, no toast.
  - `app-config.test.ts`: set accepts a 2-tuple ID, rejects a legacy 3-tuple ID (AC10).
- Unit test command: `cd packages/app && npx vitest run src/agent-profiles/shortcuts.test.ts src/agent-profiles/use-start-shortcut.test.tsx src/keyboard/keyboard-shortcuts.test.ts src/keyboard/route-shortcut.test.ts src/desktop/settings/app-config.test.ts --bail=1`

### Wave 2 (both depend on T1; disjoint files)

**T2 — Legacy override migration runtime**

- Goal: legacy per-host overrides become shared overrides once that host's profiles load (AC6, AC7).
- Owned files:
  - `packages/app/src/keyboard/`: `shortcut-override-store.ts`, `shortcut-override-store.test.ts`, `profile-shortcut-migration.tsx` (new), `profile-shortcut-migration.test.tsx` (new)
  - `packages/app/src/app/_layout.tsx`
- Produces: `ShortcutOverrideStore.update`; `ProfileShortcutMigration`.
- Consumes: `hasLegacyAgentProfileShortcuts`, `migrateLegacyAgentProfileShortcuts` (T1); `useAgentProfiles` (existing).
- Tests:
  - `shortcut-override-store.test.ts`: `update` is serialized behind a pending `set` and sees that `set`'s value. It skips the write on identity return and rolls back on a failed write.
  - `profile-shortcut-migration.test.tsx` (jsdom, real store over in-memory storage, `useAgentProfiles` mocked at the module boundary):
    - Nothing is written while overrides are loading.
    - A legacy key migrates once profiles arrive.
    - No write when `isSupported` is false.
    - Another host's legacy key is untouched.
    - Two hosts migrating the same name with different combos: the first to run wins.
- Unit test command: `cd packages/app && npx vitest run src/keyboard/shortcut-override-store.test.ts src/keyboard/profile-shortcut-migration.test.tsx --bail=1`

**T3 — Merged agent-profile shortcuts section**

- Goal: one settings section lists each profile name once, with its hosts; binding edits act on the shared ID (AC5, AC9).
- Owned files:
  - `packages/app/src/data/query.ts`
  - `packages/app/src/hooks/use-daemon-config.ts`
  - `packages/app/src/agent-profiles/`: `internal/use-agent-profiles.ts`, `internal/use-agent-profiles.test.tsx` (new), `index.ts`
  - `packages/app/src/screens/settings/`: `keyboard-shortcuts-section.tsx`, `profile-shortcut-rows.ts` (new), `profile-shortcut-rows.test.ts` (new)
  - `packages/app/src/i18n/resources/{ar,en,es,fr,ja,ko,pt-BR,ru,zh-CN}.ts`, `title` and `sharedHint` only
- Produces: `useReplicaQueries`, `daemonConfigReplicaInput`, `useAgentProfilesForHosts`, `HostAgentProfiles`, `buildProfileShortcutRows`.
- Consumes: `agentProfileShortcutKey`, `agentProfileShortcutId` (T1).
- Tests:
  - `profile-shortcut-rows.test.ts`: two hosts' profile lists with different IDs and equal names give one row pair, with both host labels in `note`. Case and spacing variants merge. The first display name wins. Blank names are skipped. Host order, then list order, is kept.
  - `use-agent-profiles.test.tsx` (jsdom, real `QueryClient`, host runtime and session store mocked at the module boundary): an unsupported host is omitted, an unloaded host is omitted, and a `setQueryData` on one host's `daemonConfigQueryKey` (what `push-router` does) shows up in the result.
- Unit test command: `cd packages/app && npx vitest run src/screens/settings/profile-shortcut-rows.test.ts src/agent-profiles/internal/use-agent-profiles.test.tsx --bail=1`

## Test and verification

Per task, the worker runs its unit test command, then:

```bash
npm run typecheck
npm run lint
npm run format          # before every commit
```

- The orchestrator reruns each task's unit test command itself after the worker reports. That overrides the repo default of trusting worker results, because this workflow asks for it.
- After wave 2 merges, the orchestrator reruns all three task commands together, plus `npm run typecheck` and `npm run lint`.
- No full suite locally. Broad runs go to CI.
- No `packages/protocol` or `packages/server` change, so no `build:client`/`build:server` step is needed. If typecheck reports cross-package declaration errors, run `npm run build:client` before diagnosing.

## E2E journey

Two disposable dev daemons, each with its own `PASEO_HOME` and port, plus the dev web app (`docs/development.md`, `docs/ad-hoc-daemon-testing.md`). Never touch the main daemon on 6767. Name the hosts `kazuki-e2e` and `sachi-e2e`. Each gets a throwaway git repo workspace. Connect both hosts with the multi-host helpers in `packages/app/e2e/support/helpers/hosts.ts` (`addConnectedHostsAndReload`), or through Settings › Hosts.

1. On kazuki-e2e, create profiles `Claude` (provider A) and `Pi Opus`. On sachi-e2e, create `claude ` (different case, trailing space, provider B) and no `Pi Opus`. → Each daemon's config shows different profile IDs.
2. Seed legacy bindings as the pre-change client stored them. Write `["agent-profile.select","<kazuki serverId>","<kazuki Claude id>"]: "Ctrl+Shift+1"` and `["agent-profile.start","<kazuki serverId>","<kazuki Pi Opus id>"]: "Ctrl+Shift+2"` into AsyncStorage `@paseo:keyboard-shortcut-overrides`. Then reload. → Both legacy keys are gone, replaced by `["agent-profile.select","claude"]` and `["agent-profile.start","pi opus"]` with the same combos.
3. Open Settings › Shortcuts. → There is one `Agent profiles` section and no per-host sections. `Select profile: Claude` shows `Ctrl+Shift+1` with secondary line `kazuki-e2e, sachi-e2e`. `Start agent: Pi Opus` shows `Ctrl+Shift+2` with `kazuki-e2e`. The header info tip explains name sharing.
4. Open a sachi-e2e workspace, focus the composer, press `Ctrl+Shift+1`. → The composer shows sachi's `claude ` profile (provider B).
5. On that sachi-e2e workspace, press `Ctrl+Shift+2`. → A warning toast reads "No agent profile named Pi Opus on sachi-e2e". `paseo ls` on both daemons shows no new agent.
6. Switch to a kazuki-e2e workspace and press `Ctrl+Shift+1`, then `Ctrl+Shift+2`. → Kazuki's `Claude` (provider A) is applied. The "Starting agent: Pi Opus" toast appears and a new agent shows up on kazuki-e2e only.
7. On sachi-e2e, create `Pi Opus` (provider B). Back on a sachi-e2e workspace, press `Ctrl+Shift+2`. → The agent is created on sachi-e2e from sachi's config, with no rebinding. The settings row's secondary line now reads `kazuki-e2e, sachi-e2e`.
8. In Settings, rebind `Start agent: Pi Opus` to `Ctrl+Shift+3`. → One row enters capture. After Done, `Ctrl+Shift+3` starts on whichever host is active, and `Ctrl+Shift+2` no longer fires.
9. Run `paseo app config shortcuts` (desktop). → It lists the 2-tuple IDs. Setting a legacy 3-tuple ID fails with "Unknown shortcut".
10. Tear down both disposable daemons and their `PASEO_HOME` directories.
