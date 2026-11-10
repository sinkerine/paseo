# Pi native session fork and clone — plan

Status: **approved by the user (2026-11-10)**. Branch `feat/pi-native-session-fork`, base `origin/main` `788bce64e`.

Two different actions share the assistant turn footer's Split menu after this change:

- **Fork session** (new, Pi only). Creates a new Pi agent backed by a new native Pi session file. The file holds the source's real Pi history up to a boundary: roles, tool calls, tool results, compaction entries, and extension entries. The new agent has its own Pi session id, file, and Paseo agent id, and continues independently.
- **Copy chat** (existing, every provider; formerly "Fork in a new tab/workspace"). Starts a draft with a `chat_history` attachment built by `agent.fork_context`. No provider session is branched.

## 0. Diagnosis record (established before design)

Each fact below cites the code or runtime output it came from. "Not established" marks what T1 must prove first.

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                           | Evidence                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Installed Desktop and daemon are `0.15.3-788bce6`, the same commit as this branch's base.                                                                                                                                                                                                                                                                                                                                                      | Orchestrator preflight; `git log -1` = `788bce64e`.                                                                                                                                                                                                  |
| F2  | The Split trigger renders only when `resolveAssistantTurnForkBoundary` returns a boundary and the view passes `onForkAssistantTurn` (not `readOnly`). A boundary needs the footer source item to be `assistant_message` with `messageId`, or `timelineCursor` together with `serverInfo.features.agentForkContextCursor`. Copy renders whenever the source item is `assistant_message`.                                                        | `packages/app/src/agent-stream/turn-boundary.ts:8-22`, `turn-footer.tsx:181-196`, `view.tsx:397-401,968,1003`.                                                                                                                                       |
| F3  | Real Pi payloads contain `assistant_message` rows **without `messageId`**. Of 28 recent Pi agents on the main daemon (read-only `paseo logs --json`), 3 have such rows (1, 18, and 3 rows). Every one is a tool-result image rendered as `\n\n![Image](file:///tmp/paseo-attachments-…)`. In a tool-heavy turn the row is standalone, preceded by a `tool_call` row.                                                                           | Output captured under `/tmp/pifork-diag/`; emitter is `renderProviderImageOutputAsAssistantMarkdown` (`packages/server/src/server/agent/providers/provider-image-output.ts:230-270`), called from `pi/agent.ts:2399` and `pi/history-mapper.ts:239`. |
| F3a | **Not established:** that the screenshot's turn ended on such a row, and that the cursor fallback was also unavailable in that client (missing `timelineCursor` on the item or missing `agentForkContextCursor` in `serverInfo`). The user confirmed the screenshot came from a top-level Pi agent tab on desktop.                                                                                                                             | Decision gate G1 in T1.                                                                                                                                                                                                                              |
| F4  | Live Pi assistant rows get a random UUID `messageId`, because `responseId` arrives only at `message_end`. Replayed history uses `responseId`. An assistant `messageId` therefore never names a Pi entry.                                                                                                                                                                                                                                       | `pi/agent.ts:2454-2462,2482`; `pi/history-mapper.ts:164-171`; session file shows `responseId: chatcmpl-resp_…` while live rows show UUIDs.                                                                                                           |
| F5  | Pi user rows carry the real Pi user **entry id** as `messageId`, both live (integration-extension marker) and in history. Rewind already depends on this.                                                                                                                                                                                                                                                                                      | `pi/agent.ts:2030-2054`, `history-mapper.ts:124`, `revertConversation` `agent.ts:1608-1628`.                                                                                                                                                         |
| F6  | RPC `fork` and `clone` do not create a side copy. They call `runtimeHost.fork()`, which aborts the current run (`teardownCurrent`), emits `session_shutdown`, and **rebinds the calling RPC process to the new file**. Sending either one to the source runtime would violate "source unchanged". `fork(entryId)` accepts only a user entry and cuts at its parent. `clone` cuts at the current leaf.                                          | Pi 1.4.0 `dist/modes/rpc/rpc-mode.js:481-497`, `dist/core/agent-session-runtime.js:102-111,174-250`.                                                                                                                                                 |
| F7  | A full Pi runtime opened on an existing file can append to it: `thinking_level_change` for older sessions, and `model_change` with `--model`. `SessionManager.open()` rewrites a file only when it is empty or needs a version migration.                                                                                                                                                                                                      | `dist/core/sdk.js:289-300`; `dist/core/session-manager.js:665-725`.                                                                                                                                                                                  |
| F8  | `pi --fork <file>` copies the whole file, including every branch, and cannot cut at an entry.                                                                                                                                                                                                                                                                                                                                                  | `dist/main.js:275-305`; `SessionManager.forkFrom` `session-manager.js:1374-1410`.                                                                                                                                                                    |
| F9  | `SessionManager.createBranchedSession(leafId)` is public SDK API: it is in `session-manager.d.ts:365` and exported from the package index. It writes a new `<ts>_<id>.jsonl` holding only the root→leaf path, re-chains labels, remaps compaction `firstKeptEntryId`, mints a new session id, and sets header `parentSession` to the opened file. Nothing else is written.                                                                     | `session-manager.js:1205-1290`; `dist/index.d.ts:21`.                                                                                                                                                                                                |
| F10 | Extension ownership is keyed by Pi session identity. goal-x scheduling uses owner = `getSessionId()` and refuses to auto-continue a goal owned by another session. pi-subagents scopes wait records and async runs by session id or file (`status.sessionId` = session file). Paseo's boot auto-resume pairs runs by `persistence.nativeHandle`. A fork does inherit goal-x focus entries and the history of the source's subagent tool calls. | `pi-goal-x/extensions/goal-scheduler.ts:33,65-66,138-150`, `goal-state.ts:755-790`; `pi-subagents/src/extension/index.ts:963-1015,1218-1250`, `wait-subscriptions.ts`; `docs/features/pi-workflow-auto-resume-design.md`.                            |
| F11 | Paseo already turns a provider session file into a new agent with replayed native history: `AgentManager.importProviderSession` → `client.importSession` → `importSessionFromPersistence` → `resumeSession` + `streamHistory`.                                                                                                                                                                                                                 | `agent-manager.ts:1657-1745`, `provider-session-import.ts`.                                                                                                                                                                                          |
| F12 | The default Pi binary and pi-subagents paths hardcoded in the Pi workflow tests no longer exist. Use the installed ones: `/nix/store/l8niyvnm0wbpmk1faq8lxw96nf6d5hqr-pi-coding-agent-1.4.0/bin/pi` and `/nix/store/1mff5yfidvqw4k0ynw1ly6pnj9025bhw-pi-subagents-0.84.0/lib/node_modules/pi-subagents`.                                                                                                                                       | `ls` of both defaults fails; `pi --version` = 1.4.0.                                                                                                                                                                                                 |

## 1. Goal and acceptance criteria

Goal: native Pi fork and clone in Paseo, clearly separated from the transcript copy, plus a fix for the missing Split action.

### Acceptance criteria

Each AC names its entry paths and the evidence that proves it (test ids from §4; E2E steps from §5).

- **AC1 — Missing-Split diagnosis and fix.** T1 records the failing predicate from a real Pi turn in an isolated daemon plus app: footer source item kind, `messageId`, `timelineCursor`, `serverInfo.features.agentForkContextCursor`, `readOnly`. It must show that F3 or another captured cause removes the Split, and fix it at the layer that drops the identity. Afterwards, every completed top-level Pi assistant turn shows the Split trigger, including turns whose last assistant row is a tool-result image, an error row, or a slash-command output. Evidence: `diagnosis.md` in run artifacts with the captured item JSON before and after; `turn-boundary.test.ts` regression that fails on `788bce64e`; E2E-1.
- **AC2 — Visible, differentiated actions.** On a Pi agent, the Split menu shows two labeled sections. "Fork session" holds "Fork session from here". "Copy chat" holds "Copy chat to a new tab" and "Copy chat to a new workspace". Non-Pi agents, and Pi agents on hosts without `agentNativeSessionFork`, show only "Copy chat". Read-only provider-subagent panes show neither, as today. The workspace tab menu (desktop row and compact switcher) shows "Clone session" on Pi agent tabs. Native items are disabled while the turn is pending, and so are the latest-turn footer item and "Clone session" while the source is running. Evidence: `workspace-tab-menu.test.ts`, `assistant-fork-menu.spec.ts` (browser), E2E-2, wide and compact screenshots.
- **AC3 — Assistant-boundary mapping.** "Fork session from here" on assistant turn _N_ creates a session holding exactly the source's Pi path from the root through the end of the run containing that response. It stops immediately before the next run-trigger entry (user message or `custom_message`), or at the source leaf when there is none. It is never cut at the turn's _preceding_ user entry; that is what Pi `fork(previousUserEntry)` does. Mid-session turns, steer-split runs, extension-triggered runs (goal continuation, subagent notify), and responses without text (error-only or image-only) all map correctly. A boundary that cannot be matched fails with `boundary_not_found` or `boundary_mismatch`, and no session is created. Evidence: `session-fork.test.ts` (mapping table), the history self-consistency test, E2E-3.
- **AC4 — Structured native history.** The fork's file is a native Pi session (`createBranchedSession` output). Pi `get_messages` on it returns the same role sequence, the same tool calls and results by id, and the same compaction entry (`firstKeptEntryId` intact) as the source path. `get_entries` on it equals the source path entries, except for label re-chaining. The new Paseo agent's timeline loads from that native history (user, assistant, reasoning, tool rows, compaction row), not from a `chat_history` attachment. Evidence: `session-fork.local.e2e.test.ts`, `pi-native-fork.real.e2e.test.ts`, E2E-3.
- **AC5 — Independent identity and continuation.** The fork has a new Paseo agent id, a new Pi session id, a new session file in the source's Pi session directory, and header `parentSession` = source file. It inherits cwd, workspace, model, and thinking option. It inherits no labels; in particular no `paseo.parent-agent-id`, so it is not a subagent of anything. Title: `<source title> (fork)`. Prompting the fork appends only to the fork file. The source's later turns never appear in the fork, and the fork's never appear in the source. "Clone session" behaves the same at the source's current leaf, honoring an unprompted rewind override. Evidence: `agent-manager.test.ts` fork cases, `pi-native-fork.real.e2e.test.ts`, E2E-4.
- **AC6 — Source unchanged.** Forking never sends `fork`, `clone`, `switch_session`, or a prompt to the source runtime, and never opens the source file with a full Pi runtime. Across a fork of an idle source, all of these stay the same: source file bytes (sha256), mtime, Pi session id, `nativeHandle`, Paseo status, timeline, runtime process, and pending permissions. The source then keeps working normally. Evidence: `session-fork.local.e2e.test.ts` (hash and mtime), real e2e, E2E-5.
- **AC7 — Isolated daemon restart.** After the isolated daemon restarts, the fork agent is listed. It resumes from its own file, replays its own history including post-fork turns, and accepts a new prompt. The source does the same with its own file. Evidence: `pi-native-fork.real.e2e.test.ts` restart case, E2E-6.
- **AC8 — Cancellation and failure.** These cases each leave no destination file, no staging directory, no agent record, and an unchanged source: worker spawn failure, helper error (unknown entry, unsupported Pi, version mismatch), timeout, abort, daemon shutdown during a fork, destination resume failure, and staged-name collision. The app shows a pending state and blocks duplicate submits. On failure it shows an actionable error in the rendered UI until dismissed, and a retry works. Evidence: `session-fork.local.e2e.test.ts` failure cases, `agent-manager.test.ts` shutdown and resume-failure cases, E2E-7.
- **AC9 — Extension ownership.** In the fork:
  - goal-x does not auto-continue or claim the source's goal; the scheduler owner stays the source session id.
  - pi-subagents does not resume or claim the source's async workflows; `resumed-by` and claim files never name the fork.
  - Paseo's provider-subagent tree starts empty. The source's subagent history is not replayed as live rows, and the fork gets no stop/resume controls over source runs.
  - The tool-call rows stay in the fork's timeline.
  - Boot auto-resume never wakes the fork for source runs.

  The source keeps its tree and its ownership. Evidence: `agent-manager.test.ts` (dropped `providerSubagentEvents`), `pi-workflow-subagents.local.e2e.test.ts` fork case, real e2e goal case, E2E-8.

- **AC10 — Protocol compatibility.** New wire fields and RPCs are optional and additive. An old app parses messages from the new daemon. A new app on an old daemon hides the native items, gated on `agentNativeSessionFork`. Copy chat keeps working on both. Evidence: protocol validation tests, client gating unit test.

### Required decisions

| #   | Decision                  | Choice                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | UI shape                  | One Split menu with two labeled sections ("Fork session" and "Copy chat"). The existing copy items are renamed for all providers. _(User, 2026-11-10.)_                                                                                                                                                                                                      |
| D2  | Clone entry points        | Latest-turn footer: "Fork session from here" = clone semantics. Also "Clone session" in the workspace tab menu, desktop and compact. _(User.)_                                                                                                                                                                                                               |
| D3  | Inherited extension state | Rely on the extensions' session-id ownership and drop the inherited Paseo subagent tree; no goal-x entry surgery. _(User.)_                                                                                                                                                                                                                                  |
| D4  | How the branch is written | An extension-free Pi **worker** calls public `SessionManager.open(source, staging).createBranchedSession(target)` through a generated helper extension. Not RPC `fork`/`clone` on any runtime (F6). Not `pi --session <source>` (F7). Not a Paseo port of the format. The worker runs the installed Pi through the same launch command and env as the agent. |
| D5  | Boundary identity         | Anchor on the preceding Pi user entry id (F5), then the ordinal of text-bearing assistant messages after it, checked against the assistant text. Assistant `messageId` is not used as a Pi id (F4).                                                                                                                                                          |
| D6  | Where the cut lands       | Immediately before the next run trigger after the matched assistant entry, or the leaf. "Clone" = the leaf (Paseo rewind override, else the file's last entry).                                                                                                                                                                                              |
| D7  | While the source runs     | Native fork of an earlier, completed turn is allowed; it reads only persisted entries. Latest turn and Clone are disabled and rejected with `source_running`. The in-flight footer keeps Copy chat only.                                                                                                                                                     |
| D8  | Target placement          | Native fork opens as a new agent tab in the source's workspace and cwd. No "native fork to a new workspace", because Pi sessions are cwd-bound.                                                                                                                                                                                                              |
| D9  | Inherited Paseo metadata  | Labels, parent link, schedules and heartbeats, attention, and archive state are not inherited. Origin is recorded in `persistence.metadata.forkOrigin` instead.                                                                                                                                                                                              |
| D10 | Pi format guard           | Refuse with `source_needs_migration` when the source header `version` ≠ the worker's `CURRENT_SESSION_VERSION`, so `SessionManager.open` never rewrites the source (F7).                                                                                                                                                                                     |
| D11 | Failure feedback          | A persistent error toast (`durationMs: null`) with a dismiss control. If the toast host cannot show a dismissible persistent error on every platform, use the shared alert component (`docs/testing.md` "Fallible user actions").                                                                                                                            |
| D12 | `session_before_fork`     | Not emitted. The worker loads no extensions, and the fork's first runtime start is `session_start` reason `startup` with header `parentSession` set. This is documented as a known difference from interactive `/fork`.                                                                                                                                      |

### Documentation items

- DOC1 — `docs/glossary.md`: rewrite **Fork** into **Copy chat** (transcript copy, `agent.fork_context`) and **Fork session / Clone session** (native, `agent.fork_session`), and update the UI labels.
- DOC2 — `docs/providers.md`: provider contract for `supportsNativeSessionFork` and `AgentClient.forkSession`; Pi worker constraints (F6, F7, D4, D10).
- DOC3 — `docs/agent-lifecycle.md`: a forked agent is a top-level agent (not a subagent), inherits nothing ownership-related (D9), and archives independently.
- DOC4 — This plan: keep §0 and the decisions current; record G1's outcome.

## 2. Design

### Data flow

```
Split menu "Fork session from here"            Tab menu "Clone session"
  (turn footer: boundary = cursor/messageId)     (target "latest")
            │                                          │
            └──► DaemonClient.forkAgentSession(agentId, {target, boundaryCursor?, boundaryMessageId?})
                     │  WS agent.fork_session.request   (permission workspace.write)
                     ▼
         Session.handleAgentForkSessionRequest
                     ▼
         AgentManager.forkAgentSession
           1. source = loaded agent; check capability; reject source_running (latest)
           2. resolveNativeForkTarget(timeline rows, boundary)   ← Paseo rows → {anchor, ordinal, text}
           3. client.forkSession({source handle, cwd, target, leafEntryId?, signal})
                 Pi: readPiSessionPath(source file)   (read-only JSONL)
                     resolvePiForkTarget(path, target) → targetEntryId
                     materializePiBranch(worker)      → new file in source session dir
                     importSessionFromPersistence(new file) → resume + streamHistory
           4. registerImportedSession(... labels {}, providerSubagentEvents dropped,
                                      title "<source> (fork)", metadata.forkOrigin)
                     ▼
         agent.fork_session.response {agent snapshot}
                     ▼
App: navigateToWorkspace(source workspace, { kind: "agent", agentId: new })
```

The source runtime appears only as an optional, read-only query for its rewind leaf override (`getNativeForkLeaf`). No command reaches it.

### Module boundaries and interfaces

Server, provider-neutral (`packages/server/src/server/agent/agent-sdk-types.ts`):

```ts
export interface AgentCapabilityFlags {
  // …existing…
  supportsNativeSessionFork?: boolean;
}

export type NativeSessionForkTarget =
  | { kind: "latest"; leafEntryId: string | null } // clone; null = provider's persisted leaf
  | {
      kind: "turn";
      anchorUserMessageId: string | null; // provider user entry id; null = session start
      assistantOrdinal: number; // 1-based count of text-bearing assistant messages after anchor; 0 = none
      assistantText: string | null; // final text of that message, image markdown stripped
    };

export interface NativeSessionForkOrigin {
  sourceAgentId: string;
  sourceSessionId: string;
  sourceNativeHandle: string;
  targetEntryId: string;
  createdAt: string;
}

export interface ForkProviderSessionInput {
  source: AgentPersistenceHandle;
  cwd: string;
  target: NativeSessionForkTarget;
  signal: AbortSignal;
}

export interface ForkedProviderSession extends ImportedProviderSession {
  origin: Omit<NativeSessionForkOrigin, "sourceAgentId" | "createdAt">;
}

export interface AgentClient {
  // …existing…
  forkSession?(
    input: ForkProviderSessionInput,
    context: ImportProviderSessionContext,
  ): Promise<ForkedProviderSession>;
}

export interface AgentSession {
  // …existing…
  /** Read-only: provider leaf the next prompt would extend, when it differs from the persisted leaf. */
  getNativeForkLeaf?(): Promise<string | null>;
}

export class NativeSessionForkError extends Error {
  constructor(readonly code: NativeSessionForkErrorCode, message: string);
}
export type NativeSessionForkErrorCode =
  | "unsupported"
  | "source_running"
  | "source_not_loaded"
  | "boundary_not_found"
  | "boundary_mismatch"
  | "source_needs_migration"
  | "materialize_failed"
  | "resume_failed"
  | "canceled"
  | "timeout";
```

Server boundary resolution (`packages/server/src/server/agent/native-fork-boundary.ts`, new, pure):

```ts
export function resolveNativeForkTarget(input: {
  rows: readonly AgentTimelineRow[]; // the source's in-memory timeline
  boundary: { cursor?: AgentTimelineCursor; messageId?: string } | null; // null => latest
  leafEntryId: string | null;
}): NativeSessionForkTarget; // throws NativeSessionForkError("boundary_not_found")
```

Rules:

- Locate the boundary row by cursor seq, else by the last row with that `messageId`.
- Anchor = the last `user_message` row at or before it that has a `messageId`.
- Ordinal = the number of distinct `messageId`s among `assistant_message` rows after the anchor, up to and including the boundary's response.
- `assistantText` = that message's concatenated text with provider image markdown stripped (`isProviderImageMarkdown`).
- Rows without `messageId` (images, errors, slash-command output) are not counted.

Pi provider (`packages/server/src/server/agent/providers/pi/session-fork.ts`, new):

```ts
export interface PiPathEntry {
  id: string;
  parentId: string | null;
  type: string; // "message" | "custom_message" | "custom" | "compaction" | "label" | …
  role?: string; // message.role
  text?: string; // trimmed concatenated text content (assistant/user)
}
export function readPiSessionPath(
  file: string,
  leafId: string | null,
): Promise<{ header: { id: string; version: number; cwd: string }; path: PiPathEntry[] }>;
export function resolvePiForkTarget(
  path: readonly PiPathEntry[],
  target: NativeSessionForkTarget,
): { targetEntryId: string };
export function materializePiBranch(input: {
  runtime: PiRuntime;
  cwd: string;
  sourceFile: string;
  targetEntryId: string;
  signal: AbortSignal;
  logger: Logger;
}): Promise<{ sessionFile: string; sessionId: string }>;
```

- `readPiSessionPath` reads the JSONL without writing anything and walks parent pointers from `leafId` (or the last entry) to the root. Malformed trailing lines are skipped, because a live source may be mid-append. Paseo already reads Pi JSONL in `session-descriptor.ts` and the child-session follower.
- `resolvePiForkTarget`:
  1. Find the anchor user entry on the path; if it isn't there, fail with `boundary_not_found`.
  2. Count assistant entries with non-empty trimmed text after the anchor until reaching the ordinal. A mismatched text prefix fails with `boundary_mismatch`. Ordinal 0 means the anchor itself.
  3. Cut at the parent of the first later entry that is `message`/`user` or `custom_message`; if there is none, cut at the path leaf.
  4. `latest` resolves to `leafEntryId ?? last path entry`.
- `materializePiBranch`:
  1. Create `<dirname(sourceFile)>/.paseo-fork-staging/<uuid>/`.
  2. Start a worker through `runtime.startSession({ cwd, noSession: true, extensionPaths: [helper], extraArgs: ["--no-extensions", "--no-mcp"] })`. The `PiRuntime` keeps the configured command and env.
  3. Run `/paseo_fork_branch <base64url payload>`. The helper imports `SessionManager` and `CURRENT_SESSION_VERSION` from `@earendil-works/pi-coding-agent`, applies the D10 guard, calls `SessionManager.open(sourceFile, stagingDir).createBranchedSession(targetEntryId)`, and reports `{ ok, sessionFile, sessionId }` through the existing `PASEO_PI_COMMAND_RESULT_MARKER` notify pattern (`agent.ts:696-701`).
  4. Close the worker, then validate the staged header: new id, `parentSession === sourceFile`, cwd, and last non-label entry = target.
  5. Publish without clobbering: `link(staged, final)` then `unlink(staged)`.
  6. In `finally`, remove the staging directory. Abort or timeout (120 s) kills the worker.
- `PiRpcAgentClient.forkSession` composes these, then `importSessionFromPersistence` with `readPiImportSessionConfig(newFile)`. On a resume or replay failure it closes the session and deletes the published file. Capability `supportsNativeSessionFork: true` goes in `withPiCapabilities`. `PiRpcAgentSession.getNativeForkLeaf()` returns `currentLeafOverrideId`.

Agent manager (`agent-manager.ts`):

```ts
forkAgentSession(input: {
  sourceAgentId: string;
  target: "turn" | "latest";
  boundary?: { cursor?: AgentTimelineCursor; messageId?: string };
  signal?: AbortSignal;
}): Promise<ManagedAgent>;
```

- Extract the post-`client.importSession` registration from `importProviderSessionInternal` into a shared `registerImportedSession(imported, { workspaceId, labels, initialTitle, persistenceMetadata, includeProviderSubagents })`. Import keeps its behavior.
- Fork calls it with the source's `workspaceId`, `labels: {}`, `includeProviderSubagents: false`, and `persistence.metadata.forkOrigin`.
- Wrapped in `trackAgentRegistrationOperation` and `assertAcceptingAgentRegistrations`. Daemon shutdown aborts the signal.

Protocol (`packages/protocol/src/messages.ts`; names per `docs/rpc-namespacing.md`):

```ts
AgentForkSessionRequestMessageSchema = z.object({
  type: z.literal("agent.fork_session.request"),
  agentId: z.string(),
  target: z.enum(["turn", "latest"]),
  boundaryCursor: AgentTimelineCursorSchema.optional(),
  boundaryMessageId: z.string().optional(),
  requestId: z.string(),
});
AgentForkSessionResponseMessageSchema = z.object({
  type: z.literal("agent.fork_session.response"),
  payload: z.object({
    requestId: z.string(),
    sourceAgentId: z.string(),
    agent: AgentSnapshotPayloadSchema.nullable(),
    error: z.string().nullable(),
    errorCode: z.string().nullable().optional(),
  }),
});
// server_info.features
// COMPAT(agentNativeSessionFork): added in v0.15.4, remove gate after 2027-05-10.
agentNativeSessionFork: z.boolean().optional(),
// agent capabilities
supportsNativeSessionFork: z.boolean().optional(),
```

Add both to the inbound and outbound unions, then regenerate validators (`npm run generate:validators --workspace=@getpaseo/protocol`). Permissions: `"agent.fork_session.request"` and `.response` → `"workspace.write"` (`operation-permissions.ts`, matching `import_agent_request`). Add `features.agentNativeSessionFork: true` in `websocket-server.ts`.

Client (`packages/client/src/daemon-client.ts`):

```ts
forkAgentSession(
  agentId: string,
  options: {
    target: "turn" | "latest";
    boundaryCursor?: AgentTimelineCursor;
    boundaryMessageId?: string;
    requestId?: string;
  },
): Promise<AgentSnapshotPayload>; // timeout 150_000; throws Error(message) with .code = errorCode
```

App:

- `agent-stream/turn-boundary.ts` gets the AC1 fix, shaped by G1. Example: if F3 is confirmed, the footer source resolution skips id-less provider-image rows to find the response's identity or cursor, and a regression covers it.
- `components/assistant-fork-menu.tsx` changes its props to `{ onCopyChat: (target: "tab" | "workspace") => Promise<void> | void; onForkSession?: () => Promise<void>; forkSessionDisabledReason?: string; testID? }`. It renders sections with `DropdownMenuLabel` and `DropdownMenuSeparator` and keeps the existing test ids (`-new-tab`, `-new-workspace`). It adds `-fork-session`, with one pending lock shared across all items.
- `hooks/use-fork-agent.ts` keeps `useForkAgent` (copy chat). A new `hooks/use-native-fork-agent.ts` exports `useNativeForkAgent({ serverId, toast }) => (req: { agentId; workspaceId; target; boundary? }) => Promise<void>`. On success it navigates to `{ kind: "agent", agentId }`; on failure it shows D11 feedback. The gate is `useHostFeature(serverId, "agentNativeSessionFork") && agent.capabilities.supportsNativeSessionFork`.
- `turn-footer.tsx`, `view.tsx`, and `components/message.tsx` thread `onForkSession` next to `onFork`. It is passed only on completed turns, never on the in-flight footer (D7). The latest turn is disabled while the agent runs.
- `screens/workspace/workspace-tab-menu.ts` adds the `clone-session` entry (new icon `split`, label `cloneSession`), disabled while the agent runs. Wire it in `workspace-desktop-tabs-row.tsx` and `compact-workspace-header/tab-switcher.tsx`.
- `runtime/replica-cache/index.ts` gets the `supportsNativeSessionFork` schema and copy.
- i18n: `message.actions.forkSessionSection`, `forkSessionFromHere`, `copyChatSection`, `copyChatToNewTab`, `copyChatToNewWorkspace`, `forkSessionFailed`, `forkSessionRunning`, and `workspace.tabs.menu.cloneSession`, in all ten locale files.

### Errors and conventions

- Server errors are `NativeSessionForkError` with a code. The response carries `error` (human readable) and `errorCode`. Unknown exceptions map to `materialize_failed` or `resume_failed` by stage.
- Each failure path leaves the system as follows:

  | Failure point                | State left behind                                               |
  | ---------------------------- | --------------------------------------------------------------- |
  | Before the file is published | Staging removed.                                                |
  | After it is published        | Session closed, then the file deleted.                          |
  | After registration           | No rollback; the fork exists, and the response reports success. |

- Function-length limits (oxlint): keep the helper-extension source generator separate from `materializePiBranch`.
- Follow `docs/coding-standards.md`: no `any`, explicit result types, and no duplicate local types for protocol payloads.

## 3. Tasks

### T1 — Native Pi session fork and clone, and the missing-Split fix (single task)

- **Owns:**
  - Server: `agent/agent-sdk-types.ts`, `agent/native-fork-boundary.ts` (+ test), `agent/agent-manager.ts` (+ tests), `agent/providers/pi/session-fork.ts` (+ `session-fork.test.ts`, `session-fork.local.e2e.test.ts`), `agent/providers/pi/agent.ts` (+ `agent.test.ts`), `session.ts`, `websocket-server.ts`, `authorization/operation-permissions.ts` (+ test), `daemon-e2e/pi-native-fork.real.e2e.test.ts`, `daemon-e2e/pi-workflow-subagents.local.e2e.test.ts` (fork case).
  - Protocol: `protocol/src/messages.ts` (+ validation tests).
  - Client: `client/src/daemon-client.ts` (+ test).
  - App: `agent-stream/turn-boundary.ts` (+ test), `agent-stream/turn-footer.tsx`, `agent-stream/view.tsx`, `components/message.tsx`, `components/assistant-fork-menu.tsx`, `hooks/use-native-fork-agent.ts`, `screens/workspace/workspace-tab-menu.ts` (+ test), `workspace-desktop-tabs-row.tsx`, `compact-workspace-header/tab-switcher.tsx`, `runtime/replica-cache/index.ts`, `i18n/resources/*.ts`, `e2e/browser/assistant-fork-menu.spec.ts`, `e2e/support/helpers/assistant-fork.ts`, `e2e/browser/pi-native-fork.real.spec.ts` (new), plus any new e2e helper.
  - Docs: DOC1–DOC4.
- **Consumes:** Pi 1.4.0 RPC and public SDK (`SessionManager`, `CURRENT_SESSION_VERSION`), the existing import pipeline, the existing Playwright isolated-daemon harness.
- **Produces:** the interfaces in §2.
- **Depends on:** prerequisite a04f7a37 (complete).
- **Unit commands (exact):**
  - `npm exec --workspace=@getpaseo/server -- vitest run src/server/agent/native-fork-boundary.test.ts src/server/agent/providers/pi/session-fork.test.ts --bail=1`
  - `npm exec --workspace=@getpaseo/app -- vitest run src/agent-stream/turn-boundary.test.ts src/screens/workspace/workspace-tab-menu.test.ts --project=unit --maxWorkers=1 --bail=1`
- **Ordered checkpoints, each needing early review before the next:**
  - **G1 — Missing-Split diagnosis.** Reproduce on an isolated daemon plus app with real Pi: a turn that reads a PNG so its last assistant row is a provider image, and a plain text turn. Capture the predicate values from AC1 into `diagnosis.md` and choose the fix layer. If the capture contradicts F3, record the real cause, update §0, and notify the orchestrator before going on.
  - **G2 — Worker spike.** On a copy of a real session, run `materializePiBranch` against the installed Pi and check four things: `-ne` still loads `-e` and resolves `@earendil-works/pi-coding-agent`; `--no-session` RPC starts without model auth; the source sha256 is unchanged; Pi `SessionManager.list` and Paseo's `listPiImportableSessions` ignore `.paseo-fork-staging/`. If any check fails, stop and report. Don't switch approaches silently.
  - **G3** — Boundary mapping self-consistency on real session fixtures, including goal-continuation and subagent-notify runs, before wiring the UI.
- **Split:** none. Protocol → server → client → app form one dependency chain with shared type builds (`build:server`), and wiring and tests can't be separated from the code.

### Waves (presentation only)

T1 alone. Review is consolidated at the end, plus the G1, G2, and G3 checkpoints.

### Conflicts and uncertainty

- **Shared builds.** `npm run build:server` and `generate:validators` rewrite `dist` and `generated/`. Serialize them under the default build lock (`…/e2e-feature-build.lock`) before typecheck, app tests, and e2e.
- **Concurrent edits.** `agent-manager.ts` and `pi/agent.ts` are large shared files. Rebase conflicts are likely if other branches touch import registration or the Pi integration extension.
- **G2 is the main risk.** Pi extension import resolution under `-ne`, plus staging-directory visibility.
- **G1 decides how the Split fix is shaped.**

## 4. Test and verification

Run everything serially from the worktree root unless marked otherwise. Never run a full suite. Pipe broad runs to files under the run artifacts directory.

### Prerequisites and generated inputs

1. `npm run generate:validators --workspace=@getpaseo/protocol`. This rewrites gitignored generated files; run it before any protocol test invoked through `npm exec`, because `pretest` hooks don't run there.
2. `npm run build:server` (protocol, client, highlight, plugin, relay, server, and CLI declarations), under the build lock, before typecheck and app tests.
3. Pi env for Pi tests: `PASEO_PI_BINARY=/nix/store/l8niyvnm0wbpmk1faq8lxw96nf6d5hqr-pi-coding-agent-1.4.0/bin/pi`, `PASEO_PI_SUBAGENTS_PACKAGE=/nix/store/1mff5yfidvqw4k0ynw1ly6pnj9025bhw-pi-subagents-0.84.0/lib/node_modules/pi-subagents` (F12), and `PI_REAL_TEST_MODEL=<a fast magpie model chosen via pi --list-models magpie>`. Real Pi uses the installed `~/.pi/agent` packages (goal-x, pi-subagents).
4. Chromium for Playwright: the dev shell from `docs/development.md#nix-and-direnv`. The launch is not yet verified; that happens at the start of the e2e step.

### Targeted unit and integration (new or changed)

- Server unit:
  ```
  npm exec --workspace=@getpaseo/server -- vitest run src/server/agent/native-fork-boundary.test.ts src/server/agent/providers/pi/session-fork.test.ts src/server/agent/providers/pi/agent.test.ts src/server/agent/agent-manager.test.ts src/server/authorization/operation-permissions.test.ts src/server/agent/provider-session-import.test.ts --bail=1
  ```
  (Run whichever of these exist; `agent-manager.test.ts` was 252 tests at the last sync.)
- Server, local real Pi with no model:
  ```
  npm exec --workspace=@getpaseo/server -- vitest run src/server/agent/providers/pi/session-fork.local.e2e.test.ts --maxWorkers=1 --bail=1
  ```
  Covers materialize success, source sha256 and mtime, Pi `get_messages`/`get_entries` equality via a second worker, every AC8 failure case, and the staging sweep.
- Server, real Pi with a model:
  ```
  npm exec --workspace=@getpaseo/server -- vitest run src/server/daemon-e2e/pi-native-fork.real.e2e.test.ts --maxWorkers=1 --bail=1
  ```
  Covers AC3–AC7 and the goal half of AC9.
- Required existing Pi workflow tests (AGENTS.md), with the env above. The first also carries the new fork-ownership case:
  ```
  npm exec --workspace=@getpaseo/server -- vitest run src/server/daemon-e2e/pi-workflow-subagents.local.e2e.test.ts --maxWorkers=1 --bail=1
  npm run test:e2e:real --workspace=@getpaseo/app -- e2e/browser/pi-workflow-subagent-tree.real.spec.ts
  ```
- Regression for the touched Pi integration:
  ```
  npm exec --workspace=@getpaseo/server -- vitest run src/server/daemon-e2e/pi-rewind.real.e2e.test.ts --maxWorkers=1 --bail=1
  ```
- Protocol:
  ```
  npm exec --workspace=@getpaseo/protocol -- vitest run tests/validation --bail=1
  ```
  Covers the outbound size guard, the new messages, and old-shape parsing.
- Client:
  ```
  npm exec --workspace=@getpaseo/client -- vitest run src/daemon-client.test.ts --bail=1
  ```
  (Or the file that already covers `buildAgentForkContext`.)
- App unit:
  ```
  npm exec --workspace=@getpaseo/app -- vitest run src/agent-stream/turn-boundary.test.ts src/agent-stream/layout.test.ts src/screens/workspace/workspace-tab-menu.test.ts src/i18n/resources.test.ts src/runtime/replica-cache --project=unit --maxWorkers=1 --bail=1
  ```

### App Playwright (isolated harness; never the 6767 daemon)

- Browser project (mock provider):
  ```
  npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/assistant-fork-menu.spec.ts e2e/browser/fork-workspace-setup-gate.spec.ts
  ```
  Covers the renamed Copy chat items and test ids, that the native section is hidden without the capability, and the Split regression from G1 if the mock can emit an image row.
- Real-provider project:
  ```
  npm run test:e2e:real --workspace=@getpaseo/app -- e2e/browser/pi-native-fork.real.spec.ts
  ```
  Runs the §5 journey, including the failure state, retry, and isolated host-daemon restart.

### Repo gates

`npm run typecheck`, `npm run lint`, `npm run format:check`, and `npm run format` before commit. `format` rewrites files, so never run it concurrently with edits or tests. Then `git diff --check -- . ':!patches'`. Run `bash scripts/update-nix.sh --check` only if `package-lock.json` changes; none is expected.

### Coverage and visual evidence

- No coverage gate is configured. Coverage is the targeted inventory above, with each AC mapped to a test.
- Screenshots in run `artifacts/`:
  - the Split menu with both sections (wide and compact)
  - the tab menu "Clone session" (desktop row and compact switcher)
  - the pending state
  - the error state
  - the fork tab with native tool and compaction rows
  - before/after of the G1 turn

### Cross-package compatibility

- An old-shape agent snapshot (no `supportsNativeSessionFork`) parses in the app.
- With `features.agentNativeSessionFork` absent, the app hides native items and Copy chat still works.
- A new app against a daemon without the feature (gating unit test).

### Platform matrix (honest)

| Platform                     | Covered by                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| Web (Chromium)               | Playwright, real and mock                                                                          |
| Electron Linux               | Shares the web renderer. Packaged desktop smoke only if time allows; otherwise listed as untested. |
| iOS, Android, macOS, Windows | Untested. Code paths are cross-platform: the menu engine and toast/alert.                          |

## 5. E2E journey

The journey runs against a real Pi in a Playwright real-provider fixture with an isolated daemon, a temporary cwd, and the installed Pi and extensions. A server-side twin in `pi-native-fork.real.e2e.test.ts` asserts the same facts through `DaemonClient`.

1. **E2E-1 — Split visible (AC1).**
   - Steps: create a Pi agent in a temp git cwd. Prompt it to `read` a committed PNG and answer in one word, so its last assistant row is the image. Then prompt a plain text turn.
   - Expected: both completed footers show Copy and the Split trigger (`assistant-fork-menu-trigger`). The captured item fields are recorded.
2. **E2E-2 — Differentiated actions (AC2).**
   - Steps: open the Split menu on turn 1.
   - Expected: sections "Fork session" (`…-fork-session`) and "Copy chat" (`…-new-tab`, `…-new-workspace`). The tab menu on the agent tab shows "Clone session". While a third turn runs, the latest-turn native item and Clone are disabled, the in-flight footer shows only Copy chat, and turn 1's "Fork session from here" stays enabled.
3. **E2E-3 — Boundary and native history (AC3, AC4).**
   - Setup: turn 1 runs a `bash` tool. Run `/compact`, then turn 2.
   - Steps: on turn 1, choose "Fork session from here".
   - Expected:
     - The pending state shows, then the app navigates to a new agent tab titled `… (fork)`.
     - Its timeline shows turn 1's user message, reasoning, the bash tool row with its result, and turn 1's answer.
     - It shows neither the compaction nor turn 2.
     - Server side, the new file's path equals the source path through the end of turn 1, and `parentSession` is the source file.
     - A second fork on turn 2 includes the compaction row and both turns.
4. **E2E-4 — Independent continuation (AC5).**
   - Steps: prompt the fork with token `FORK-ONLY`, and the source with `SOURCE-ONLY`.
   - Expected:
     - Each token appears only in its own timeline and its own session file.
     - The ids differ: Paseo agent id, Pi session id, `nativeHandle`.
     - The fork has no parent and doesn't appear in the source's subagents track.
     - "Clone session" from the tab menu creates a tab whose history matches the source's latest leaf.
5. **E2E-5 — Original untouched (AC6).**
   - Steps: before and after each fork of an idle source, record the source file's sha256, mtime, Pi session id, status, timeline length, and runtime pid.
   - Expected: no value changes, and the source tab never switches or reloads.
6. **E2E-6 — Isolated daemon restart (AC7).**
   - Steps: restart the isolated host daemon (the `isolated-host-daemon` and `daemon-lifecycle` helpers).
   - Expected: the fork and source tabs reload their own histories; the fork shows `FORK-ONLY`, the source doesn't. Prompting the fork after the restart works and appends to the fork file.
7. **E2E-7 — Failure and retry (AC8).**
   - Steps: make the fork fail deterministically (rename the source session file away, so the result is `boundary_not_found` / materialize failure), then restore the file and retry.
   - Expected: the item shows pending and blocks double submits. A visible error stays until dismissed. No new tab, agent record, staged file, or new `.jsonl` exists. The retry succeeds.
8. **E2E-8 — Extension ownership (AC9).**
   - Server twin plus the `pi-workflow-subagents` fork case: launch the scripted workflow in the source (gate held), then fork the source.
   - Expected: the fork's subagents track is empty. pi-subagents run `status.sessionId` remains the source file. After a daemon restart, any `resumed-by` file names the source, and the fork isn't woken.
   - goal-x: create a goal in the source with `/goal`, then fork.
   - Expected: the fork shows no auto-continuation turn within the observation window, the goal's scheduler owner remains the source session id, and the source's goal keeps running.

Evidence for each step goes in the run artifacts: Playwright trace, screenshots, captured RPC payloads, file hashes, and raw command output.
