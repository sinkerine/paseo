# Pi workflow subagents: plan

Status: approved by the user (2026-10-30). Base commit `08ea9a1d5510493ffe109617148a50d0415fa934`.

Two parts:

- **Server.** The `pi-subagents` Pi extension adapter
  (`packages/server/src/server/agent/providers/pi/extensions/pi-subagents/`) reports async
  workflows as a Workflow → group → run tree of provider subagents.
- **App.** The subagents track panel renders any provider subagent subtree as a collapsible tree.

No protocol or daemon store changes. `parentSubagentId` already exists on the wire, behind the
`providerSubagentNesting` feature gate.

## 0. Root cause (confirmed)

Evidence comes from the affected agent `cc312c84-d626-4e98-b44f-55177fb2fc86`, its Pi session
`…/--home-sinkerine-dev-keepass2android--/2026-10-30T20-21-04-133Z_01a18e79-….jsonl` (read only),
workflow `38e069c4-1f41-46b2-a21a-8f947abe29cd`, Pi `1.0.4`
(`/nix/store/c4r897xq…-pi-coding-agent-1.0.4`), and pi-subagents `0.71.0`
(`/nix/store/4ia9lbk2…-pi-subagents-0.71.0`).

1. **Live: the nested result is delivered, then rejected.** Pi runs codemode's
   `tools.subagent(...)` through `NestedToolCallRunner` (`dist/core/nested-tool-calls.d.ts`). The
   nested call gets id `<outer>/<n>` and emits `tool_execution_start|update|end` with
   `parentToolCallId`. RPC mode forwards every session event (`rpc-mode.js:265`). Paseo's
   `agent.ts` `tool_execution_*` handling therefore calls `extensionHost.mapToolCall` with
   `toolName: "subagent"` and the full result. For an async workflow, pi-subagents returns
   (`subagent-executor.ts:6076-6078`):
   `details: { mode: "workflow", runId, toolCallId, asyncId, asyncDir, results: [], workflow, workflowChildren }`.
   `mapSpawn` in `pi-subagents/index.ts` returns `undefined` when the args have no top-level
   `agent`/`task`. A `workflowScript` call has neither, so the adapter never registers `asyncDir`
   and `poll()` never reads the workflow's `status.json`.
2. **Replay: no workflow evidence is mapped.** `streamHistory` replays `get_messages`. That holds
   the outer `codemode` `toolResult` and its `nestedCalls` record
   (`{id:"call_47d2…/1", name:"subagent", status:"ok", argumentsBytes:12888}`). Arguments over the
   per-call limit are omitted and nested results are never kept. It also holds
   `subagent-incremental-child-notify` custom messages (session lines 106, 118). No adapter
   handles that `customType`. The existing `subagent-notify` handler only settles async dirs that
   a direct `subagent` tool result registered.
3. **The extension's own artifacts are sufficient.**
   - `<asyncDir>/status.json` has `runId`, `mode:"workflow"`, `state`, `sessionId` (the parent
     session file) and `toolCallId:"call_47d2…/1"`.
   - Each `steps[]` entry has `workflowKey`, `label`, `agent`, `status`, `runId`,
     `parentWorkflowRunId`, `sessionFile` (`<parent session dir>/<uuid>/run-0/session.jsonl`) and,
     when the script sets it, `phase`.
   - `runs.lanes(...)` workflows also record `workflowGraph.phases: [{ title: <lane key>, nodeIds:
[<lane>.<stage>, …] }]` (`buildWorkflowLaneGraph`, `subagent-executor.ts:4885`).
   - Child session headers carry no back-reference, so `status.json` is the only exact link from
     child key to transcript and to group.
4. **Workflow scripts run inside the parent Pi process**
   (`subagent-executor.ts`, "this active owner must consume its own durable steer inbox").
   Restarting the Pi runtime ends the orchestrator; children are separate processes. Replay after
   a daemon restart therefore never needs to follow a workflow that keeps running in the old
   process. It only has to settle what notices and artifacts prove.

Observed notice formats (pi-subagents `src/runs/background/notify.ts`):

```
Workflow child completed: **T1-implement**          # completed | failed | paused (needs attention) | stopped
Workflow run: 38e069c4-1f41-46b2-a21a-8f947abe29cd
Child run: 3e0c2d2d-be37-4ec7-8d5d-25036e79e038     # optional
Output: <path>                                      # optional; never used as status evidence
Error: <text>                                       # optional
Status: workflow still running                      # or "workflow finished"
```

Terminal `subagent-notify` correlation lines (`formatCorrelationLines`):
`Retention-managed async directory: <dir>`, `Workflow run: <id>`,
`Child runs: <key>=<runId> (<status>), …`. Task S1 captures the exact terminal workflow notice;
the parser must be written against that capture.

## 1. Goal and acceptance criteria

**Goal.** An async pi-subagents workflow appears in the parent agent's subagents track whether it
was launched through codemode (`tools.subagent({ workflowScript, async: true })`) or a direct
`subagent` call.

- The track shows the workflow as a collapsible tree: Workflow → group (lane or `phase`) → run.
- Every run opens a pane with its live Pi transcript.
- Statuses follow the extension's own lifecycle.
- History replay rebuilds the same tree without duplicates.

The track tree is provider-neutral: it renders any provider subagent subtree from
`parentSubagentId`.

Target panel (agent track, wide layout):

```
[Workflow · 2 running ▴]
┌─────────────────────────────────────┐
│ ◐ Workflow                       ▾  │
│   3 of 9 groups done                │
│   ✓ T1                           ▸  │
│     Review T1 round 2               │
│   ◐ T2                           ▾  │
│     Fix T2 findings                 │
│     ✓ Implement T2                  │
│       worker                        │
│     ◐ Fix T2 findings               │
│       worker                        │
│   ✕ T3                           ▸  │
│     Review T3 round 1               │
│ [Archive finished]                  │
└─────────────────────────────────────┘
```

### Server acceptance criteria

- **AC1 (live discovery).** Within 1 s of the nested `subagent` `tool_execution_end` reporting
  `details.mode === "workflow"` with an `asyncDir`, Paseo emits one upsert with id
  `pi-subagents-workflow:<runId>`, `title: "Workflow"` and `status: "running"`.
- **AC2 (runs).** Each `status.json` step with a `workflowKey` gets exactly one run descriptor,
  with id `pi-subagents-workflow:<runId>/<workflowKey>`, `title: <label ?? workflowKey>` and
  `subtitle: <agent>`. A re-run key (for example `T1-review-1`, then `T1-fix-1`) is a distinct
  run, and repeated polls never add descriptors.
- **AC3 (grouping).** The group for a run comes from these sources, in order:
  1. the lane in `workflowGraph.phases` whose `nodeIds` contains the run's key;
  2. the step's `phase`;
  3. none.

  A group descriptor has id `pi-subagents-workflow:<runId>/group:<title>`, `title: <title>` and
  `parentSubagentId` set to the workflow id. A grouped run's `parentSubagentId` is its group id;
  an ungrouped run's is the workflow id. A run whose group changes is re-parented, and a group
  left with no runs is removed. Group membership is never inferred from key or label text.

- **AC4 (lifecycle).** Statuses follow the §2.4 table.
  - A run becomes `completed` only on explicit evidence: the step status, an incremental notice
    outcome, or the terminal `Child runs` entry.
  - An `Output:` path or an existing report file is never status evidence, and no run is marked
    `running` because of another run's report.
  - A group's status is derived only from its runs (§2.4).
  - A lane group stays `running` while its `workflowGraph` nodes include unstarted stages.
- **AC5 (timelines).** A run's `sessionFile` from `status.json` streams into that run's timeline
  while it runs. It gets its final read when the run reaches a final status, and it is read at
  most once per adapter session. Workflow and group descriptors have no timeline.
- **AC6 (replay).** Replaying the captured fixture yields the same store state as the live run,
  reduced through the real `ProviderSubagentStore` and ignoring timestamps. That covers the same
  descriptor ids, titles, subtitles, statuses and parents, and the same per-run timeline item
  counts. This holds when the workflow `status.json` exists at replay time. When it is gone,
  replay shows the workflow and its runs directly under it, with notice-proven statuses and no
  timelines.
- **AC7 (scope).** The adapter reads only `<dir>/status.json`, and only for:
  - (a) an `asyncDir` reported by a `subagent` result in this session;
  - (b) the async dir named by a terminal `subagent-notify` in this session whose basename equals
    its `Workflow run` id;
  - (c) an entry in `details.mission.runs[]` of a successful `subagent` result in this session,
    with `mode: "workflow"`, non-empty `runId` and `asyncDir`, and `basename(asyncDir) === runId`.
    Mission entries only recover missing handles for workflows already established by launches
    or notices. They never discover unrelated workflows, replace known handles, or change settled
    workflows. A matching `status.json` supplies lifecycle evidence; mission status is not used.

  It rejects a `status.json` whose `runId` or `mode` does not match, and reads transcripts only
  from `steps[].sessionFile` of a matching step (`parentWorkflowRunId === runId`). It never lists
  directories, derives the pi-subagents temp root, opens child async dirs, or matches transcripts
  by name. A decoy workflow dir and a decoy session file in the same roots stay invisible (E2E).

- **AC8 (direct calls preserved).** Every existing `pi-subagents/index.test.ts` case passes
  unchanged, including the `foreground.json`, `background.json`, and `wait.json` fixtures. A direct
  single, parallel, or chain call keeps its call-id-based ids.
- **AC9 (no JS parsing).** No code inspects `workflowScript`, codemode `code`, or codemode output
  text.
- **AC10 (failure isolation).** A malformed `status.json`, notice, or session file yields no
  mapping for that input and never throws out of the adapter.

### App acceptance criteria

- **AC11 (tree).** With `providerSubagentNesting`, a track shows every non-hidden provider
  descendant of its owner, indented one tree rail per level. The owner is the agent for the agent
  pane, or the subagent for a provider-subagent pane. Paseo-managed subagent rows stay at depth 0,
  unchanged. Without the gate, behavior is today's flat direct-children list.
- **AC12 (disclosure).**
  - A row with children has a trailing disclosure chevron (right; rotated down when expanded).
    Pressing it toggles the row in place, and the panel stays open.
  - Pressing the row body opens that row's pane, as today.
  - By default a row is expanded when any descendant is `running`, and collapsed otherwise.
  - A user toggle overrides the default for that row until the app reloads, and survives closing
    and reopening the panel.
- **AC13 (depth).** The panel renders up to 3 levels below the owner. A row at the third level
  that has children shows no chevron. It shows a muted "N more" facts line instead and opens its
  own pane.
- **AC14 (pill and archive).**
  - The pill still counts the owner's direct children by status bucket. A Workflow with 2 running
    runs reads as 1 running.
  - "Archive finished" hides finished direct children; a hidden row hides its subtree.
  - A row with a running descendant is never hidden.
- **AC15 (platform).**
  - Wide layouts (popover) and compact layouts (sheet) render the same tree, using the shared
    `TREE_INDENT_PER_LEVEL` rail.
  - The chevron is its own press target, separate from the row's `Pressable`, so a toggle never
    opens a pane ([hover.md](../hover.md)).
  - No layout shift when a run is added under an expanded row; it appears at its sorted position.

Out of scope (follow-ups, see §6):

- foreground (non-async) workflows;
- replay of codemode-launched _single_ async calls;
- nesting runs by actual spawning inside a child session;
- Paseo idle-runtime collection while a workflow runs;
- rendering of the nested `<outer>/1` tool row;
- wave and dependency subtitles, and reviewer verdicts, which pi-subagents does not record.

## 2. Design

### 2.1 Module boundaries

Server: `pi-subagents/` stays one module whose public surface is `piSubagents` (`index.ts`).

| File                             | Owns                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pi-subagents/notice.ts` (new)   | Reading text from a Pi custom message, `noticeStatus` (moved from `index.ts`), and the workflow notice parsers.                            |
| `pi-subagents/workflow.ts` (new) | Workflow schemas, descriptor ids, status and grouping policy, and `createPiWorkflowTracker`: launch registration, notice mapping, polling. |
| `pi-subagents/index.ts`          | Routes `subagent` results with `details.mode === "workflow"` and workflow notices to the tracker. The direct-call path is unchanged.       |

App: `packages/app/src/subagents/` stays one module.

| File                                                            | Owns                                                                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `subagents/tree.ts` (new)                                       | Pure tree layout: rows plus parent links in, visible flat rows with depth, chevron state, and "more" counts out. Default expansion and hidden-subtree rules. |
| `subagents/select.ts`                                           | `ProviderSubagentRow` gains `parentSubagentId`. The new descendant selector feeds `tree.ts`. Paseo-row selection is unchanged.                               |
| `subagents/provider-store.ts`                                   | `trackExpansion` overrides (per descriptor key, in memory) and a `toggleTrackExpansion` action, next to `hiddenFromTrack`.                                   |
| `subagents/track.tsx`                                           | Renders tree rows: indentation, the trailing chevron button, and the "N more" facts line.                                                                    |
| `panels/agent-tracks.tsx`, `panels/provider-subagent-panel.tsx` | Pass tree rows instead of direct-child rows. The pill keeps using direct children.                                                                           |

### 2.2 Data flow

Server, live:

```
nested tool_execution_end(subagent, details.mode="workflow")
  → agent.ts → host.mapToolCall → index → tracker.launch(details)
      → upsert Workflow(running); remember {runId, asyncDir}
host 250 ms tick → index.poll → tracker.poll
      → read <asyncDir>/status.json → validate runId/mode
      → resolve each run's group (lanes > phase > none)
      → upsert groups (derived status), runs (+parentSubagentId), remove emptied groups
      → childSessions for steps with sessionFile; stop polling at terminal state
custom message (live message_end) → host.mapCustomMessage → index → tracker.mapNotice
      → incremental: run upsert with outcome status (parent = known group ?? workflow)
      → terminal: workflow + Child runs statuses; one status.json read for groups and sessions
host.followChildren follows each childSessions file and gives it a final read on a final status
```

Server, replay (`streamPiHistory` over `get_messages`): nested codemode results are absent.
`tracker.mapNotice` rebuilds the tree from incremental and terminal notices. Later direct
`subagent` results can carry `details.mission.runs[]`, naming the exact async directory of an
already-known workflow whose terminal notice never arrived (for example after extension reload).
The tracker validates and reads that handle immediately, then polls if still active. This path is
shared by live mapping and replay; a mission snapshot never imports unrelated workflows.

- Incremental notices place runs directly under the workflow.
- The terminal notice's `status.json` read re-parents them into groups and supplies subtitles and
  transcripts. A mission-recovered `status.json` supplies the same enrichment without a terminal
  notice. The host reads transcripts once, charging actual file sizes within the shared 16 MiB
  replay budget and the 2 MiB per-file cap.
- The live and replay end states match because both apply the same grouping function to the same
  `status.json`.

App:

```
provider-store descriptors ─▶ selectProviderSubagentDescendants(owner) ─┐
provider-store trackExpansion, hiddenFromTrack ─────────────────────────┼▶ layoutSubagentTree ─▶ SubagentsTrack rows
direct-child rows (unchanged selector) ─▶ pill segments, Archive finished ┘
```

### 2.3 Interfaces

Server, `notice.ts`:

```ts
type PiCustomMessage = Extract<PiAgentMessage, { role: "custom" }>;

/** Text of a custom message; undefined when it carries none. */
export function customMessageText(message: PiCustomMessage): string | undefined;

/** Header outcome of a `subagent-notify`; moved verbatim from index.ts. */
export function noticeStatus(header: string): "completed" | "failed" | "canceled" | undefined;

export type WorkflowChildOutcome = "completed" | "failed" | "paused" | "stopped";

export interface WorkflowChildNotice {
  workflowRunId: string;
  childKey: string;
  outcome: WorkflowChildOutcome;
  childRunId?: string;
}

/** Parses `subagent-incremental-child-notify`; undefined if any required line is missing. */
export function parseWorkflowChildNotice(text: string): WorkflowChildNotice | undefined;

export interface WorkflowChildRunEntry {
  childKey: string;
  childRunId: string;
  status?: string;
}

export interface WorkflowTerminalNotice {
  workflowRunId: string;
  asyncDir: string;
  status: "completed" | "failed" | "canceled";
  children: WorkflowChildRunEntry[];
}

/**
 * Parses a `subagent-notify` that settles a workflow: header outcome, a `Workflow run:` line, and a
 * `Retention-managed async directory:` line whose basename equals that run id. Any other
 * subagent-notify returns undefined and stays with the direct-call handler.
 */
export function parseWorkflowTerminalNotice(text: string): WorkflowTerminalNotice | undefined;
```

Server, `workflow.ts`:

```ts
export const WorkflowLaunchDetails = z
  .object({
    mode: z.literal("workflow"),
    runId: z.string().trim().min(1),
    asyncDir: z.string().trim().min(1),
  })
  .passthrough();

const WorkflowStep = z
  .object({
    workflowKey: z.string().trim().min(1).optional(),
    parentWorkflowRunId: z.string().optional(),
    label: z.string().optional(),
    agent: z.string().optional(),
    phase: z.string().trim().min(1).optional(),
    status: z.string().optional(),
    sessionFile: z.string().trim().min(1).optional(),
  })
  .passthrough();

const WorkflowGraph = z
  .object({
    phases: z.array(z.object({ title: z.string().trim().min(1), nodeIds: z.array(z.string()) })),
    nodes: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()),
  })
  .passthrough();

const WorkflowStatus = z
  .object({
    runId: z.string().trim().min(1),
    mode: z.literal("workflow"),
    state: z.string(),
    steps: z.array(WorkflowStep),
    workflowGraph: WorkflowGraph.optional(),
  })
  .passthrough();

export function workflowSubagentId(runId: string): string; // `pi-subagents-workflow:${runId}`
export function workflowRunSubagentId(runId: string, childKey: string): string; // `${workflowSubagentId(runId)}/${childKey}`
export function workflowGroupSubagentId(runId: string, title: string): string; // `${workflowSubagentId(runId)}/group:${title}`

/** Lane title, else phase, else undefined. Pure; exported for tests. */
export function resolveWorkflowGroup(
  status: z.infer<typeof WorkflowStatus>,
  step: z.infer<typeof WorkflowStep>,
): string | undefined;

export interface PiWorkflowTrackerOptions {
  /** Shared with the direct-call path so a transcript is never read twice. */
  readSessions: Set<string>;
}

export interface PiWorkflowTracker {
  launch(details: z.infer<typeof WorkflowLaunchDetails>): PiExtensionCustomMapping;
  recoverMission(mission: unknown): PiExtensionCustomMapping | undefined;
  mapNotice(message: PiCustomMessage): PiExtensionCustomMapping | undefined;
  poll(): PiExtensionCustomMapping | undefined;
}

export function createPiWorkflowTracker(options: PiWorkflowTrackerOptions): PiWorkflowTracker;
```

The tracker keeps, per run id, `{ asyncDir?, polling, groupByKey: Map<string, string | undefined>,
runStatusByKey: Map<string, ProviderSubagentStatus | undefined> }`. It is the in-memory source of
truth for parents and derived group statuses. It emits `{ type: "remove" }` for a group whose last
run moved out.

Server, `index.ts` changes, and nothing else:

- `createSession` builds one tracker with the existing `readSessions` set.
- `mapToolCall`: for `toolName === "subagent"` with a non-running status, check
  `WorkflowLaunchDetails.safeParse(result.details)` before the `Args` gate. On success with a
  non-failed call, return `{ ...tracker.launch(details) }` with no `detail`. All other inputs fall
  through to today's `mapSpawn`. After mapping a successful `subagent` result with validated
  `details.mode`, also merge `tracker.recoverMission(details.mission)` into the output. This applies
  to direct workflow launches, management results, and direct single-call results alike.
- `mapCustomMessage`: when `customType === "subagent-incremental-child-notify"`, return
  `tracker.mapNotice`. When `customType === "subagent-notify"`, try `tracker.mapNotice` first, then
  the existing direct-call handler.
- `poll`: concatenate the existing direct-run poll with `tracker.poll()`. Return `undefined` when
  both are empty.

App, `tree.ts`:

```ts
export interface SubagentTreeRow {
  row: SubagentRow;
  /** 0 for the owner's direct children. */
  depth: number;
  /** Present when the row has visible children and is within the depth cap. */
  disclosure?: { expanded: boolean };
  /** Descendant count shown as "N more" when the depth cap hides children. */
  hiddenDescendantCount: number;
}

export interface LayoutSubagentTreeParams {
  rows: readonly SubagentRow[];
  /** Provider descriptor key → user override; absent means default (expanded iff a running descendant). */
  expansion: ReadonlyMap<string, boolean>;
  /** Owner's provider subagent id, or null for the agent pane. */
  ownerSubagentId: string | null;
  maxDepth: number; // 3
}

/** Depth-first, siblings by createdAt; Paseo rows stay at depth 0 in their current order. */
export function layoutSubagentTree(params: LayoutSubagentTreeParams): SubagentTreeRow[];

export const SUBAGENT_TREE_MAX_DEPTH = 3;
```

App, `select.ts`:

```ts
// ProviderSubagentRow gains:
parentSubagentId: string | null;

/** Every provider descendant of the owner that is not hidden, plus rows kept visible by a running descendant. */
export function selectProviderSubagentDescendants(
  state: ProviderSubagentStoreSnapshot,
  params: SelectSubagentsParams,
  supported: boolean,
  nestingSupported: boolean,
): ProviderSubagentRow[];

/** Tree rows for a track. Merges Paseo rows like `useSubagentsForParent`. */
export function useSubagentTreeForParent(params: SelectSubagentsParams): SubagentTreeRow[];
```

`useSubagentsForParent` stays, unchanged, for the pill, Archive finished, and child track
clearance.

App, `provider-store.ts`:

```ts
trackExpansion: Map<string, boolean>; // key = `${serverId}\0${parentAgentId}\0${subagentId}`, same as descriptors
toggleTrackExpansion(key: string, expanded: boolean): void;
```

App, `track.tsx`: `SubagentsTrackProps` gains `treeRows: SubagentTreeRow[]` and
`onToggleExpansion: (row: ProviderSubagentRow, expanded: boolean) => void`. `rows` stays for the
pill and archive. Each tree row renders inside `ComposerTrackRow`:

- leading padding is `depth * TREE_INDENT_PER_LEVEL` on a new rail ([design.md](../design.md));
- the trailing chevron is a separate icon `ToolbarButton` with an accessibility label;
- the chevron uses `closeOnSelect={false}` semantics and does not call the row's `onPress`.

New i18n keys go in `packages/app/src/i18n/resources/*.ts`:

- `subagents.expandRow` and `subagents.collapseRow` (accessibility labels);
- `subagents.moreDescendants` (plural `{{count}} more`).

### 2.4 Status and grouping policy

One policy table in `workflow.ts`. Values outside it map to "no status" (an upsert that omits
`status`), so the store keeps what it has.

| Source                      | Value                              | Descriptor status               |
| --------------------------- | ---------------------------------- | ------------------------------- |
| workflow `state`            | `queued`, `running`                | `running`                       |
|                             | `complete`                         | `completed`                     |
|                             | `failed`, `partial`, `rejected`    | `failed`                        |
|                             | `stopped`                          | `canceled`                      |
|                             | `paused`                           | none (keep polling)             |
| step `status`               | `pending`, `queued`, `running`     | `running`                       |
|                             | `completed`, `complete`            | `completed`                     |
|                             | `failed`, `error`                  | `failed`                        |
|                             | `stopped`                          | `canceled`                      |
|                             | `paused`                           | none                            |
| incremental notice outcome  | `completed` / `failed` / `stopped` | `completed`/`failed`/`canceled` |
|                             | `paused`                           | none                            |
| terminal `Child runs` entry | step-status vocabulary above       | same as step                    |
| terminal header             | `noticeStatus`                     | workflow status                 |

Group status is derived from the group's runs, checked top to bottom:

1. `running` if any run is `running`, or the group is a lane whose `workflowGraph` nodes include
   `pending` or `running` stages;
2. `failed` if any run is `failed`;
3. `canceled` if any run is `canceled`;
4. `completed` otherwise.

Group `subtitle` is the `title` of its most recently created run. The Workflow's `subtitle` is
`"<finished groups> of <groups> groups done"` when it has groups. Without groups it is
`"<finished runs> of <runs> runs done"`.

Rules:

- The workflow descriptor gets `status: "running"` only from `launch` (live proof of a launch) or
  a polled `state`. On replay, a workflow descriptor first created by an incremental notice is
  upserted without status, and the store default (`running`) applies until terminal evidence
  arrives. This matches how a replayed direct async call behaves today. An incremental notice's
  `Status: workflow still running` line never sets status.
- A workflow reaching a terminal state never infers a status for a run without terminal evidence.
- `toolCallId` is omitted on workflow, group and run descriptors. Replay cannot recover the nested
  call id, and the app does not use the field.

### 2.5 Identity and de-duplication

- Ids key on the workflow run id, the child key, and the group title.
  - Run id and child key appear in both live and replay evidence.
  - Group titles come only from `status.json`, which both paths read.
  - pi-subagents rejects duplicate child keys within a workflow (`workflow-receipt.ts:53`).
  - Lane and phase titles share one namespace, so a lane `T1` and a phase `T1` in the same
    workflow merge into one group. Lanes win for runs that are in a lane.
- A `subagent` result with `mode: "workflow"` never also produces a call-id-based descriptor.
- `status.json` steps without `workflowKey` (host steps) are skipped.
- `readSessions` dedupes transcripts across direct and workflow paths, and the tracker keeps one
  entry per run id. A repeated `launch` for the same run id only re-emits the workflow upsert.

### 2.6 Error handling and conventions

- Every parse uses Zod `safeParse` or a line regex. A failure returns `undefined` for that input
  and is not thrown. The adapter contract has no logger, and the host's `safe()` logs anything
  thrown.
- `status.json` reads are synchronous and bounded to one file per tracked run per tick, like the
  existing `poll`. ENOENT and JSON errors skip the tick. After a terminal state, polling for that
  run stops.
- A terminal-notice `status.json` read that fails, for example because retention removed the dir,
  still emits the notice's statuses and omits groups and transcripts.
- App: `layoutSubagentTree` is pure and total. A row whose `parentSubagentId` points at a missing
  or hidden descriptor attaches to the nearest visible ancestor, or to depth 0 if none. Cycles are
  impossible from the server; the layout guards with a visited set anyway, because the input is
  untyped wire data.
- No `as` casts, no `any`, and named object types in signatures, per
  [coding-standards.md](../coding-standards.md). App code follows [design.md](../design.md) (tree
  rail, trailing disclosure chevron), [hover.md](../hover.md) (separate inner press target), and
  [unistyles.md](../unistyles.md) (no `useUnistyles()`). Comments explain the why only.

## 3. Tasks

Run commands from the repo root after
`export PI_EXT=packages/server/src/server/agent/providers/pi/extensions`. Each worker runs its own
targeted command once after its final edit and pastes raw output.

### Wave 1 (parallel; disjoint files)

**S1: Capture provenance fixtures and the scripted Pi harness**

- Goal: deterministic, sanitized evidence of the real contracts, and a reusable scripted Pi setup.
- Owned files:
  - `$PI_EXT/pi-subagents/fixtures/workflow/**` (new)
  - `packages/server/src/server/daemon-e2e/fixtures/pi-scripted-workflow/**` (new): a Pi extension
    that registers a `paseo-scripted` provider through `pi.registerProvider(name, { streamSimple })`,
    plus agent definitions `worker` and `reviewer`, and a `settings.json` template.
- Produces:
  - `workflow-codemode.json`: `{ provenance, events, messages }` in the existing `Fixture` shape,
    with exactly the five provenance keys `readSubagentFixture` asserts. The scripted parent emits
    one codemode call whose workflow script runs:
    - `runs.run("T1-implement", { phase: "T1", … })`;
    - `runs.run("T1-review-1", { phase: "T1", … })`;
    - `runs.lanes([{ key: "T2", stages: [implement, review] }])`;
    - `runs.run("cleanup", { … })` with no phase.

    The run `T2.review` (in lane `T2`) waits on a gate file, so a `running` snapshot exists. The
    fixture covers the nested `subagent` start/end, the incremental notices, the terminal
    workflow `subagent-notify`, and `get_messages` after settle.

  - `status-running.json` and `status-complete.json`: sanitized `status.json` snapshots, including
    `steps[].phase` and `workflowGraph`.
  - `child-<key>.jsonl` for each run.
  - `real-notices.json`: sanitized excerpt of the observed session. It holds lines 104, 106, and
    118 reduced to `customType`, `content`, and `display`, plus the codemode `toolResult`'s
    `nestedCalls`. All absolute paths become placeholders and task text is stripped. Provenance is
    pi-subagents `0.71.0`, Pi `1.0.4`, capture date `2026-10-31`.
  - Placeholders: `__ASYNC_DIR__` and `__CHILD_SESSION_<key>__`. Tests substitute temp paths.

- Capture procedure:
  - Use an isolated `PI_CODING_AGENT_DIR` and `PI_SUBAGENTS_TEMP_ROOT` under
    `.dev/pi-workflow-capture/` (untracked).
  - Settings list only the pi-subagents `0.71.0` store path and the scripted extension, with
    `defaultTools: ["+codemode"]`.
  - Run `pi --mode rpc` driven by a throwaway recorder script kept in `.dev/`. Copy `status.json`
    at the running and complete points.
  - Get `sourceCommit` for pi-subagents 0.71.0 from the existing fixtures (`4af5e85a…`) after
    confirming it with the package's metadata.
- Stop rule: if child processes cannot load the scripted provider, stop and report `NEEDS_CONTEXT`.
  The fallback is a real cheap model, which needs user approval for cost.
- Dependencies: none.
- Check:
  `rg -n -P '/home/|pi-subagents-uid|sinkerine|keepass|keeshare' $PI_EXT/pi-subagents/fixtures/workflow`
  must print nothing. Also run
  `node -e 'for (const f of process.argv.slice(1)) JSON.parse(require("fs").readFileSync(f,"utf8"))' $PI_EXT/pi-subagents/fixtures/workflow/*.json`.

**S2: Notice parsers and workflow tracker**

- Goal: §2.3 `notice.ts` and `workflow.ts`, including the §2.4 policies and the §2.5/§2.6 rules.
- Owned files: `$PI_EXT/pi-subagents/notice.ts`, `$PI_EXT/pi-subagents/workflow.ts`,
  `$PI_EXT/pi-subagents/workflow.test.ts` (all new).
- Consumes: `PiExtensionCustomMapping` and `PiChildSessionFile` from `contract.ts`,
  `ProviderSubagentStatus` from `provider-subagents/store.ts`, and `PiAgentMessage` from
  `rpc-types.ts`. Produces: the §2.3 exports.
- Tests use real temp dirs and inline notice strings copied verbatim from §0:
  - launch emits a running Workflow;
  - poll grows runs by key without duplicating, and a re-run key is distinct;
  - grouping order (lane beats phase beats none) and re-parenting when `phase` changes;
  - a group emptied by re-parenting emits `remove`;
  - derived group status, including a lane with pending stages staying `running`;
  - every status-table row;
  - a mismatched `runId`/`mode` in `status.json` is ignored;
  - a foreign `parentWorkflowRunId` step is ignored;
  - incremental notices on a fresh tracker create the Workflow without status and a run under it;
  - `Output:` lines never change status;
  - a terminal notice settles the workflow and runs, and re-parents into groups from a matching
    `status.json`;
  - a terminal notice whose dir basename differs from its run id returns undefined;
  - a missing dir still settles statuses;
  - malformed inputs return undefined.
- Dependencies: none.
- Command:
  `(cd packages/server && npx vitest run src/server/agent/providers/pi/extensions/pi-subagents/workflow.test.ts --bail=1)`

**A1: Tree layout and descendant selection**

- Goal: §2.3 `tree.ts`, plus `selectProviderSubagentDescendants` and the `parentSubagentId` row
  field in `select.ts`.
- Owned files: `packages/app/src/subagents/tree.ts` (new), `packages/app/src/subagents/tree.test.ts`
  (new), `packages/app/src/subagents/select.ts`, `packages/app/src/subagents/select.test.ts`.
- Produces: `layoutSubagentTree`, `SubagentTreeRow`, `SUBAGENT_TREE_MAX_DEPTH`,
  `selectProviderSubagentDescendants`, and `ProviderSubagentRow.parentSubagentId`.
  `useSubagentTreeForParent` is added in A3.
- Tests cover:
  - depth-first order with siblings by `createdAt`;
  - Paseo rows at depth 0;
  - default expansion (a running descendant expands);
  - override precedence;
  - depth cap and the "more" count;
  - orphan attach;
  - cycle guard;
  - a hidden subtree, and a running descendant keeping its ancestors visible;
  - descendant selection for agent owners and provider-subagent owners;
  - the gate off returning today's flat rows.
- Dependencies: none.
- Command:
  `(cd packages/app && npx vitest run src/subagents/tree.test.ts src/subagents/select.test.ts --bail=1)`

### Wave 2 (parallel; disjoint files)

**S3: Route workflows through the adapter**

- Goal: the §2.3 `index.ts` changes, plus fixture-driven live and replay coverage.
- Owned files: `$PI_EXT/pi-subagents/index.ts`, `$PI_EXT/pi-subagents/index.test.ts`.
- Consumes: S1 fixtures and S2 exports.
- Tests added to `index.test.ts`:
  - **Captured codemode workflow, live and replay.** Substitute placeholders with a temp dir
    seeded from `status-complete.json` and the child transcripts. Feed `events` to `FakePi` and
    replay `messages` through `streamPiHistory`. Reduce each event list through a fresh real
    `ProviderSubagentStore` and compare the results without timestamps. Assert the exact tree:
    - Workflow
      - group `T1`: `T1-implement`, `T1-review-1`
      - group `T2`: `T2.implement`, `T2.review`
      - `cleanup`, directly under the Workflow

    Also assert equal per-run timeline counts. Don't use `verifySubagentFixture`'s event-sequence
    equality: live has launch and poll events that replay cannot have.

  - **Live lifecycle.** With the host following, swap `status-running.json` to
    `status-complete.json`. Assert `T2.review` goes `running → completed`, with timeline rows
    before completion, and that group `T2` goes `running → completed`.
  - **Real notices.** `real-notices.json` notices alone produce Workflow `38e069c4…` with runs
    `T1-implement` and `T1-review-1` completed directly under it, and nothing for `T1-fix-1`.
  - **Decoy.** A second workflow dir beside the fixture dir is never read; no descriptor carries
    its run id.
  - All existing tests stay unchanged (AC8).

- Dependencies: S1, S2.
- Command:
  `(cd packages/server && npx vitest run src/server/agent/providers/pi/extensions/pi-subagents/index.test.ts --bail=1)`

**A2: Expansion state**

- Goal: `trackExpansion` and `toggleTrackExpansion` in the provider store. Overrides are cleared
  when their descriptor is removed.
- Owned files: `packages/app/src/subagents/provider-store.ts`,
  `packages/app/src/subagents/provider-store.test.ts`.
- Dependencies: none on S1/S2/S3; it is placed in wave 2 only to keep wave 1 small. It is
  independent of A1.
- Command:
  `(cd packages/app && npx vitest run src/subagents/provider-store.test.ts --bail=1)`

### Wave 3 (parallel; disjoint files)

**A3: Render the tree**

- Goal: the §2.3 `track.tsx` rendering, `useSubagentTreeForParent`, the call-site wiring, and the
  i18n keys.
- Owned files:
  - `packages/app/src/subagents/track.tsx`
  - `packages/app/src/subagents/use-subagent-tree.ts` (new; holds `useSubagentTreeForParent`, so
    `select.ts` stays A1's)
  - `packages/app/src/subagents/index.ts`
  - `packages/app/src/panels/agent-tracks.tsx`
  - `packages/app/src/panels/agent-panel.tsx` (only if `agent-tracks` needs the tree rows passed
    in)
  - `packages/app/src/panels/provider-subagent-panel.tsx`
  - `packages/app/src/i18n/resources/*.ts` (the three keys in every locale)
- Consumes: A1 and A2.
- Tests: pure logic is already covered by A1 and A2. This task adds no JSDOM or component tests
  ([testing.md](../testing.md)). Its proof is A4.
- Dependencies: A1, A2.
- Command:
  `(cd packages/app && npx vitest run src/subagents/track-presentation.test.ts src/i18n/resources.test.ts src/i18n/locales.test.ts --bail=1)`
  confirms presentation and locale parity still hold.

**S4: Docs**

- Goal: one paragraph integrated into the Pi extension adapters paragraph of `docs/providers.md`,
  covering:
  - nested codemode calls reach adapters as `tool_execution_*` with `<outer>/<n>` ids;
  - persisted history keeps only `nestedCalls` metadata, so replay must key off extension notices
    and artifacts they name;
  - adapters read only artifacts the session itself names.

  Also rewrite the subagents-track paragraph in `docs/agent-lifecycle.md` (§ "The subagents
  track") so it describes the tree: descendants shown inline, disclosure defaults, the depth cap,
  and the pill counting direct children. Follow the doc voice rules in `CLAUDE.md`.

- Owned files: `docs/providers.md`, `docs/agent-lifecycle.md`.
- Dependencies: S2 and A1 (final behavior).
- Command:
  `npm run format:files -- docs/providers.md docs/agent-lifecycle.md`

### Wave 4 (parallel; disjoint files)

**S5: Local daemon E2E**

- Goal: the §5 daemon journey as an automated `*.local.e2e.test.ts`. It needs the local `pi`
  binary and the pi-subagents store path, and no credentials.
- Owned files: `packages/server/src/server/daemon-e2e/pi-workflow-subagents.local.e2e.test.ts`
  (new).
- Consumes: S1's scripted harness and S3's behavior. Uses `createPaseoDaemon` (listen
  `127.0.0.1:0`, temp `paseoHome`), `DaemonClient` (`appVersion: "0.1.70"`),
  `listProviderSubagents`, and the provider subagent timeline fetch. Restart follows
  `daemon-restart-resume.e2e.test.ts`.
- Skip reason: when `PASEO_PI_SUBAGENTS_PACKAGE` or `pi` is unavailable, the test is skipped with
  an explicit reason. It is never silently green.
- Dependencies: S3.
- Command:
  `(cd packages/server && npx vitest run src/server/daemon-e2e/pi-workflow-subagents.local.e2e.test.ts --bail=1 > ../../.dev/pi-workflow-e2e.txt 2>&1); tail -50 .dev/pi-workflow-e2e.txt`

**A4: Browser journey for the tree**

- Goal: the §5 UI journey as a Playwright spec using S1's scripted Pi harness.
- Owned files: `packages/app/e2e/browser/pi-workflow-subagent-tree.real.spec.ts` (new),
  `packages/app/e2e/support/helpers/pi-workflow.ts` (new).
- The spec uses the `.real.spec.ts` suffix because it needs a local Pi binary, so default CI
  skips it.
- The helper launches a Pi agent through the existing `launchAgent` helper, with the scripted Pi
  env (`PI_CODING_AGENT_DIR`, `PI_SUBAGENTS_TEMP_ROOT`, gate path) set through provider config. If
  the per-worker daemon cannot receive provider env, stop and report `NEEDS_CONTEXT`.
- Consumes: S1, S3, A3.
- Dependencies: S3, A3.
- Command:
  `(cd packages/app && npx playwright test e2e/browser/pi-workflow-subagent-tree.real.spec.ts --project=<the browser project used by provider-subagents.real.spec.ts> > ../../.dev/pi-workflow-browser.txt 2>&1); tail -60 .dev/pi-workflow-browser.txt`

## 4. Test and verification

Per task (worker, after the final edit): the targeted command listed for that task, run once, raw
output pasted.

After integration (orchestrator, independent evidence):

1. `npm run typecheck`
2. `npm run lint -- <every file changed by S2, S3, S5, A1, A2, A3, A4>`
3. `npm run format:check`. If it fails, run `npm run format:files -- <the same files> docs/providers.md docs/agent-lifecycle.md`
   and re-check.
4. Run each server unit file once: `workflow.test.ts`, `index.test.ts`.
5. Run each app unit command once (A1, A2, A3).
6. Run S5's E2E once and A4's browser spec once.
7. **Cross-provider regression.** The tree changes how Claude's nested provider subagents render.
   `provider-subagents.real.spec.ts` and `claude-workflow-subagent.real.spec.ts` cover them but
   spend Claude credits, so ask the user before running them locally. Otherwise defer them to CI
   or a credentialed run, and record that they were not run.

Builds: none expected. No protocol or client types change. If typecheck reports cross-package
declaration errors, run `npm run build:server` (server/CLI) or `npm run build:client` before
diagnosing.

Repeat-run rule: the repo forbids re-running a suite another agent already reported green. That
applies to unchanged code. Each workflow invocation leaves a new post-edit state, so the
orchestrator's run of steps 1–6 is the first green for that state and is required. If a reviewer
ran exactly these commands on the exact final tree (same `git diff` hash, recorded in its report),
the orchestrator cites that output instead of rerunning. Never run `npm run test` or a workspace
suite.

QA platform table (per [qa.md](../qa.md)): web (A4), compact layout (A4 at phone width), and
desktop Linux daemon (S5) are covered. iOS and Android are not run; the change is shared RN code
with no platform gates. Record that in the PR table.

## 5. E2E journey

The real isolated daemon and the real Pi `1.0.4` + pi-subagents `0.71.0` workflow run under
codemode with the scripted provider. Port 6767 and `~/.paseo` are never touched.

Setup (inside S5's test, all under one `mkdtemp` root `$ROOT`):

- `$ROOT/pi-agent`: scripted `settings.json` (packages: pi-subagents store path and
  `fixtures/pi-scripted-workflow`; `defaultTools: ["+codemode"]`; default provider
  `paseo-scripted`), plus `agents/worker.md` and `agents/reviewer.md`.
- `$ROOT/subagents-tmp` (`PI_SUBAGENTS_TEMP_ROOT`). It is seeded with the decoy
  `async-subagent-runs/decoy-run/status.json`: `mode: "workflow"`, `state: "running"`, and a step
  with `phase: "T1"` whose `sessionFile` points at `$ROOT/decoy/session.jsonl`, which holds one
  assistant line `DECOY`.
- `$ROOT/paseo-home`, `$ROOT/work` (agent cwd), and `$ROOT/gate` (absent at start).
- Daemon: `createPaseoDaemon({ listen: "127.0.0.1:0", paseoHome, … })` with the Pi provider env
  `{ PI_CODING_AGENT_DIR, PI_SUBAGENTS_TEMP_ROOT, PASEO_SCRIPTED_GATE: $ROOT/gate }` set through
  `providerOverrides.pi.env` (`provider-launch-config.ts:46`).

Daemon steps (S5):

1. Create a Pi agent in `$ROOT/work` and send `RUN_WORKFLOW`.
2. Poll `listProviderSubagents(agentId)` until the tree in S3's fixture test exists:
   - Workflow `running`;
   - group `T1` `completed`;
   - group `T2` `running`, with `T2.implement` `completed` and `T2.review` `running`;
   - `cleanup` not started yet, or present only once its step exists.

   The `T2.review` timeline fetch contains the scripted `bash` tool call before the gate opens.

3. Create `$ROOT/gate`. Poll until every run, both groups, and the Workflow are `completed`. The
   `T2.review` timeline contains the scripted final text.
4. Assert the exact descriptor set: 1 workflow, 2 groups and 5 runs, all with unique ids and
   correct parents. None contains `decoy-run`, and no timeline contains `DECOY`.
5. Reload: stop the daemon, start a new one on the same `paseoHome`, reconnect, and trigger
   history replay. Fetching the agent timeline resumes it, as in `daemon-restart-resume.e2e`.
   Assert the same descriptor set (id, title, subtitle, status, parentSubagentId), non-empty run
   timelines, and no duplicates or decoy.
6. Cleanup (in `finally`): close the client, `daemon.stop()`, then assert no process command line
   contains `$ROOT` (`ps -eo args`). If any remain, kill them and fail the test. Then
   `rm -rf $ROOT`.

UI steps (A4, Playwright, per-worker isolated daemon from the app harness):

1. Launch the scripted Pi agent and send `RUN_WORKFLOW`. Open the subagents track.
2. Assert the rows, indentation (each depth one `TREE_INDENT_PER_LEVEL` further than its parent,
   measured from row bounding boxes) and chevrons:
   - `Workflow` is expanded;
   - `T1` is collapsed (finished);
   - `T2` is expanded, with `T2.review` running;
   - `cleanup` sits at depth 1 once present.

   Attach a screenshot.

3. Press the `T1` chevron. Its runs appear and the panel stays open. Press `T1` again to collapse.
   Close and reopen the panel; `T1` keeps the user's choice.
4. Press the `T2.review` row body. Its provider-subagent pane opens and shows the scripted `bash`
   row.
5. Open the gate. `T2` and `Workflow` turn completed in place and default-collapse, with no row
   reordering. Attach a screenshot.
6. Resize to phone width (compact sheet) and repeat step 2's assertions. Attach a screenshot.
7. Reload the page. The tree is rebuilt from the daemon with the same rows; overrides reset to
   defaults.
8. Cleanup is owned by the harness fixtures (project and agent records, daemon, temp dirs).

The orchestrator attaches S5's output, A4's report and its screenshots as PR evidence.

## 6. Risks, follow-ups, open questions

- **Grouping depends on the script.** Without `phase` or lanes, runs sit flat under the Workflow.
  For the keeshare orchestrator, add `phase: item.id` to each `runs.run` in its script. This is a
  script change, not Paseo work.
- **Cross-provider change.** Claude nested provider subagents also become inline tree rows (AC11).
  The pill and Archive finished keep their direct-child semantics. The Claude real specs are the
  regression check (§4 step 7).
- **Follow-up: nesting by actual spawning.** A run that spawns its own subagents keeps those
  inside its own session. Mapping them needs the child-session reader to run extension adapters.
  The tree already renders it if the server emits it.
- **Follow-up: codemode single async calls.** A codemode `tools.subagent({agent, task, async:true})`
  maps live, but replay loses it: the nested result is not persisted, and the direct-call notice
  handler keys on the call id. A fix needs run-id-based ids for that path, which changes
  direct-call ids, so it is excluded here.
- **Follow-up: foreground workflows** (`mode: "workflow"` without `asyncDir`) remain unmapped, as
  today.
- **Risk: idle runtime collection.** Paseo collects idle Pi runtimes ("Collected idle agent
  runtime" for this agent at earlier times). Because the workflow orchestrator lives in the parent
  Pi process, collecting it mid-workflow stops the workflow. pi-subagents
  `docs/extension-api.md` describes the host-side liveness rule (live `queued`/`running` async
  runs). It did not happen in this incident: the last resume was at 01:04:41Z and the launch at
  01:07:41Z, with no collection since. This needs its own investigation.
- **Risk: terminal notice format.** The terminal workflow `subagent-notify` has not been observed
  in the real session yet (the workflow is still running). S1's capture is the source of truth,
  and S2's parser follows it.
- **Not available from pi-subagents:** wave and dependency labels ("after T1, T2") and reviewer
  verdicts ("accepted (2 rounds)"). The group subtitle shows the latest run's title instead.
