# Per-Project Workspace Isolation

Interactive UI design proposal (not implementation evidence):

- Latest preview: <https://artifacts.kazuki.m.mado.moe/a/c1ba9a46-3405-4775-84f9-4316bab66245>
- Pinned snapshot (revision 1): <https://artifacts.kazuki.m.mado.moe/a/c1ba9a46-3405-4775-84f9-4316bab66245?revision=1>
- Saved receipt: `/home/sinkerine/dev/paseo/.git/worktrees/sour-blobfish/e2e-feature/project-isolation/artifact-receipt.json`

## Goal and acceptance criteria

### Goal

Support configuring each Paseo Git project to always initialize new workspaces as **Local** (`"local"`) or **New worktree** (`"worktree"`), or leave the project unpinned (**Remember last**, `null`) so it continues using the client's global `FormPreferences.isolation` preference. Persist the setting on the daemon's host-local Project Registry (`$PASEO_HOME/projects/projects.json`) without modifying repository `paseo.json`, propagate it live through directory sync and offline replica storage, resolve omitted isolation from the project default across App (`NewWorkspaceScreen`, `ScheduleFormSheet`), CLI (`paseo workspace create`), and MCP (`create_workspace`) while honoring explicit per-creation overrides without mutating a pinned project's saved default or polluting global `FormPreferences.isolation`, and expose project isolation configuration/observation in `@getpaseo/client` while preserving the SDK's explicit discriminated `workspaces.create({ source })` contract unchanged.

### Acceptance criteria

- **AC1 — Project settings persistence and live sync.** On **Project Settings** (`/settings/hosts/[serverId]/projects/[projectId]`, entered via both `Settings → [Host] → Projects → [Project]` and `Sidebar project row → kebab/context menu → Open project settings`), a Git project (`projectKind === "git"`) renders a `Workspaces` group above the `paseo.json` sections with a `New workspace isolation` select offering `Remember last` (`null`), `Local` (`"local"`), and `New worktree` (`"worktree"`). Selecting `Local`, `New worktree`, or `Remember last` sends `project.isolation.set.request`, atomically updates `$PASEO_HOME/projects/projects.json`, emits `project.update` and affected `workspace_update` descriptors to all subscribed sessions on that daemon, updates `SessionStore` and `replica-cache`, shows a `"Workspace isolation updated"` toast, and leaves `<repoRoot>/paseo.json` and the `paseo.json` `Save` button untouched.
  - Baseline failure: `project.isolation.set.request` does not exist and `ProjectSettingsScreen` renders no `New workspace isolation` control.
  - Evidence: `packages/protocol/src/messages.workspaces.test.ts`, `packages/server/src/server/workspace-registry.test.ts`, `packages/server/src/server/workspace-directory.test.ts`, `packages/server/src/server/session.workspaces.test.ts`, `packages/server/src/server/session.test.ts`, `packages/app/src/stores/session-store-hooks/selectors.test.ts`, `packages/app/src/runtime/directory-sync/workspace-replica.test.ts`, `packages/app/src/runtime/replica-cache/index.test.ts`, Playwright browser E2E in `packages/app/e2e/browser/projects-settings.spec.ts` (both `Settings → Projects` and sidebar kebab `Open project settings` entry paths, E2E Steps 1–2), and real Electron E2E in `packages/desktop/e2e/project-isolation.electron.mjs` (E2E Step 10).

- **AC2 — Independence from `paseo.json` read/write failures.** When `<repoRoot>/paseo.json` is absent, uncommitted, or contains invalid JSON (`invalid-callout` shown and `paseo.json` form hidden), `New workspace isolation` on `ProjectSettingsScreen` remains visible and editable for a connected Git project, and changing it never triggers the `"Commit paseo.json changes"` warning.
  - Baseline failure: `ProjectSettingsScreen` has no daemon-backed workspace isolation control above `paseo.json` `renderContent`.
  - Evidence: Playwright browser E2E in `packages/app/e2e/browser/projects-settings.spec.ts` with corrupted `paseo.json` asserting `invalid-callout` is visible while `New workspace isolation` updates and persists (E2E Step 6).

- **AC3 — Non-Git project gating and server fail-closed validation.** For a non-Git project (`projectKind === "non_git"`), `ProjectSettingsScreen`, `NewWorkspaceScreen`, and `ScheduleFormSheet` hide the isolation control completely (never rendered disabled). On the daemon, `project.isolation.set.request` with `defaultIsolation: "worktree"` on a `non_git` project fails closed with `{ accepted: false, defaultIsolation: null, error: "Worktree isolation requires a Git project" }` without writing `projects.json` or emitting `project.update`, while `"local"` and `null` remain accepted. If an already-configured `"worktree"` Git project later loses `.git` (`kind` reconciled to `"non_git"`), `defaultIsolation: "worktree"` is preserved in `projects.json` while effective creation isolation degrades to `"local"` until `.git` returns.
  - Baseline failure: no server validation or UI gating for project `defaultIsolation` exists.
  - Evidence: `packages/server/src/server/session.workspaces.test.ts` (`non_git` rejection and `.git` removal/restoration reconciliation), Playwright browser E2E in `packages/app/e2e/browser/projects-settings.spec.ts` (`project-isolation-card` absent on `non_git`), `packages/app/e2e/browser/new-workspace-isolation-memory.spec.ts` (`workspace-create-isolation-trigger` absent on `non_git` with stable compact stack height), and `packages/app/e2e/browser/schedules-project-target.spec.ts` (`schedule-isolation-trigger` absent on `non_git`) (E2E Step 5).

- **AC4 — Fallible mutation states on Project Settings.** While `project.isolation.set.request` is in flight, `New workspace isolation` disables duplicate selection. If the RPC rejects or returns `accepted: false` (unknown/archived project, write error, or disconnected transport), the select retains the last committed value, renders the error message inline on the row with `accessibilityRole="alert"` (`testID="project-isolation-row"`), and clears the error on a subsequent successful retry.
  - Baseline failure: control and inline RPC error state do not exist.
  - Evidence: Playwright browser E2E in `packages/app/e2e/browser/projects-settings.spec.ts` holding `project.isolation.set.request` to assert disabled pending state, failing it to assert inline `role="alert"` + unchanged value, then releasing and retrying to success (E2E Step 7).

- **AC5 — New Workspace screen honors project default across every entry path and submit variant.** Opening `NewWorkspaceScreen` (`/new`) initializes `Isolation` to `projectDefaultIsolation` when non-null (`"local"` or `"worktree"`), overriding any conflicting global `FormPreferences.isolation`, across every UI entry path:
  1. Sidebar header `New workspace` (`sidebar-global-new-workspace`) while a workspace in the project is active;
  2. Sidebar project row `+` icon (`sidebar-project-new-worktree-*`);
  3. Sidebar project `+ New workspace` ghost row (`sidebar-project-new-workspace-row-*` on an empty/expanded project);
  4. `workspace.new` / `worktree.new` keyboard-action dispatch — exercised via Command Center `New workspace` (`Ctrl+K` → `New workspace`) in browser E2E and `Ctrl+N` in real Electron E2E (`useActiveWorktreeNewAction` shares the identical `buildNewWorkspaceRoute({ serverId, sourceDirectory, projectId })` target tested in `new-workspace-initial-context.test.ts` + `isolation.test.ts`);
  5. Post-Add-Project navigation (`openAddProjectFlow` → `directory-search` on an active configured project root landing on `/new`);
  6. In-screen Project picker switching (`new-workspace-project-picker-trigger`).
     Submitting via each of the three creation submit paths — (i) **Empty workspace** (`Create` with empty prompt), (ii) **Chat agent** (`Create` with prompt and selected model), and (iii) **Terminal launch** (`Launch` with a configured terminal profile) — sends `workspace.create.request` with the matching `source.kind` (`"directory"` for `"local"`, `"worktree"` for `"worktree"`).
  - Baseline failure: `useWorkspaceIsolation` reads `manualIsolation ?? preferences.isolation ?? "local"` globally, so creating a worktree in one project causes a `Local`-configured project to preselect and submit `"worktree"` across all entry and submit paths.
  - Evidence: `packages/app/src/screens/new-workspace/isolation.test.ts`, Playwright browser E2E in `packages/app/e2e/browser/new-workspace-isolation-memory.spec.ts` (entries 1–6 + Empty and Chat submit variants, E2E Steps 3 & 3b), Playwright browser E2E in `packages/app/e2e/browser/new-workspace-launch-terminal.spec.ts` (Terminal launch submit variant honoring project `defaultIsolation: "worktree"` vs `"local"`, E2E Step 3c), and real Electron E2E in `packages/desktop/e2e/project-isolation.electron.mjs` (`Ctrl+N` + sidebar `+`, E2E Step 10).

- **AC6 — Manual one-off override in New Workspace clears on target switch (`A → B → A`) and preserves project default and global preference.** On `NewWorkspaceScreen`, when the selected project `A` has a non-null `defaultIsolation` (e.g., `"local"`), manually picking `"worktree"` in `workspace-create-isolation-trigger`:
  1. Applies `"worktree"` if submitted immediately for that single workspace creation, without mutating `A`'s `defaultIsolation` on the daemon and without overwriting global `FormPreferences.isolation`;
  2. Is **permanently cleared** from draft state when switching Project (`A → B`) or Host (`H1 → H2`), so switching back (`A → B → A` or `H1 → H2 → H1`) resolves `A`'s configured `defaultIsolation` (`"local"`) rather than resurrecting the discarded `"worktree"` override;
  3. Starts back at `A`'s `defaultIsolation` (`"local"`) when reopening `/new` after creation.
     For unpinned projects (`defaultIsolation === null`), manual picks continue to persist `FormPreferences.isolation` across remounts as before.
  - Baseline failure: `setIsolation` unconditionally writes `FormPreferences.isolation` and `manualIsolation` persists across project and host switches on `/new`.
  - Evidence: `packages/app/src/screens/new-workspace/isolation.test.ts` (`A → manual → B → A` and `H1 → manual → H2 → H1` state-machine tests) and Playwright browser E2E in `packages/app/e2e/browser/new-workspace-isolation-memory.spec.ts` driving `A → manual override → B → A` and post-submit reopen in the real browser UI (E2E Step 4).

- **AC7 — Multi-host placement isolation (`H1 → H2 → H1`).** When two connected hosts (Primary host and Secondary isolated host) register checkouts sharing the same `projectKey`, each host's `projectId` owns an independent `defaultIsolation` in its own `projects.json`. Viewing each host's `ProjectSettingsScreen` mutates only that host's record, and switching the Host picker (`host-picker-trigger`) on `NewWorkspaceScreen` (`H1 → H2` and `H1 → manual override → H2 → H1`) resolves each host placement's `defaultIsolation` while clearing any prior manual override.
  - Baseline failure: `WorkspaceStructureHostPlacement` and `ProjectHostEntry` carry no per-host `defaultIsolation`.
  - Evidence: `packages/app/src/projects/host-projects.test.ts`, `packages/app/src/utils/projects.test.ts`, and Playwright browser E2E in `packages/app/e2e/browser/new-workspace-host-project-preservation.spec.ts` using `startIsolatedHostDaemon` (E2E Step 8).

- **AC8 — Schedule form (`ScheduleFormSheet`) create, switch (`A → B → A`), manual override, and edit semantics.** In `ScheduleFormSheet` (`/schedules`), opening `New schedule` (`create` mode) and selecting a Git project seeds `schedule-isolation-trigger` from `target.defaultIsolation ?? preferences?.isolation ?? "local"`. Manually changing `schedule-isolation-trigger` on project `A`, switching `schedule-project-trigger` to `B`, and switching back `B → A` clears the manual override and restores `A`'s `defaultIsolation`. Submitting `Create schedule` for a pinned project (`target.defaultIsolation !== null`) persists the schedule's chosen `target.config.isolation` on the daemon without overwriting global `FormPreferences.isolation`. Opening an existing schedule in `edit` mode always preserves the schedule's saved `config.isolation ?? "local"` even after the project's `defaultIsolation` changes.
  - Baseline failure: `ScheduleFormSheet` / `schedule-form-model.ts` resolves create-mode isolation solely from `preferences?.isolation ?? "local"`, never consults project `defaultIsolation`, and overwrites `FormPreferences.isolation` on submit.
  - Evidence: `packages/app/src/schedules/schedule-form-model.test.ts`, `packages/app/src/schedules/schedule-project-targets.test.ts`, and real browser UI acceptance test in `packages/app/e2e/browser/schedules-project-target.spec.ts` driving `ScheduleFormSheet` create, `A → manual → B → A` project switch, schedule submission, and edit-mode preservation against a real isolated daemon (E2E Step 9).

- **AC9 — CLI, MCP, and SDK contracts and explicit-override compatibility.**
  1. **SDK (`@getpaseo/client`)**: `DaemonClient.setProjectIsolation(projectId, defaultIsolation, requestId?)` and `client.projects.setIsolation(projectId, defaultIsolation, options?)` set or clear `defaultIsolation`, and `client.projects.list()` / `client.projects.subscribe()` / `client.workspaces.list()` expose `projectDefaultIsolation`. `client.workspaces.create({ source, ... })` intentionally retains its required discriminated `source` parameter (`{ kind: "directory", path, projectId? } | { kind: "worktree", ... }`) with **no implicit/optional isolation mode** and **no server-side lock**: every SDK `workspaces.create` call is an explicit source specification and continues to succeed unchanged regardless of `projectDefaultIsolation`.
  2. **CLI (`@getpaseo/cli`)**:
     - `paseo project isolation <project-id>` prints `{ projectId, defaultIsolation }`; `paseo project isolation <project-id> <local|worktree>` sets it; `paseo project isolation <project-id> --reset` clears it to `null` (rejecting `--reset` combined with a value, and rejecting invalid values).
     - `paseo project ls` includes `defaultIsolation` (`local`, `worktree`, or `-` in human output; `"local" | "worktree" | null` in `--json`).
     - `paseo workspace create` makes `--isolation <local|worktree>` optional: when omitted, it resolves `project.projectDefaultIsolation ?? "local"` for an active `git` project matched by `--project <id>` or lexical `--path` / `process.cwd()` (and `"local"` for `non_git` or unmatched paths); when explicitly passed, `--isolation local|worktree` always wins. `paseo run --new-workspace <local|worktree>` retains its required option value so positional `[prompt]` parsing is unchanged.
  3. **MCP (`create_workspace` in `paseo-tools.ts`)**: `isolation` is optional; when omitted, `create_workspace` resolves the target project's `defaultIsolation ?? "local"` (`"local"` when `non_git`), while explicit `isolation: "local" | "worktree"` always wins.
  - Baseline failure: `setProjectIsolation` and `paseo project isolation` do not exist; `paseo workspace create` and MCP `create_workspace` reject omitted `isolation`.
  - Evidence: `packages/client/src/daemon-client.test.ts`, `packages/client/src/index.test.ts`, `packages/cli/src/commands/project/project.test.ts`, `packages/cli/src/commands/workspace/create.test.ts`, and `packages/server/src/server/workspace-create-worktree-source.e2e.test.ts` (real daemon + MCP + SDK `workspaces.create` explicit override verification).

- **AC10 — Wire backward compatibility and `zod-aot` purity.** `WorkspaceProjectDescriptorPayloadSchema`, `WorkspaceDescriptorPayloadSchema`, `ProjectIsolationSetRequestSchema`, and `ProjectIsolationSetResponseSchema` use pure structural Zod schemas (no `.transform()`, `.catch()`, or `.preprocess()`), compile cleanly through `packages/protocol` `generate:validators` within the 1 MB per-message validator limit, allow old clients to parse new daemon payloads and new clients to parse old daemon payloads (absent `projectDefaultIsolation` treated as `null`), and carry `COMPAT(projectDefaultIsolation)` comments at optional wire sites.
  - Baseline failure: new schemas and `zod-aot` validators do not exist yet.
  - Evidence: `packages/protocol/src/messages.workspaces.test.ts`, `packages/protocol/src/messages.wire-compat.test.ts`, `packages/protocol/tests/validation/ws-outbound.test.ts`, and `packages/server/src/wire-compat.test.ts`.

### State, lifecycle, resume, retry, and concurrency transitions

| Transition                                                                                                                            | Expected behavior                                                                                                                                                                                                                                                                                                                                                                             | Mapped AC & named regression test                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T-S1: Unset → pinned → reset (`null → "worktree" → "local" → null`)**                                                               | Persists atomically to `projects.json`, updates `SessionStore` + `replica-cache` + active workspace descriptors, and restores `FormPreferences.isolation` fallback on reset to `null`.                                                                                                                                                                                                        | AC1 — `session.workspaces.test.ts` (`"project.isolation.set.request updates, switches, and resets default isolation"`)                                                                                            |
| **T-S2: Repeated / idempotent no-op call (`"worktree" → "worktree"`, `null → null`)**                                                 | Succeeds (`accepted: true`), avoids rewriting `projects.json` when unchanged, and emits no spurious error.                                                                                                                                                                                                                                                                                    | AC1 — `workspace-registry.test.ts` & `session.workspaces.test.ts` (`"project.isolation.set.request is idempotent when value is unchanged"`)                                                                       |
| **T-S3: Concurrent mutations on same project (`rename` + `isolation.set`, or two rapid `isolation.set` calls)**                       | Serialized through `FileBackedProjectRegistry`'s `mutationQueue`; neither write clobbers the other's field, and the second queued `isolation.set` wins deterministically.                                                                                                                                                                                                                     | AC1 — `workspace-registry.test.ts` (`"serializes concurrent project rename and defaultIsolation updates without field loss"`)                                                                                     |
| **T-S4: Daemon restart and client cold-cache resume**                                                                                 | Daemon reloads `defaultIsolation` from `projects.json`; legacy `projects.json` entries without `defaultIsolation` normalize to `null`; client `replica-cache` rows with and without `projectDefaultIsolation` hydrate without invalidating existing directory cursors.                                                                                                                        | AC1, AC10 — `workspace-registry.test.ts`, `replica-cache/index.test.ts` (`"hydrates legacy and isolation-configured project and workspace rows"`)                                                                 |
| **T-S5: Live update propagation to empty vs workspace-bearing projects**                                                              | `project.update` updates both empty projects and every cached `WorkspaceDescriptor` belonging to `projectId` in `WorkspaceDirectoryReplica`, updating `SessionStore` selectors immediately.                                                                                                                                                                                                   | AC1 — `workspace-replica.test.ts` (`"propagates projectDefaultIsolation across attached workspaces on project.update"`), `selectors.test.ts`                                                                      |
| **T-S6: Project switches between `git` and `non_git` on disk**                                                                        | Removing `.git` reconciles `kind` to `"non_git"` while retaining `defaultIsolation: "worktree"` on disk; UI hides isolation and effective creation uses `"local"`. Restoring `.git` reconciles `kind` back to `"git"` and re-activates `"worktree"`. Setting `"worktree"` while `non_git` fails closed.                                                                                       | AC3 — `session.workspaces.test.ts` (`"preserves stored worktree defaultIsolation across non_git reconciliation while rejecting new worktree writes on non_git"`)                                                  |
| **T-S7: Unknown or archived project mutation**                                                                                        | `project.isolation.set.request` for a missing or `archivedAt !== null` project returns `{ accepted: false, defaultIsolation: null, error: "Project not found" }` with zero disk writes or mutation events.                                                                                                                                                                                    | AC4 — `session.workspaces.test.ts` (`"project.isolation.set.request rejects missing and archived projects"`)                                                                                                      |
| **T-S8: Pending disable + failed save + retry on `ProjectSettingsScreen`**                                                            | While in flight, select is disabled; on RPC error, previous value stays selected and inline alert renders; selecting again retries cleanly and clears the alert.                                                                                                                                                                                                                              | AC4 — `projects-settings.spec.ts` (`"surfaces inline error when project isolation save fails and recovers on retry"`)                                                                                             |
| **T-S9: Round-trip target switch (`A → manual → B → A` and `H1 → manual → H2 → H1`) on `NewWorkspaceScreen` and `ScheduleFormSheet`** | Switching project or host clears `manualIsolation` / `userModified.isolation` in state on the transition out of `A`/`H1`, so returning to `A`/`H1` resolves `A`'s `defaultIsolation` instead of resurrecting the discarded override.                                                                                                                                                          | AC6, AC7, AC8 — `new-workspace/isolation.test.ts`, `schedule-form-model.test.ts`, `new-workspace-isolation-memory.spec.ts`, `new-workspace-host-project-preservation.spec.ts`, `schedules-project-target.spec.ts` |
| **T-S10: Provisional route hydration on `/new?serverId=...&projectId=...`**                                                           | Before directory hydration completes (`worktreeSupport === "unknown"`), `manualIsolation` stays `null` for the route's `(serverId, projectId)` target; once `SessionStore` hydrates the project descriptor (keeping the same logical target identity), `isolation` derives live from `projectDefaultIsolation` without resetting a manual pick made on that same target or racing `useState`. | AC5 — `new-workspace/isolation.test.ts` (`"adopts hydrated projectDefaultIsolation when provisional route resolves"`)                                                                                             |

### Decisions

- **D1 — Authoritative per-project default, not server-side lock.** `Ruling: Model project isolation as nullable ProjectIsolation ("local" | "worktree" | null) that governs default workspace initialization when isolation is not explicitly overridden, while honoring explicit overrides in App, Schedule form, CLI, MCP, and SDK — satisfies "always create new workspaces Local or New worktree" by eliminating FormPreferences cross-project bleed without breaking explicit worktree/local automation such as e2e-feature, PR checkouts, or one-off sessions — cost if wrong: if hard enforcement were ever desired later, an opt-in lock policy would be additive.`
- **D2 — Persist in daemon `$PASEO_HOME/projects/projects.json` rather than `<repoRoot>/paseo.json` or client `AsyncStorage`.** `Ruling: Store defaultIsolation on PersistedProjectRecord in projects.json and project it over directory-sync — avoids dirtying clean/third-party Git checkouts, works when paseo.json is absent or malformed, syncs across all clients/CLI/MCP on that host, and makes project defaults synchronously available to NewWorkspaceScreen and ScheduleFormSheet — cost if wrong: repository-committed defaults shared via git clone are not automatic.`
- **D3 — Host-local project authority across multi-host groupings.** `Ruling: Scope defaultIsolation per (serverId, projectId) placement rather than merging across projectKey — matches customName, customIconRevision, and docs/data-model.md while letting workstation vs remote dispatch hosts choose different defaults for the same repository — cost if wrong: users with two hosts set each host's placement independently.`
- **D4 — Clear manual override on target transition (`A → B → A`) and preserve `FormPreferences.isolation` for unpinned projects.** `Ruling: Clear in-screen manual isolation state whenever the active (serverId, projectId) target changes so A → B → A and H1 → H2 → H1 never resurrect a discarded override, and write FormPreferences.isolation only when defaultIsolation === null — prevents stale override resurrection and prevents one-off overrides on pinned projects from polluting unpinned ("Remember last") projects — cost if wrong: none.`
- **D5 — Dotted RPC `project.isolation.set.request`/`.response` with no host feature gate.** `Ruling: Add pure Zod schemas ProjectIsolationSetRequestSchema / ProjectIsolationSetResponseSchema and optional projectDefaultIsolation on project and workspace descriptors without a server_info.features flag, per AGENTS.md and docs/protocol-compatibility.md — old clients ignore optional fields, new clients normalize absent fields to null, and errors against outdated daemons surface inline — cost if wrong: against an un-updated daemon, attempting to save shows an explicit RPC error rather than hiding the control.`
- **D6 — Immediate-save `<SettingsSelect>` above `paseo.json` on `ProjectSettingsScreen`.** `Ruling: Place Workspaces → New workspace isolation in ProjectSettingsBody above paseo.json renderContent using SettingsGroup + SettingsCard + SettingsSelect (Remember last / Local / New worktree), hidden when projectKind !== "git" — matches ChatSection/OpenLocationSection 3-option select conventions, avoids 390pt mobile locale truncation, decouples daemon registry saves from paseo.json file saves, and follows docs/forms.md availability hierarchy — cost if wrong: none.`
- **D7 — Optional `isolation` on `paseo workspace create` and MCP `create_workspace`, required option value retained on `paseo run --new-workspace`, explicit `source` retained on SDK `workspaces.create`.** `Ruling: Allow omitting --isolation on paseo workspace create and isolation on MCP create_workspace so CLI/agent callers inherit project defaultIsolation ?? "local"; keep --new-workspace <local|worktree> required-arg on paseo run to avoid Commander positional [prompt] ambiguity; keep SDK workspaces.create({ source }) explicitly discriminated while adding client.projects.setIsolation — preserves 100% caller compatibility across CLI, MCP, and SDK — cost if wrong: SDK callers wanting project-default behavior read project.projectDefaultIsolation from client.projects.list().`
- **D8 — Single end-to-end implementation task `T1`.** `Ruling: Keep implementation, wiring, unit/integration/E2E tests, and documentation in one task T1 — the protocol, daemon, client, CLI, app, and desktop E2E changes form one sequential vertical slice (protocol → client → server/cli/app/desktop), so splitting by layer is disallowed under e2e-feature workflow layout rules — cost if wrong: if worker hits context pressure, orchestrator can split only on a qualifying reason.`

### Required documentation items

- **DOC1 — `docs/data-model.md` (§4 Project Registry):** Add `defaultIsolation` (`"local" | "worktree" | null`) to the `$PASEO_HOME/projects/projects.json` field table, noting that `null` defers to caller/client defaults and Git reconciliation preserves the stored value across `.git` changes. Evidence: review diff check.
- **DOC2 — `docs/glossary.md` (**Isolation** entry):** Update the **Isolation** definition to state that a project may configure a host-local `defaultIsolation` (`"local" | "worktree" | null` in `projects.json`) that takes precedence over global `FormPreferences.isolation` when creating workspaces unless explicitly overridden. Evidence: review diff check.
- **DOC3 — `docs/features/project-isolation-plan.md`:** This plan file, committed on the feature branch. Evidence: git commit & review trace.

### Human input, approval, and environment gates

- **Human input / design approval required:** No. Requirements and architectural boundaries are settled unambiguously by Paseo's existing `ProjectRegistry`, directory-sync, settings primitives, and `AGENTS.md` rules, and the user did not request a design approval round. Handoff status: `finalized autonomously; human input/approval not required`.
- **Gate resolutions during design:**
  1. **Visible Design tab gate:** Resolved (`DESIGN_TAB_OPEN` confirmed on `srv_oL-TqdtgNZhB`, `ParentAgentId: null`, workspace `wks_f0e57523021e8d2e`).
  2. **Artifact side effect:** Authorized by user request; published as `c1ba9a46-3405-4775-84f9-4316bab66245` (revision 1) with receipt saved at `<run dir>/artifact-receipt.json`.
- **Execution-phase external provisioning gate (`G-ANDROID`):**
  - Host inspection confirmed Nix `electron-unwrapped-43.8.3` is already present in `/nix/store` for real Linux Electron E2E (`e2e-electron`), whereas Android `adb`, `emulator`, Android 35 system image / NDK / CMake, SDK license acceptance, and `agent-device` are **not** pre-installed in the worktree (`e2e-android`).
  - Per `/skill:e2e-feature` (_software installation and SDK licenses require approval_), do **not** download Android SDK packages, accept Google SDK licenses, or install `agent-device` (nor auto-download Electron 44.2.0) without resolving **Gate `G-ANDROID`** with the user during E2E setup if no pre-provisioned isolated Android environment exists. Compact Chromium (`390×844`) is **never** labeled or accepted as Android native proof.

---

## Design

### Data flow

```text
ProjectSettingsScreen (SettingsSelect: Remember last | Local | New worktree)
  │  or CLI: paseo project isolation <projectId> [local|worktree|--reset]
  │  or SDK: client.projects.setIsolation(projectId, defaultIsolation)
  ▼
DaemonClient.setProjectIsolation(projectId, defaultIsolation)
  ──► WS: project.isolation.set.request { projectId, defaultIsolation, requestId }
        ▼
      Session.handleProjectIsolationSetRequest (packages/server/src/server/session.ts)
        ├─ validates project exists & archivedAt === null
        ├─ validates !(defaultIsolation === "worktree" && project.kind !== "git")
        ├─ FileBackedProjectRegistry.update(projectId, ...) ──► atomic write to $PASEO_HOME/projects/projects.json
        ├─ emits project.isolation.set.response { accepted, projectId, defaultIsolation, error }
        └─ FileBackedProjectRegistry mutation listener + Session updates:
             ├─ project.update { kind: "upsert", project: { ..., projectDefaultIsolation } }
             └─ workspace_update { kind: "upsert", workspace: { ..., projectDefaultIsolation } }
                  ▼
Client WorkspaceDirectoryReplica + ReplicaCache + SessionStore
  ├─ ProjectDescriptor.projectDefaultIsolation: ProjectIsolation | null
  ├─ WorkspaceDescriptor.projectDefaultIsolation: ProjectIsolation | null
  ├─ WorkspaceStructureHostPlacement.defaultIsolation: ProjectIsolation | null
  └─ ProjectHostEntry.defaultIsolation: ProjectIsolation | null
        │
        ├──► NewWorkspaceScreen (packages/app/src/screens/new-workspace/isolation.ts)
        │      draftState.manualIsolation (cleared permanently on (serverId, projectId) transition)
        │        ?? projectDefaultIsolation
        │        ?? FormPreferences.isolation
        │        ?? "local"
        │      (clamped to "local" when !canCreateWorktree; FormPreferences written only when projectDefaultIsolation === null)
        │
        ├──► ScheduleFormSheet (packages/app/src/schedules/schedule-form-model.ts)
        │      create mode: manual (cleared on setProject/setHost) ?? target.defaultIsolation ?? FormPreferences.isolation ?? "local"
        │      edit mode:   schedule.target.config.isolation ?? "local"
        │
        ├──► CLI `paseo workspace create` (when --isolation omitted)
        │      explicit --isolation ?? (project.projectKind === "git" ? project.projectDefaultIsolation : null) ?? "local"
        │
        ├──► MCP `create_workspace` (when isolation omitted)
        │      explicit isolation ?? (project.kind === "git" ? project.defaultIsolation : null) ?? "local"
        │
        └──► SDK `client.workspaces.create({ source })`
               explicit discriminated `source` unchanged (always honored; no implicit default)
```

### Module boundaries and exact interfaces

#### 1. `packages/protocol` — Wire schemas and `zod-aot` validators

In `packages/protocol/src/messages.ts` (pure structural Zod schemas; no `.transform()`, `.catch()`, or `.preprocess()`):

```ts
export const ProjectIsolationSchema = z.enum(["local", "worktree"]);
export type ProjectIsolation = z.infer<typeof ProjectIsolationSchema>;

export const ProjectIsolationSetRequestSchema = z.object({
  type: z.literal("project.isolation.set.request"),
  projectId: z.string(),
  defaultIsolation: ProjectIsolationSchema.nullable(),
  requestId: z.string(),
});

export const ProjectIsolationSetResponsePayloadSchema = z.object({
  requestId: z.string(),
  projectId: z.string(),
  accepted: z.boolean(),
  defaultIsolation: ProjectIsolationSchema.nullable(),
  error: z.string().nullable(),
});

export const ProjectIsolationSetResponseSchema = z.object({
  type: z.literal("project.isolation.set.response"),
  payload: ProjectIsolationSetResponsePayloadSchema,
});

export type ProjectIsolationSetRequest = z.infer<typeof ProjectIsolationSetRequestSchema>;
export type ProjectIsolationSetResponsePayload = z.infer<
  typeof ProjectIsolationSetResponsePayloadSchema
>;
export type ProjectIsolationSetResponse = z.infer<typeof ProjectIsolationSetResponseSchema>;
```

Add to existing schemas in `packages/protocol/src/messages.ts`:

- `WorkspaceProjectDescriptorPayloadSchema`:
  ```ts
  // COMPAT(projectDefaultIsolation): added in v0.15.4, remove optional after 2027-05-14.
  projectDefaultIsolation: ProjectIsolationSchema.nullable().optional(),
  ```
- `WorkspaceDescriptorPayloadSchema`:
  ```ts
  // COMPAT(projectDefaultIsolation): added in v0.15.4, remove optional after 2027-05-14.
  projectDefaultIsolation: ProjectIsolationSchema.nullable().optional(),
  ```
- Register `ProjectIsolationSetRequestSchema` in `SessionInboundMessageSchema` and `ProjectIsolationSetResponseSchema` in `SessionOutboundMessageSchema`.

#### 2. `packages/server` — Persistence, session RPC, permissions, and MCP

- **`packages/server/src/server/workspace-registry.ts`**:
  Add to `PersistedProjectRecordSchema`:

  ```ts
  defaultIsolation: z
    .enum(["local", "worktree"])
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  ```

  Reconciliation in `WorkspaceReconciliationService` and `WorkspaceProvisioningService` spreads `...project`, preserving `defaultIsolation` across `.git` and remote updates.

- **`packages/server/src/server/authorization/operation-permissions.ts`**:
  - `INBOUND_PERMISSION`: `"project.isolation.set.request": "workspace.manage"`
  - `OUTBOUND_PERMISSION`: `"project.isolation.set.response": "workspace.manage"`

- **`packages/server/src/server/session.ts` & `packages/server/src/server/workspace-directory.ts`**:
  - Include `projectDefaultIsolation: project.defaultIsolation ?? null` in `Session.buildProjectDescriptor`, `Session.buildWorkspaceDescriptor`, `Session.describeCreatedWorktreeWorkspace`, and `WorkspaceDirectory.listEmptyProjects`.
  - Dispatch `"project.isolation.set.request"` in `Session.dispatchWorkspaceAndProjectMessage` to `handleProjectIsolationSetRequest`:
    - Serialize through `this.projectRegistry.update(projectId, ...)`:
      - Missing or `archivedAt !== null` → fail without writing (`accepted: false, defaultIsolation: null, error: "Project not found"`).
      - `defaultIsolation === "worktree" && existing.kind !== "git"` → fail without writing (`accepted: false, defaultIsolation: null, error: "Worktree isolation requires a Git project"`).
      - `existing.defaultIsolation === defaultIsolation` → return `existing` unchanged (skips disk write in `FileBackedRegistry.mutateCache`) and respond `{ requestId, projectId, accepted: true, defaultIsolation: existing.defaultIsolation, error: null }`.
      - Changed → persist `{ ...existing, defaultIsolation, updatedAt: new Date().toISOString() }`, respond `{ requestId, projectId, accepted: true, defaultIsolation, error: null }`, call `await this.emitProjectUpdate({ kind: "upsert", project: updated })`, and re-emit active workspace descriptors for `projectId` via `emitWorkspaceUpdatesForWorkspaceIds`.

- **`packages/server/src/server/agent/tools/paseo-tools.ts`** (`create_workspace` tool):
  - Change `isolation` input schema to `z.enum(["local", "worktree"]).optional().describe("Workspace isolation. Defaults to the project's configured default isolation, or local when unset.")`.
  - Extract pure helper:
    ```ts
    export async function resolveToolWorkspaceIsolation(input: {
      explicitIsolation: ProjectIsolation | undefined;
      projectId: string | undefined;
      path: string | undefined;
      resolveScopedCwd: (rawPath: string | undefined, opts: { required: boolean }) => string;
      projectRegistry: ProjectRegistry | undefined;
    }): Promise<ProjectIsolation>;
    ```
    When `explicitIsolation` is defined, return it immediately. Otherwise look up the active project in `projectRegistry` (by `projectId` if provided, else active record whose `rootPath` matches `resolveScopedCwd(path, { required: true })` via `areEquivalentPaths`), and return `project?.kind === "git" && project.defaultIsolation ? project.defaultIsolation : "local"`.

#### 3. `packages/client` — DaemonClient and SDK `PaseoApi`

- **`packages/client/src/daemon-client.ts`**:
  ```ts
  async setProjectIsolation(
    projectId: string,
    defaultIsolation: ProjectIsolation | null,
    requestId?: string,
  ): Promise<{ defaultIsolation: ProjectIsolation | null }> {
    const payload =
      await this.sendNamespacedCorrelatedSessionRequest<"project.isolation.set.response">({
        requestId,
        message: {
          type: "project.isolation.set.request",
          projectId,
          defaultIsolation,
        },
      });
    if (!payload.accepted) {
      throw new Error(payload.error ?? "setProjectIsolation rejected");
    }
    return { defaultIsolation: payload.defaultIsolation };
  }
  ```
- **`packages/client/src/index.ts`**:
  Add `setIsolation(projectId: string, defaultIsolation: ProjectIsolation | null, options?: { requestId?: string }): Promise<{ defaultIsolation: ProjectIsolation | null }>` to `PaseoProjectActions` (delegating to `daemonClient.setProjectIsolation(projectId, defaultIsolation, options?.requestId)`). Keep `PaseoWorkspaceActions.create(options: PaseoWorkspaceCreateOptions)` unchanged with required discriminated `source`.

#### 4. `packages/cli` — `paseo project isolation`, `paseo project ls`, and `paseo workspace create`

- **`packages/cli/src/commands/project/isolation.ts`** (new, registered in `packages/cli/src/commands/project/index.ts` as `isolation`):
  - Command: `paseo project isolation <project-id> [isolation] [--reset]` (`allowExcessArguments(false)`).
  - Pure parser:

    ```ts
    export type ProjectIsolationCommandIntent =
      | { kind: "get" }
      | { kind: "set"; defaultIsolation: ProjectIsolation | null };

    export function resolveProjectIsolationIntent(input: {
      isolation?: string;
      reset?: boolean;
    }): ProjectIsolationCommandIntent;
    ```

    - `reset: true` + `isolation !== undefined` → throws `CommandError` (`INVALID_OPTIONS`).
    - `reset: true` → `{ kind: "set", defaultIsolation: null }`.
    - `isolation === undefined` → `{ kind: "get" }` (queries `client.listProjects()`, throws `PROJECT_NOT_FOUND` if absent, returns `{ projectId, defaultIsolation: project.projectDefaultIsolation ?? null }`).
    - `isolation === "local" | "worktree"` → `{ kind: "set", defaultIsolation: isolation }`.
    - Any other value → throws `CommandError` (`INVALID_OPTIONS`).

- **`packages/cli/src/commands/project/shared.ts`**:
  Add `defaultIsolation: ProjectIsolation | null` to `ProjectRow` (mapped from `project.projectDefaultIsolation ?? null`) and `{ header: "ISOLATION", field: "defaultIsolation", width: 12, format: (v) => v ?? "-" }` on `projectSchema` so `--json` serializes `null | "local" | "worktree"` while human tables display `- | local | worktree`.
- **`packages/cli/src/commands/workspace/index.ts` & `create.ts`**:
  - Change `--isolation` in `workspace/index.ts` from `.requiredOption` to `.option("--isolation <local|worktree>", "Workspace isolation (default: project setting or local)")`.
  - Pure resolver in `workspace/create.ts`:
    ```ts
    export function resolveCliWorkspaceIsolation(input: {
      explicitIsolation: string | undefined;
      projectId: string | undefined;
      resolvedPath: string;
      projects: readonly WorkspaceProjectDescriptorPayload[];
    }): string;
    ```
    When `explicitIsolation !== undefined`, return it unchanged. When omitted, match active project by `projectId` (if provided) or lexical path equality (`path.resolve(project.projectRootPath) === path.resolve(resolvedPath)`), and return `project?.projectKind === "git" && project.projectDefaultIsolation ? project.projectDefaultIsolation : "local"`.

#### 5. `packages/app` — Store, replica, target-clearing New Workspace model, Schedule form, and Project Settings UI

- **Session store & replica (`packages/app/src/stores/session-store.ts`, `packages/app/src/runtime/replica-cache/index.ts`, `packages/app/src/runtime/directory-sync/index.ts`, `packages/app/src/runtime/directory-sync/workspace-replica.ts`)**:
  - Add `projectDefaultIsolation?: ProjectIsolation | null` to `WorkspaceDescriptor` and `projectDefaultIsolation: ProjectIsolation | null` to `ProjectDescriptor` (`normalizeProjectDescriptor` / `normalizeWorkspaceDescriptor` resolve `payload.projectDefaultIsolation ?? null`).
  - Add `projectDefaultIsolation: ProjectIsolationSchema.nullable().optional()` to `StoredProjectSchema` and `StoredWorkspaceSchema` in `replica-cache/index.ts` and serialize in `serializeProject` / `serializeWorkspace`.
  - Copy `projectDefaultIsolation: project.projectDefaultIsolation` onto attached workspaces in `WorkspaceDirectoryReplica` (`workspace-replica.ts`) when handling `project.update` (`kind: "upsert"`) and in `legacyProjectDescriptorFromWorkspace` (`directory-sync/index.ts`).

- **Project projections (`packages/app/src/projects/workspace-structure.ts`, `packages/app/src/projects/host-project-model.ts`, `packages/app/src/projects/host-projects.ts`, `packages/app/src/utils/projects.ts`)**:
  - `WorkspaceStructureHostPlacement`: add `defaultIsolation: ProjectIsolation | null`.
  - `host-project-model.ts` (re-exported from `host-projects.ts`):
    ```ts
    export function getDefaultIsolationForHostProject(input: {
      project: HostProjectListItem | null;
      serverId: string;
    }): ProjectIsolation | null;
    ```
  - `ProjectHostEntry` (`packages/app/src/utils/projects.ts`): add `projectKind: ProjectDescriptor["projectKind"]` and `defaultIsolation: ProjectIsolation | null`.

- **Pure target-clearing New Workspace isolation state machine (`packages/app/src/screens/new-workspace/isolation.ts` + `isolation.test.ts`)**:
  Keying by `(serverId, hostProjectId)` (falling back to `project.viewKey` only when `hostProjectId` is absent) keeps target identity stable across provisional-route → hydrated-project transitions (`hostProjectFromRoute` uses `["srv", "prj_1"]` viewKey whereas hydrated equivalence projects use `projectKey` viewKey, while `getHostProjectId(project, serverId)` is `"prj_1"` on both!), AND transitioning to any different `(serverId, hostProjectId)` permanently clears `manualIsolation` in state so `A → manual → B → A` and `H1 → manual → H2 → H1` never resurrect a stale manual pick:

  ```ts
  import type { ProjectIsolation } from "@getpaseo/protocol/messages";

  export interface WorkspaceIsolationDraftState {
    targetKey: string;
    manualIsolation: ProjectIsolation | null;
  }

  export type WorkspaceIsolationDraftAction =
    | { type: "target-changed"; targetKey: string }
    | { type: "manual-selected"; targetKey: string; value: ProjectIsolation };

  export interface ResolveWorkspaceIsolationInput {
    draft: WorkspaceIsolationDraftState;
    targetKey: string;
    projectDefaultIsolation: ProjectIsolation | null;
    preferredIsolation: ProjectIsolation | undefined;
    supportsMultiplicity: boolean;
    worktreeSupport: "supported" | "unsupported" | "unknown";
  }

  export interface ResolvedWorkspaceIsolation {
    nextDraft: WorkspaceIsolationDraftState;
    isolation: ProjectIsolation;
    effectiveIsolation: ProjectIsolation;
    canCreateWorktree: boolean;
    showRefPicker: boolean;
  }

  export function createIsolationTargetKey(input: {
    serverId: string;
    hostProjectId: string | null;
    projectViewKey: string | null | undefined;
  }): string;

  export function createWorkspaceIsolationDraftState(
    targetKey: string,
  ): WorkspaceIsolationDraftState;

  export function reduceWorkspaceIsolationDraftState(
    state: WorkspaceIsolationDraftState,
    action: WorkspaceIsolationDraftAction,
  ): WorkspaceIsolationDraftState;

  export function resolveWorkspaceIsolation(
    input: ResolveWorkspaceIsolationInput,
  ): ResolvedWorkspaceIsolation;

  export function shouldPersistGlobalIsolationPreference(input: {
    projectDefaultIsolation: ProjectIsolation | null;
  }): boolean;
  ```

  - When `input.draft.targetKey !== input.targetKey`, `resolveWorkspaceIsolation` produces `nextDraft = { targetKey: input.targetKey, manualIsolation: null }`. In `useWorkspaceIsolation` (`new-workspace-screen.tsx`), if `nextDraft !== draft`, call `setDraft(nextDraft)` synchronously during render (React's canonical state reset on prop/target change, zero `useEffect`) **and** dispatch `{ type: "target-changed", targetKey }` in `handleSelectProjectOption` / `handleSelectWorkspaceHost` so `draft.manualIsolation` is wiped in state the moment the user leaves `A` or `H1`.
  - When the user picks an isolation in `setIsolation(value)`, dispatch `{ type: "manual-selected", targetKey, value }` and call `updatePreferences({ isolation: value })` **only** when `shouldPersistGlobalIsolationPreference({ projectDefaultIsolation })` is `true` (`projectDefaultIsolation === null`).

- **Schedule form (`packages/app/src/schedules/schedule-project-targets.ts`, `packages/app/src/schedules/schedule-form-model.ts`, `packages/app/src/components/schedules/schedule-form-sheet.tsx`)**:
  - `ScheduleProjectTarget`: add `defaultIsolation: ProjectIsolation | null` and refine `isGit: host.projectKind === "git" || Boolean(host.gitRuntime)`.
  - `schedule-form-model.ts`:
    - In `create` mode, `resolveDefaultIsolationForTarget(target, preferences)` returns `target?.defaultIsolation ?? preferences?.isolation ?? "local"`.
    - In `setProject(optionId, display)`: when switching to a different `optionId`, set `userModified = { ...userModified, isolation: false }` and set `isolation: resolveDefaultIsolationForTarget(target, preferences)` so `A → manual → B → A` clears the manual override permanently.
    - In `setHost(serverId)`: when switching host, set `userModified = { ...userModified, isolation: false }` and reset `isolation: preferences?.isolation ?? "local"` until a project target on that host is selected.
    - In `applyProjectTargets` and `applyPreferences`: when `snapshot.mode === "create" && !userModified.isolation`, re-derive `isolation` via `resolveDefaultIsolationForTarget(currentTarget, preferences)`.
    - In `edit` mode: always seed and retain `config.isolation ?? "local"`.
  - `schedule-form-sheet.tsx`: in `updateSelectionPreferences`, update `FormPreferences.isolation` on submit only when the selected project target's `defaultIsolation === null`.

- **Project Settings UI (`packages/app/src/screens/project-settings-screen.tsx` + all 9 locale files in `packages/app/src/i18n/resources/{ar,en,es,fr,ja,ko,pt-BR,ru,zh-CN}.ts`)**:
  - Guard `if (!project || !selectedHost || !client || !canEdit || isHostGone)` at top of `ProjectSettingsScreen` so disconnect immediately renders `NoEditableTarget`.
  - In `ProjectSettingsBody`, above `renderContent(...)`, render `<ProjectWorkspacesGroup selectedHost={selectedHost} client={client} />` when `selectedHost.projectKind === "git"`:
    - `<SettingsGroup title={t("settings.project.workspaces.title")} info={t("settings.project.workspaces.info")} testID="project-workspaces-group">`
      - `<SettingsCard testID="project-isolation-card">`
        - `<SettingsSelect testID="project-isolation-row" label={t("settings.project.workspaces.defaultIsolation")} hint={t("settings.project.workspaces.defaultIsolationHint")} error={isolationError} value={selectedOptionValue} options={isolationOptions} disabled={setIsolationMutation.isPending} onValueChange={handleIsolationChange} />`
  - Add translated keys under `settings.project.workspaces` (`title`, `info`, `defaultIsolation`, `defaultIsolationHint`, `savedToast`, `options.rememberLast`) across all 9 locale files (never copy-pasting English into non-English locales so `resources.test.ts` passes). Never end any new `testID` on `ProjectSettingsScreen` with `"-callout"`.

---

## Tasks

Default single-task layout: all layers share one sequential build/type chain (`protocol` → `client` → `server`/`cli`/`app`/`desktop`), so one worker owns the complete vertical slice without handoff overhead. Consolidated feature review runs after `T1` and the host test gate pass.

### Wave 1

**T1 — End-to-end per-project workspace isolation across protocol, daemon, SDK/CLI/MCP, app, desktop Electron E2E, tests, and docs**

- **Goal:** Deliver `AC1`–`AC10`, `D1`–`D8`, `T-S1`–`T-S10`, and `DOC1`–`DOC3` end to end.
- **Owned files:**
  - `packages/protocol/src/messages.ts`
  - `packages/protocol/src/messages.workspaces.test.ts`
  - `packages/protocol/src/messages.wire-compat.test.ts`
  - `packages/protocol/tests/validation/ws-outbound.test.ts`
  - `packages/server/src/server/workspace-registry.ts`
  - `packages/server/src/server/workspace-registry.test.ts`
  - `packages/server/src/server/authorization/operation-permissions.ts`
  - `packages/server/src/server/session.ts`
  - `packages/server/src/server/workspace-directory.ts`
  - `packages/server/src/server/workspace-directory.test.ts`
  - `packages/server/src/server/session.workspaces.test.ts`
  - `packages/server/src/server/session.test.ts`
  - `packages/server/src/wire-compat.test.ts`
  - `packages/server/src/server/agent/tools/paseo-tools.ts`
  - `packages/server/src/server/workspace-create-worktree-source.e2e.test.ts`
  - `packages/client/src/daemon-client.ts`
  - `packages/client/src/daemon-client.test.ts`
  - `packages/client/src/index.ts`
  - `packages/client/src/index.test.ts`
  - `packages/cli/src/commands/project/isolation.ts` (new)
  - `packages/cli/src/commands/project/index.ts`
  - `packages/cli/src/commands/project/shared.ts`
  - `packages/cli/src/commands/project/project.test.ts`
  - `packages/cli/src/commands/workspace/index.ts`
  - `packages/cli/src/commands/workspace/create.ts`
  - `packages/cli/src/commands/workspace/create.test.ts`
  - `packages/app/src/stores/session-store.ts`
  - `packages/app/src/stores/session-store-hooks/selectors.test.ts`
  - `packages/app/src/runtime/replica-cache/index.ts`
  - `packages/app/src/runtime/replica-cache/index.test.ts`
  - `packages/app/src/runtime/directory-sync/index.ts`
  - `packages/app/src/runtime/directory-sync/workspace-replica.ts`
  - `packages/app/src/runtime/directory-sync/workspace-replica.test.ts`
  - `packages/app/src/projects/workspace-structure.ts`
  - `packages/app/src/projects/workspace-structure.test.ts`
  - `packages/app/src/projects/host-project-model.ts`
  - `packages/app/src/projects/host-projects.ts`
  - `packages/app/src/projects/host-projects.test.ts`
  - `packages/app/src/utils/projects.ts`
  - `packages/app/src/utils/projects.test.ts`
  - `packages/app/src/screens/new-workspace/isolation.ts` (new)
  - `packages/app/src/screens/new-workspace/isolation.test.ts` (new)
  - `packages/app/src/screens/new-workspace-screen.tsx`
  - `packages/app/src/schedules/schedule-project-targets.ts`
  - `packages/app/src/schedules/schedule-project-targets.test.ts`
  - `packages/app/src/schedules/schedule-form-model.ts`
  - `packages/app/src/schedules/schedule-form-model.test.ts`
  - `packages/app/src/components/schedules/schedule-form-sheet.tsx`
  - `packages/app/src/screens/project-settings-screen.tsx`
  - `packages/app/src/i18n/resources/{ar,en,es,fr,ja,ko,pt-BR,ru,zh-CN}.ts`
  - `packages/app/src/i18n/resources.test.ts`
  - `packages/app/e2e/support/helpers/project-settings.ts`
  - `packages/app/e2e/support/helpers/new-workspace.ts`
  - `packages/app/e2e/browser/projects-settings.spec.ts`
  - `packages/app/e2e/browser/new-workspace-isolation-memory.spec.ts`
  - `packages/app/e2e/browser/new-workspace-host-project-preservation.spec.ts`
  - `packages/app/e2e/browser/new-workspace-launch-terminal.spec.ts`
  - `packages/app/e2e/browser/schedules-project-target.spec.ts`
  - `packages/desktop/e2e/project-isolation.electron.mjs` (new)
  - `packages/desktop/e2e/browser-tabs.e2e.mjs`
  - `docs/data-model.md`
  - `docs/glossary.md`
  - Any direct TypeScript/test call site requiring the added `ProjectDescriptor` / `ProjectRow` fields revealed by `npm run typecheck`.
- **Consumes:** Existing `FileBackedProjectRegistry`, `Session` directory-sync pipeline, `SettingsGroup`/`SettingsCard`/`SettingsSelect`, `NewWorkspaceScreen`, `ScheduleFormModel`/`ScheduleFormSheet`, app Playwright harness, and `packages/desktop/e2e/browser-tabs.e2e.mjs` Electron harness.
- **Produces:** All interfaces specified in §Design above (`ProjectIsolationSchema`, `ProjectIsolationSetRequestSchema`/`ResponseSchema`, `DaemonClient.setProjectIsolation`, `PaseoProjectActions.setIsolation`, `paseo project isolation`, `resolveToolWorkspaceIsolation`, `resolveCliWorkspaceIsolation`, `reduceWorkspaceIsolationDraftState`/`resolveWorkspaceIsolation`, `ProjectSettingsScreen` `Workspaces` group, and `runProjectIsolationRegression` Electron E2E module).
- **Dependencies:** none.
- **Unit test command:**
  ```bash
  npm run build:server && npm run build:app-deps && (cd packages/protocol && npx vitest run src/messages.workspaces.test.ts src/messages.wire-compat.test.ts tests/validation/ws-outbound.test.ts --bail=1) && (cd packages/client && npx vitest run src/daemon-client.test.ts src/index.test.ts --bail=1) && (cd packages/server && npx vitest run --config vitest.config.ts src/server/workspace-registry.test.ts src/server/workspace-directory.test.ts src/server/session.workspaces.test.ts src/server/session.test.ts src/wire-compat.test.ts src/server/workspace-create-worktree-source.e2e.test.ts --bail=1) && (cd packages/cli && npx vitest run src/commands/project/project.test.ts src/commands/workspace/create.test.ts --bail=1) && (cd packages/app && npx vitest run --config vitest.config.ts --project unit src/screens/new-workspace/isolation.test.ts src/projects/host-projects.test.ts src/projects/workspace-structure.test.ts src/utils/projects.test.ts src/stores/session-store-hooks/selectors.test.ts src/runtime/directory-sync/workspace-replica.test.ts src/runtime/replica-cache/index.test.ts src/schedules/schedule-project-targets.test.ts src/schedules/schedule-form-model.test.ts src/i18n/resources.test.ts --bail=1)
  ```

---

## Test and verification

### Protected boundaries and environment rules

- **NEVER** restart, stop, or connect tests to the live main Paseo daemon on port `6767`, `~/.paseo`, or `/home/sinkerine/dev/paseo`, nor touch existing shared ADB (`5037`) / Metro (`8081` / `8093`) / emulator instances.
- **NEVER** run `npm run test` across an entire workspace or the monorepo. Run only the targeted test files below with `--bail=1`.
- **Two test categories only (`docs/testing.md`):** pure ports-and-adapters / model unit tests (zero `vi.mock` of app code, zero JSDOM, zero `@testing-library` component mounts) and real isolated daemon / Playwright browser / real Electron / native Android E2E tests.
- **Generated inputs & consumer build order (`docs/development.md`, `docs/protocol-validation.md`):**
  - Workspace packages consume compiled `dist/` outputs from sibling workspaces. After editing `packages/protocol` or `packages/client`, **always** run `npm run build:server && npm run build:app-deps` before running downstream `server`, `cli`, `app`, or `desktop` checks.
  - `packages/protocol` `prebuild` / `pretypecheck` / `pretest` runs `node scripts/generate-validation-aot.mjs`, updating gitignored `packages/protocol/codegen/generated/ws-outbound.compile.ts`, `packages/protocol/src/generated/validation/ws-outbound.aot.ts`, and `ws-outbound-schema-metadata.ts`.
  - Commands that rewrite tracked files (`npm run format:files -- <paths>`) run only during worker editing before fingerprinting host verification receipts, never inside a verification check.

### Consumer packages inventory

Changed interfaces in `@getpaseo/protocol` (`WorkspaceProjectDescriptorPayload`, `WorkspaceDescriptorPayload`, `ProjectIsolationSet*`) and `@getpaseo/client` (`DaemonClient.setProjectIsolation`, `PaseoProjectActions.setIsolation`) are consumed by:

1. `@getpaseo/server` and `@getpaseo/cli` → built via `npm run build:server`, typechecked via `npm run typecheck`.
2. `@getpaseo/plugin` and `@getpaseo/expo-two-way-audio` → built via `npm run build:app-deps`, typechecked via `npm run typecheck`.
3. `@getpaseo/app` (web export + Electron-platform web export) → built via `npm run build:web --workspace=@getpaseo/app` (`packages/app/dist`) and `PASEO_WEB_PLATFORM=electron npx expo export --platform web --output-dir ../../.dev/electron-web-dist`, typechecked via `npm run typecheck`.
4. `@getpaseo/desktop` (Electron main + preload + embedded daemon/CLI integration) → built via `npm run build:main --workspace=@getpaseo/desktop` (`packages/desktop/dist`), typechecked via `npm run typecheck`.
5. `@getpaseo/relay`, `@getpaseo/highlight`, `@getpaseo/website`, `@getpaseo/builtin-plugins` → typechecked via root `npm run typecheck`.

### Resource groups and verification check inventory

Serialize all builds, codegen, consumer exports, browser Playwright runs, and Electron E2E runs under `/home/sinkerine/dev/paseo/.git/worktrees/sour-blobfish/e2e-feature-build.lock` (`max_parallel: 1`; `build-dist`, `browser-e2e`, and `electron-e2e` each `limit: 1`). Run browser and Electron checks inside `nix develop --command ...` so Chromium and Xvfb runtime libraries resolve from the flake devShell.

| Check ID                         | Phase   | Needs                            | Resources      | Exact command                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Mutates / generates                                                               | Proves                                                                                                                                                                                                                                                            |
| -------------------------------- | ------- | -------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke`                          | `smoke` | —                                | `build-dist`   | `node --version && npm --version && test -d node_modules && test -x /nix/store/ymncbmjz7cmphkxxgl4yan6mrwfvxgsl-electron-unwrapped-43.8.3/libexec/electron && git rev-parse --show-toplevel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | None                                                                              | Toolchain (`Node v24`, `npm 11`), worktree isolation, installed `node_modules`, Nix Electron binary presence                                                                                                                                                      |
| `build-workspaces`               | `task`  | `smoke`                          | `build-dist`   | `npm run build:server && npm run build:app-deps`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Gitignored `packages/*/dist` + `packages/protocol/src/generated/validation/*`     | Clean `zod-aot` validator codegen and compiled `dist/` declarations for server, CLI, client, plugin, and app dependencies                                                                                                                                         |
| `T1`                             | `task`  | `build-workspaces`               | `build-dist`   | `(cd packages/protocol && npx vitest run src/messages.workspaces.test.ts src/messages.wire-compat.test.ts tests/validation/ws-outbound.test.ts --bail=1) && (cd packages/client && npx vitest run src/daemon-client.test.ts src/index.test.ts --bail=1) && (cd packages/server && npx vitest run --config vitest.config.ts src/server/workspace-registry.test.ts src/server/workspace-directory.test.ts src/server/session.workspaces.test.ts src/server/session.test.ts src/wire-compat.test.ts src/server/workspace-create-worktree-source.e2e.test.ts --bail=1) && (cd packages/cli && npx vitest run src/commands/project/project.test.ts src/commands/workspace/create.test.ts --bail=1) && (cd packages/app && npx vitest run --config vitest.config.ts --project unit src/screens/new-workspace/isolation.test.ts src/projects/host-projects.test.ts src/projects/workspace-structure.test.ts src/utils/projects.test.ts src/stores/session-store-hooks/selectors.test.ts src/runtime/directory-sync/workspace-replica.test.ts src/runtime/replica-cache/index.test.ts src/schedules/schedule-project-targets.test.ts src/schedules/schedule-form-model.test.ts src/i18n/resources.test.ts --bail=1)` | Ephemeral `/tmp` test dirs only                                                   | All unit + isolated daemon/MCP/SDK integration tests for `AC1`–`AC10` and `T-S1`–`T-S10` (every test file in `T1` owned files)                                                                                                                                    |
| `consumers-build-typecheck-lint` | `full`  | `build-workspaces`               | `build-dist`   | `npm run build:web --workspace=@getpaseo/app && (cd packages/app && npx cross-env PASEO_WEB_PLATFORM=electron npx expo export --platform web --output-dir ../../.dev/electron-web-dist) && npm run build:main --workspace=@getpaseo/desktop && npm run typecheck && npm run lint && npm run format:check && bash scripts/update-nix.sh --check`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Gitignored `packages/app/dist`, `.dev/electron-web-dist`, `packages/desktop/dist` | **Consumer build + typecheck**: builds and typechecks every consuming package/bundle (`server`, `cli`, `client`, `app` web, `app` electron renderer, `desktop` main, `plugin`, `website`) + `oxlint` + `oxfmt` + Nix hash check                                   |
| `e2e-browser`                    | `e2e`   | `build-workspaces`               | `browser-e2e`  | `nix develop --command npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/projects-settings.spec.ts e2e/browser/new-workspace-isolation-memory.spec.ts e2e/browser/new-workspace-host-project-preservation.spec.ts e2e/browser/new-workspace-launch-terminal.spec.ts e2e/browser/schedules-project-target.spec.ts --project=browser --workers=1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Disposable `/tmp` daemon homes, repos, worktrees, Playwright traces               | Full browser E2E across wide (`1280×720`) and compact mobile-web (`390×844`) layouts, all `/new` entry & submit variants, `A → B → A` switch clearing, multi-host (`H1 → H2 → H1`), `ScheduleFormSheet`, RPC failure/retry, and `paseo.json` corruption isolation |
| `e2e-electron`                   | `e2e`   | `consumers-build-typecheck-lint` | `electron-e2e` | `PASEO_DESKTOP_PROJECT_ISOLATION_ONLY=1 PASEO_DESKTOP_BROWSER_E2E_ARTIFACT_DIR="$PWD/artifacts/project-isolation/electron" ELECTRON_OVERRIDE_DIST_PATH=/nix/store/ymncbmjz7cmphkxxgl4yan6mrwfvxgsl-electron-unwrapped-43.8.3/libexec/electron nix develop --command npm run test:e2e:browser-tabs --workspace=@getpaseo/desktop`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `artifacts/project-isolation/electron/{result.json,*.png,*.log}` (gitignored)     | Real Linux Electron window + Xvfb + isolated daemon + Metro proving `ProjectSettingsScreen`, `Ctrl+N` (`workspace.new`), sidebar `+`, and `Local` vs `New worktree` creation in real Electron                                                                     |

_(Coverage note: this repository has no separate Istanbul/v8 coverage script; `T1` + `consumers-build-typecheck-lint` + `e2e-browser` + `e2e-electron` + gated `e2e-android` constitute full verification.)_

### Two-stage capability checks and platform matrix (`docs/qa.md`)

1. **Stage 1 — Cheap host check (completed during design in `<run dir>/smoke.txt` + host binary probe):**
   - Verified `22.3 GiB` available RAM, `226 GiB` free disk, `Node v24.21.0`, `npm 11.19.0`, `DISPLAY` present, `node_modules` present, `/nix/store/ymncbmjz7cmphkxxgl4yan6mrwfvxgsl-electron-unwrapped-43.8.3/libexec/electron` present, `/nix/store/rx2gmv09cbbmvhjg60f8ap8jl1cll8cm-android-sdk-env/share/android-sdk` read-only bootstrap present, and `adb` / `emulator` / `agent-device` absent from unprovisioned `PATH`.

2. **Stage 2 — Representative executable capability probes (run by `T1` worker BEFORE substantial implementation on each runnable target):**
   - **Target A — App Browser Playwright (`e2e-browser`):**
     - Run `npm run build:server && npm run build:app-deps && nix develop --command npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/new-workspace-isolation-memory.spec.ts --project=browser --workers=1`.
     - _Real entry, readiness, action, observation:_ `gotoAppShell` → `waitForSidebarHydration` → sidebar `+` → `/new` (`workspace-create-isolation-trigger` visible) → select `New worktree` + branch → click `Create` → observe `/h/<serverId>/workspace/<wks_id>` redirect and `client.fetchWorkspaces()` worktree path. Baseline passes for global memory; added per-project assertion fails deterministically on baseline (`project-isolation-row` missing).
   - **Target B — Real Linux Electron (`e2e-electron`):**
     - Run `PASEO_DESKTOP_SETTINGS_MEMORY_ONLY=1 PASEO_DESKTOP_BROWSER_E2E_ARTIFACT_DIR="$PWD/artifacts/project-isolation/electron-probe" ELECTRON_OVERRIDE_DIST_PATH=/nix/store/ymncbmjz7cmphkxxgl4yan6mrwfvxgsl-electron-unwrapped-43.8.3/libexec/electron nix develop --command npm run test:e2e:browser-tabs --workspace=@getpaseo/desktop`.
     - _Real entry, readiness, action, observation:_ spawns isolated daemon + Metro + Xvfb + real Electron `BrowserWindow`, connects over CDP, navigates real `Settings → Projects`, and writes `result.json` + logs. (Record runtime difference: Nix store Electron `43.8.3` vs repo `44.2.0`; do not auto-download `44.2.0`.)
   - **Target C — Native Android (`e2e-android`, subject to Gate `G-ANDROID`):**
     - Compact Chromium (`390×844`) proves **compact mobile-web layout only**, NOT native Android (`Modal`-backed `DropdownMenu`, touch hit targets, native SQLite `replica-cache`).
     - Before running Android provisioning, check whether an isolated SDK/AVD already exists; if not, escalate **Gate `G-ANDROID`** to the user for authorization to accept SDK licenses, install `platforms;android-36`, `build-tools;36.0.0`, `ndk;27.1.12297006`, `cmake;3.30.5`, `system-images;android-35;google_apis;x86_64`, and local `agent-device` under `$PWD/.dev/android-e2e` (adapt the repository's isolated Android recipe to this run: allocate unused daemon, Metro, ADB, and emulator ports and record them before launch; never connect to or stop existing shared services on `6793`, `8093`, `5037`, or `5047`. Use an owned emulator with 6 GiB RAM, CMake Ninja job pools `paseo_compile=2;paseo_link=1`, isolated `AGENT_DEVICE_STATE_DIR` + `AGENT_DEVICE_CLAIMS_DIR` + process-local bind for `~/.agent-device`, and a single `VIEW` cold launch).
     - When `G-ANDROID` is authorized, run a native capability probe against the unchanged baseline (cold launch → connect to this run's owned isolated daemon → open `Settings → Projects → [Project]` and `/new` from the sidebar → use the existing isolation picker to create a worktree → observe the new workspace through native snapshots and the daemon API). The new `project-isolation-row` may be absent before implementation; record that as the expected feature failure. After implementation, set `New worktree` in Project Settings, reopen `/new`, verify `New worktree` is selected and tap `Create`; save native snapshots and screenshots under `artifacts/project-isolation/android/`. If the user declines `G-ANDROID` for initial feature work, record the explicit user exemption in `<run dir>/rulings.md` and `<run dir>/verification.md` (noting that default-branch merge policy still requires Android verification unless waived by the user).
   - **Platform coverage matrix (`docs/qa.md`):**
     - **Web (wide & compact 390×844):** Automated (`e2e-browser`).
     - **Desktop Linux (real Electron):** Automated (`e2e-electron`).
     - **Android:** Automated native run under `G-ANDROID` (`e2e-android`), or explicit user-approved gate status recorded — never substituted by compact browser emulation.
     - **iOS / Desktop macOS / Desktop Windows:** Not runnable on Linux `x86_64` host (`kazuki`); documented in verification report and covered by cross-platform shared primitives + CI typecheck/builds.

---

## E2E journey

1. **Configure project default via both Project Settings entry paths (`AC1`):**
   - Seed two Git repositories (`alpha`, `beta`), one unpinned Git repository (`gamma`), and one non-Git directory project (`notes`) on the isolated daemon.
   - Enter `alpha`'s `ProjectSettingsScreen` via **Sidebar project row → kebab (`⋮`) → `Open project settings`**. Verify `Workspaces` → `New workspace isolation` shows `Remember last`. Select `New worktree`.
   - **Expected:** Toast `"Workspace isolation updated"` appears; `<alpha>/paseo.json` is not created/modified; `"Commit paseo.json changes"` warning is absent; reloading the page persists `New worktree`.
   - Enter `beta`'s `ProjectSettingsScreen` via **`Settings → Projects → Edit beta`** (tested on both `1280×720` desktop and `390×844` compact mobile-web navigation) and select `Local`.
   - **Expected:** Toast `"Workspace isolation updated"` appears; `client.listProjects()` reports `projectDefaultIsolation: "worktree"` for `alpha`, `"local"` for `beta`, and `null` for `gamma`.

2. **All `/new` entry paths honor project `defaultIsolation` without cross-project bleed (`AC5`):**
   - Seed global `FormPreferences.isolation = "local"` by picking `Local` on unpinned `gamma`.
   - Verify `alpha` (`defaultIsolation: "worktree"`) opens `/new` with `Workspace isolation = New worktree` and `Starting ref` visible across **each** entry path:
     - (a) Sidebar project row `+` icon (`sidebar-project-new-worktree-*`);
     - (b) Sidebar project `+ New workspace` ghost row (`sidebar-project-new-workspace-row-*` after archiving `alpha`'s initial workspace so `alpha` is an empty project);
     - (c) Post-Add-Project navigation (`openAddProjectFlow` → `directory-search` on `alpha`'s path → Enter → lands on `/new`);
     - (d) Sidebar header `New workspace` (`sidebar-global-new-workspace`) while a workspace in `alpha` is active;
     - (e) Command Center `New workspace` (`Ctrl+K` → click `New workspace`, dispatching `workspace.new`) while a workspace in `alpha` is active;
     - (f) Opening `/new` on `beta` (`Workspace isolation = Local`, `Starting ref` hidden) and switching `new-workspace-project-picker-trigger` to `alpha` (`Workspace isolation` flips to `New worktree`).

3. **All `/new` submit variants create the configured workspace kind (`AC5`):**
   - **3a — Empty workspace submit:** On `alpha` (`New worktree`), leave composer empty and click `Create` → asserts new `worktree` workspace under `$PASEO_HOME/worktrees/...`. On `beta` (`Local`), leave composer empty and click `Create` → asserts new `local_checkout` workspace at `beta`'s root path.
   - **3b — Chat agent submit:** On `alpha` (`New worktree`), enter a prompt with a seeded mock model and click `Create` → asserts new `worktree` workspace with initial agent spawned in that worktree directory.
   - **3c — Terminal profile submit (`new-workspace-launch-terminal.spec.ts`):** Configure project `defaultIsolation: "worktree"`, open `/new`, select `BARE_PROFILE` (`Terminal`), and click `Launch` → asserts workspace opens with terminal tab backed by a new Git `worktree` (`workspaceKind === "worktree"`); switch project `defaultIsolation` to `"local"` and repeat → asserts terminal launches in `local_checkout` (`workspaceDirectory === repoPath`).

4. **One-off manual override clears on `A → B → A` switch and preserves project default + global preference (`AC6`, `T-S9`):**
   - Ensure unpinned `gamma` has remembered `FormPreferences.isolation === "worktree"`.
   - Open `/new` on `beta` (`defaultIsolation: "local"` → shows `Local`). Manually change `Workspace isolation` to `New worktree`.
   - **Round-trip switch check (`beta → alpha → beta`):** Without submitting, switch Project picker from `beta` to `alpha`, then immediately back to `beta`.
   - **Expected:** `beta` shows `Local` (the manual `"worktree"` override was cleared when leaving `beta`, never resurrected on return!).
   - Now on `alpha` (`defaultIsolation: "worktree"`), manually pick `Local` and click `Create` for a one-off local workspace.
   - **Expected:** That single workspace is created as `local_checkout`; reopening `/new` on `alpha` starts at `New worktree` again (`alpha`'s `defaultIsolation` untouched); switching Project picker to unpinned `gamma` still shows `New worktree` (the one-off `"local"` override on pinned `alpha` did **not** clobber `gamma`'s global `FormPreferences.isolation`!).

5. **Non-Git project hides isolation across Settings, `/new`, and Schedules (`AC3`):**
   - Open `ProjectSettingsScreen` for `notes` (`non_git`) → `project-isolation-card` has count `0`.
   - Open `/new` and select `notes` → `workspace-create-isolation-trigger` has count `0`, and at `390×844` compact viewport the composer vertical offset stays unchanged.
   - Open `ScheduleFormSheet` on `/schedules` and select `notes` → `schedule-isolation-trigger` has count `0`.

6. **Corrupt `paseo.json` isolation (`AC2`):**
   - Corrupt `<alpha>/paseo.json` with `{not valid json}` and open `alpha`'s `ProjectSettingsScreen`.
   - **Expected:** `invalid-callout` is visible and `Worktree setup commands` is hidden, while `New workspace isolation` remains visible, updates to `Local`, persists, and updates back to `New worktree`.

7. **Pending lock, RPC failure, and inline retry recovery (`AC4`, `T-S8`):**
   - Intercept `project.isolation.set.request` on the page WebSocket: first hold the response to verify the `New workspace isolation` trigger is disabled while pending, then reply with `{ accepted: false, defaultIsolation: null, error: "Disk full" }`.
   - **Expected:** Trigger re-enables with `New worktree` still selected and renders `"Disk full"` inside `project-isolation-row` (`role="alert"`). Remove interception and select `Local` → inline alert disappears, toast `"Workspace isolation updated"` shows, and `Local` persists.

8. **Multi-host placement isolation and `H1 → manual → H2 → H1` switch (`AC7`, `T-S9`):**
   - In `new-workspace-host-project-preservation.spec.ts`, with Primary host and Secondary `startIsolatedHostDaemon` sharing `SHARED_REMOTE_URL` (`projectKey`), set Primary host's project `defaultIsolation` to `"local"` and Secondary host's to `"worktree"`.
   - Open `/new` on Primary host (`Local`), manually override to `New worktree`, switch `Host` picker to Secondary host (`New worktree`), then switch `Host` picker back to Primary host.
   - **Expected:** Primary host shows `Local` (manual override cleared on host transition; each host resolves its own `projects.json` record).

9. **Schedule form (`ScheduleFormSheet`) end-to-end journey (`AC8`, `T-S9`):**
   - In `schedules-project-target.spec.ts`, seed Git projects `alpha` (`defaultIsolation: "worktree"`) and `beta` (`defaultIsolation: "local"`), with global `FormPreferences.isolation = "local"`.
   - Open `New schedule` on `/schedules`, select `alpha` → `schedule-isolation-trigger` shows `New worktree`. Manually pick `Local`, switch `schedule-project-trigger` to `beta` (`Local`), then switch back to `alpha` → `schedule-isolation-trigger` resets to `New worktree`.
   - Fill model, cadence, name, and prompt, and click `Create schedule` → `scheduleList()` confirms `target.config.isolation === "worktree"`, while global `FormPreferences.isolation` remains `"local"`.
   - Change `alpha`'s `defaultIsolation` to `"local"`, click the saved schedule to open `ScheduleFormSheet` in `edit` mode → `schedule-isolation-trigger` still shows `New worktree` (saved schedule config wins over later project default changes).

10. **Real Linux Electron desktop journey (`AC1`, `AC5`, `e2e-electron`):**
    - Run `packages/desktop/e2e/project-isolation.electron.mjs` inside `browser-tabs.e2e.mjs` against a real Electron `BrowserWindow`, Xvfb, Metro, and isolated daemon:
      - Navigate `Settings → Projects → [Project]`, set `New workspace isolation` to `New worktree`, assert `"Workspace isolation updated"` toast and persisted `projects.json`.
      - Return to workspace view, press `Ctrl+N` (`workspace.new` native Electron shortcut), assert `/new` opens with `Workspace isolation = New worktree`, click `Create`, and verify the created worktree workspace in the Electron sidebar and `artifacts/project-isolation/electron/result.json`.
