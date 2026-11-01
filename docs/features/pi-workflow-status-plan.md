# Pi subagent workflows in workspace status — plan

Status: **superseded by user-approved Option C (2026-10-31)**

## Current reconciliation contract — Option C

The original plan below records evidence from Pi 1.0.4 / pi-subagents 0.71.0. Preserve it as historical evidence; its workflow identity, discovery and lifecycle rules are superseded here.

The current user environment is Pi 1.4.0 / pi-subagents 0.84.0 (`/nix/store/spwn6yyrml8by6wpw6l4a0f0jhybs9m9-pi-subagents-0.84.0`). In that version, `subagent-executor.ts:4830,6525` completes dispatch with uncollected running children and freezes the artifact through `persistClosed`. Later incremental notices carry `workflowRunning=false`. Paused dispatch detaches children (`:6554`); children settle later and resume uses a new run ID. `parentWorkflowRunId` is always stamped (`:4371`). Stale reconciliation requires a later process, so owner death is the missing evidence Paseo must handle.

- Keep main's `workflow.ts` and `notice.ts` tree: `pi-subagents-workflow:<runId>`, groups, keyed child runs, presentation, explicit status policy, and incremental/terminal notices.
- Paused workflow or child status adds no lifecycle evidence. Keep polling. A terminal workflow never infers child lifecycle; explicit running children remain running until their own evidence settles them.
- For queued/running/paused artifacts, a recorded PID returning ESRCH cancels the Workflow and children without explicit final evidence, then stops polling. EPERM means alive; no PID means unknown. Terminal dispatch with unsettled children keeps checking owner liveness too. Preserve completed, failed and canceled child evidence on live tracking and replay.
- Require exact `parentWorkflowRunId === runId` for steps and transcripts. Reject a launch when an artifact's `toolCallId` differs from the launching call ID. No missing-parent exception.
- Codemode workflows arrive only through nested `<outer>/<n>` subagent execution events. Remove the runtime bridge, codemode output parsing and temp-root discovery. Replay uses persisted notices and the artifacts they name.
- Keep `async-runs.ts` only for ordinary non-workflow runs: per-step status, partial/paused/rejected handling, multi-step owner settlement, dead-owner checks, row diffing, complete/completed compatibility, and transcript re-follow on resume.
- Retain main's workflow fixtures and tests. Remove superseded feature workflow fixtures/tests; retain historical QA evidence. Real E2E is rerun against the current Pi/extension versions after integration.

Current-version E2E launches `subagent` directly through the model. Pi 1.4 documents `model-only` tools as unavailable to `codemode` / `ctx.executeTool`, and pi-subagents 0.84 registers `subagent` with that exposure. The historical `tools.subagent` journey returns `TypeError: tools.subagent does not exist`. Current codemode launch validation is unsupported, not passed; historical nested-event fixtures remain the adapter compatibility proof. Do not override provider exposure to manufacture an E2E pass.

## Remaining work on current main (2026-10-31)

The user authorized implementation directly in the main checkout and skipped design.
The Option C contract above remains authoritative; the original tasks below are historical.

### T1 — settle groups after terminal dispatch

Wave 1; dependencies: none. Own `packages/server/src/server/agent/providers/pi/extensions/pi-subagents/workflow.ts` and its adjacent `workflow.test.ts`; extend `index.test.ts` only if adapter replay coverage is needed. Keep the existing tracker interfaces unchanged.

A frozen terminal artifact can retain pending/running graph nodes after later notices explicitly settle every child. Prevent those stale nodes from keeping a group running. Preserve active-dispatch lane tracking between stages and preserve explicitly running children after terminal dispatch. Cover completed, failed and canceled child evidence, repeated artifact observations, and notice replay.

Unit proof, from `packages/server`:
`npx vitest run src/server/agent/providers/pi/extensions/pi-subagents/workflow.test.ts --bail=1`.
Adapter integration proof from the same directory:
`npx vitest run src/server/agent/providers/pi/extensions/pi-subagents/index.test.ts --bail=1`.

### Current verification and E2E

Run repository typecheck, lint and formatting after the final edit; rebuild workspace declarations before diagnosing cross-package type failures. Run only targeted suites.

Use the existing `packages/server/src/server/daemon-e2e/pi-workflow-subagents.local.e2e.test.ts` with Pi 1.4.0 and pi-subagents 0.84.0 for live execution, idle-parent activity, isolation, completion, restart/replay, failure, stop and owner death. Use `packages/app/e2e/browser/pi-workflow-subagent-tree.real.spec.ts` for wide/compact trees, panes, settlement and reload. These harnesses must own isolated daemon state and clean it up; never restart production port 6767. Retain current raw evidence alongside historical QA. Current codemode model-only launch remains unsupported as specified above.

## Original approved plan (historical)

Status: **approved by the user (2026-10-30); superseded above**
Branch: `fix-pi-subagent-workflow-status-indicator` (base `08ea9a1d5`, `origin/main`)

## Problem

A Pi parent agent that launches an async pi-subagents **workflow** (`subagent({ workflowScript | workflowScriptPath | workflow, async: true })`), directly or from inside Pi's built-in `codemode` tool, returns control at once. The parent goes idle while the workflow children keep working. Paseo does not surface the workflow, so the workspace indicator turns grey. Reported case: agent `cc312c84…`, workspace `wks_bf0a7ccd6399461e`, workflow `38e069c4…`, launched from codemode.

Root causes in `packages/server/src/server/agent/providers/pi/extensions/pi-subagents/index.ts`:

1. `mapSpawn` returns `undefined` unless `args.agent` **and** `args.task` are set, so all three workflow forms are ignored.
2. Only `toolName === "subagent"` is mapped. A codemode call has `toolName: "codemode"`, and its result does not carry the nested call's `details`.
3. `asyncChildStatus` reports **every** step `running` while the run is non-terminal, even completed ones. It treats only `complete | failed | stopped` as terminal, but 0.71 also writes `partial`, `paused` and `rejected`, so those runs poll forever and stay `running`.
4. When a run with more than one step ends without a `subagent-notify` (a stop caused by a reload, or a crash), the owner row (`id = callId`) keeps its `running` status from launch. That is a phantom running parent entry.
5. `poll()` re-emits an upsert for every step on every 250 ms tick, which churns `updatedAt` and the clients.

No app change is needed. `workspace-directory.ts` `applyProviderSubagentContributions` already counts a parent's `running` provider subagents toward the parent's workspace, and the app trusts the daemon's workspace status.

## Observable contract (pi-subagents 0.71.0, Pi 1.0.4; verified against real data)

Sources: installed package `/nix/store/4ia9lbk2…-pi-subagents-0.71.0`, the real run dir `/tmp/pi-subagents-uid-1000/async-subagent-runs/38e069c4…/`, and the persisted parent session (read-only).

| Fact                              | Where                                        | Shape                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Direct async workflow tool result | `subagent-executor.ts:6077`                  | `content: "…Async workflow [<runId>]…"`, `details: { mode: "workflow", runId, asyncId, asyncDir, toolCallId, results: [], workflow, workflowChildren }`                                                                                                                                                                  |
| Codemode tool result              | Pi built-in `codemode`                       | `toolName: "codemode"`, content text contains the nested output (`Async workflow [<runId>]`, or `Async: <agent> [<runId>]` for single runs), `details.calls[]: { id: "<codemodeCallId>/<n>", name: "subagent", args: <truncated string>, status: "ok"\|"error" }`. There is no nested `details`. **Don't parse `args`.** |
| Run status                        | `<asyncDir>/status.json`                     | `{ runId, toolCallId, sessionId, mode: "workflow", state, pid, steps[], endedAt?, error? }`. `toolCallId` is the exact nested id (`call_47d…/1` for codemode, the plain call id when direct). For workflows, `pid` is the owning Pi process, because the workflow script runs in the parent.                             |
| Run states                        | `async-status.ts`                            | `queued`, `running` (active); `complete`, `failed`, `partial`, `stopped`, `rejected` (terminal); `paused` (inactive, can be resumed)                                                                                                                                                                                     |
| Workflow steps                    | `status.json.steps[]`                        | Appended as the script launches children. Each step has `{ agent, label, workflowKey, runId, status, sessionFile, error? }`. `workflowKey` is unique within a workflow and present from launch. Step `status` is one of `pending`, `running`, `completed`, `failed`, `paused`, `stopped`, `rejected`, `detached`.        |
| Async start event                 | `pi.events` `"subagent:async-started"`       | `{ id, asyncDir, mode, sessionId, pid, parentWorkflowRunId?, workflowKey? }`. Emitted for the workflow (`mode: "workflow"`) and again for each child it launches (those carry `parentWorkflowRunId`). Emitted before the tool result.                                                                                    |
| Completion notice                 | `subagent-notify` custom message (persisted) | First line `Background task <completed\|failed\|paused\|stopped>: **workflow**`; includes `Retention-managed async directory: <asyncDir>` and `Workflow run: <id>`. **Not written** when the owner process dies or reloads.                                                                                              |
| Async root                        | `shared/types.ts:2808`                       | `$PI_SUBAGENTS_TEMP_ROOT` or `os.tmpdir()/pi-subagents-uid-<uid>`, then `/async-subagent-runs/<runId>`                                                                                                                                                                                                                   |
| Reload behaviour                  | real run `38e069c4`                          | When the Pi session is replaced or reloaded, pi-subagents writes `state: "stopped"` and `error: "Workflow stopped because the extension session was replaced or reloaded."`. A Paseo daemon restart kills Pi, so a workflow never survives one.                                                                          |

## Goal and acceptance criteria

Goal: while a Pi workflow launched by an agent is active, the agent's workspace shows **running**, even when the parent is idle. When the workflow ends for any reason, no `running` entries remain.

- **AC1 — direct workflow.** `subagent({ workflowScript | workflowScriptPath | workflow, async: true })` creates a workflow row (`running`) when the tool starts. Each step appears as a child row as soon as `status.json` lists it, with that step's own status.
- **AC2 — codemode workflow.** A `codemode` call whose nested `subagent` launched an async workflow produces the same workflow row and step rows, owned by that codemode call. Ownership is proven by `status.json.toolCallId` starting with `<codemodeCallId>/`.
- **AC3 — idle parent.** After the parent's turn ends, the workspace descriptor stays `running` while any workflow row or step row is `running`. Between steps (one finished, the next not yet launched) the workflow row keeps it `running`. No app change.
- **AC4 — step accuracy.** Completed steps show `completed` while the workflow runs. Step identity stays stable as the list grows: the id comes from `workflowKey`, not the list index.
- **AC5 — terminal.** Run `complete`, `failed`, `partial`, `stopped` or `rejected` settles the workflow row and every step row to a non-running status, and polling stops. `paused` reports no running rows but keeps polling, so a resume flips the run back to running. The owner row settles even when no `subagent-notify` arrives.
- **AC6 — dead owner.** A non-terminal `status.json` whose `pid` is not alive is treated as `stopped`: rows become `canceled`.
- **AC7 — replay/reload.** History replay (`streamHistory`) reconstructs workflow rows from the persisted tool results and the current `status.json`. It never yields a `running` row for a run that is terminal or has a dead owner. The real `38e069c4` shape replays as 17 completed steps, 1 canceled step and a canceled workflow row.
- **AC8 — no churn.** `poll()` emits an upsert for a row only when its status, title or parent changed, or when a new child session file appears.
- **AC9 — regressions.** The existing ordinary pi-subagents single, parallel and chain flows, `bg_wait` and `subagent-notify` tests pass unchanged. The single-step async id scheme (`id = callId`) is preserved.
- **AC10 — isolation.** Rows belong only to the parent agent whose tool call owns the run. A second Pi agent, in another workspace or the same one, never picks up a run it did not launch. Unknown, unreadable or mismatched `status.json` produces no rows.

Out of scope: explicit `async: true` children _inside_ a workflow (the step reports `detached`; Paseo shows it `completed` because the workflow no longer owns it); attaching to workflows launched before the daemon saw the call; the app UI.

## Design

### Boundaries

All changes stay inside the pi-subagents Pi extension adapter (`extensions/pi-subagents/`) plus one bridge string it contributes. No changes to `contract.ts`, `host.ts`, `agent.ts`, `history-mapper.ts`, the protocol, `workspace-directory.ts` or the app. `docs/providers.md` already says `agent.ts`, `history-mapper.ts` and `tool-call-mapper.ts` never name an extension, and this design keeps that true.

### Module layout

```
extensions/pi-subagents/
  index.ts           adapter wiring (mapToolCall / mapCustomMessage / mapRuntimeNotification / poll)
  async-runs.ts      NEW: status.json reading, status mapping, row diffing (pure + fs read)
  runtime-bridge.ts  NEW: bridge source string + marker constant
  async-runs.test.ts NEW: unit tests for async-runs.ts
  index.test.ts      extended: adapter-level + FakePi + replay tests
  fixtures/workflow-direct.json    NEW captured fixture
  fixtures/workflow-codemode.json  NEW captured fixture
```

### Runtime bridge (live asyncDir discovery)

`runtime-bridge.ts`:

```ts
export const PI_SUBAGENTS_ASYNC_STARTED_MARKER = "PASEO_PI_SUBAGENTS_ASYNC_STARTED";
export const piSubagentsRuntimeBridge: string; // JS statements, `pi` in scope
```

The bridge source:

```js
pi.events.on("subagent:async-started", (event) => {
  if (!event || typeof event.id !== "string" || typeof event.asyncDir !== "string") return;
  if (event.parentWorkflowRunId) return; // workflow children are tracked through the workflow's status.json
  piSubagentsCtx?.ui.notify(
    MARKER + " " + JSON.stringify({ id: event.id, asyncDir: event.asyncDir }),
    "info",
  );
});
```

`piSubagentsCtx` is captured on `session_start`, following the gotgenes bridge pattern. The bridge only teaches the adapter the run id → asyncDir mapping. It never creates rows, which avoids duplicating rows that tool calls own. The notify reaches `mapRuntimeNotification`, which stores the mapping in `knownDirs` and returns an empty mapping (`{ subagents: [] }`) so the host claims the message and nothing appears in the timeline. Pi writes the notify to the same stdout stream before the tool result, so a codemode result always finds its dir live.

### Async run registry (`async-runs.ts`)

```ts
export type AsyncRunState = "active" | "paused" | "terminal";

export interface AsyncRun {
  dir: string;
  /** Row id for the run itself: the direct call id, or status.json toolCallId for codemode. */
  owner: string;
  /** Paseo timeline tool call that launched it (direct or codemode call id). */
  toolCallId: string;
  workflow: boolean;
  polling: boolean;
  /** Last emitted row signatures, keyed by row id. Supports AC8. */
  emitted: Map<string, string>;
}

export function resolveAsyncDir(
  runId: string,
  knownDirs: ReadonlyMap<string, string>,
  env?: NodeJS.ProcessEnv,
): string;
//  knownDirs (bridge) → env.PI_SUBAGENTS_TEMP_ROOT → join(tmpdir(), `pi-subagents-uid-${process.getuid()}`), then `/async-subagent-runs/${runId}`

export function readAsyncStatus(dir: string): AsyncStatus | undefined; // sync read + zod safeParse; undefined on any error

export function isOwnerAlive(pid: number | undefined): boolean;
//  undefined → true (unknown); process.kill(pid, 0); ESRCH → false; EPERM → true

export function runState(status: AsyncStatus): AsyncRunState;
//  queued|running → active (or terminal if !isOwnerAlive(pid)); paused → paused; everything else → terminal

export function stepStatus(
  state: AsyncRunState,
  runStatus: string,
  step: AsyncStep,
): ProviderSubagentStatus;
//  step completed|detached → completed
//  step failed|error|rejected → failed
//  step stopped → canceled
//  step running|pending|queued|undefined:
//     active   → running
//     paused   → canceled
//     terminal → canceled if run stopped/dead-owner, failed if run failed|partial|rejected, else completed

export function projectRun(
  run: AsyncRun,
  status: AsyncStatus,
  readSessions: Set<string>,
): {
  subagents: ProviderSubagentInputEvent[];
  childSessions: PiChildSessionFile[];
  state: AsyncRunState;
};
```

Row projection rules in `projectRun`:

- **Workflow** (`status.mode === "workflow"` or `run.workflow`):
  - The workflow row is `id = run.owner`, `title: "workflow"`, `toolCallId: run.toolCallId`. Its status is `running` while active, `canceled` while paused, and on terminal it maps from the run state: `complete → completed`, `stopped`/dead owner → `canceled`, anything else → `failed`.
  - Step rows are `id = ${owner}:${step.workflowKey ?? step.runId ?? index}`, with `parentSubagentId: owner`, `title: step.agent`, `description: step.label`, `toolCallId: run.toolCallId`, and status from `stepStatus`.
- **Non-workflow:** keep today's ids (`owner` for a single step, `${owner}:${index}` otherwise) with the corrected `stepStatus`. On terminal, **always** also upsert the owner row (`completed`/`failed`/`canceled`), which fixes the phantom from cause 4.
- **Diffing:** a row is emitted only if `JSON.stringify([status, title, description, parentSubagentId])` differs from `run.emitted.get(id)`. A new step `sessionFile` (not yet in `readSessions`) adds a `childSessions` entry.
- **Terminal:** set `run.polling = false` after emitting. The host's `followChildren` then does a final read and drops the followers of rows that reached a final status.

### Adapter wiring (`index.ts`)

- `Args` adds `workflowScript`, `workflowScriptPath` and `workflow` (optional strings). `isWorkflow = Boolean(workflowScript || workflowScriptPath || workflow)`. The `mapSpawn` guard becomes: return if `action !== undefined`, or if neither (`agent && task`) nor `isWorkflow`.
  - Running: emit the workflow row (`running`, title `"workflow"`, or `workflow: <name>` for a named resource).
  - Completed with `details.mode === "workflow"` and `asyncDir`: register `AsyncRun { owner: callId, toolCallId: callId, workflow: true }` and run `projectRun` once immediately on the current `status.json`. That one read serves both live and replay (AC7).
  - Foreground workflow results (`results.length > 0`): existing `collectRows`; the owner row settles.
  - Failed: workflow row `failed`.
- New `mapCodemode(call)` runs when `toolName === "codemode"` and the call is not running:
  1. Return `undefined` unless `details.calls` has an entry with `name === "subagent"` and `status === "ok"`.
  2. Extract run ids from the result text with `/\bAsync(?: workflow|:[^\n\[]*)? \[([0-9a-f-]{36})\]/g`. Ids only; `args` is never read.
  3. For each id: take `dir = resolveAsyncDir(id, knownDirs)`, read `status.json`, and require `status.toolCallId?.startsWith(`${call.callId}/`)` (AC2, AC10).
  4. Register `AsyncRun { owner: status.toolCallId, toolCallId: call.callId, workflow: status.mode === "workflow" }` and `projectRun` once.
  5. Return `{ subagents, childSessions }` with no `detail`, so the codemode card keeps its default rendering (`history-mapper.ts:286` falls back). Return `undefined` when nothing verified, so other adapters can still claim the call.
- `mapCustomMessage(subagent-notify)` is unchanged, except that it looks up runs by dir across the unified registry. It still settles owners whose terminal notice arrives first.
- `poll()`: for each `polling` run, `readAsyncStatus` → `projectRun`. Unreadable or invalid status is skipped this tick; the run stays registered.
- The `PiExtension` gets `runtimeBridge: piSubagentsRuntimeBridge` and `mapRuntimeNotification`.

### Errors and conventions

- All file reads are synchronous, wrapped, and return `undefined` on failure, like today's `poll`. The host's `safe()` already isolates adapter throws.
- A bad zod parse logs nothing and produces no rows. Pi status files are external input; see `docs/coding-standards.md`.
- No protocol or schema change, so `COMPAT` tags don't apply.
- Comments explain only what the code can't: why `pid` liveness, why the ownership prefix check, why the bridge ignores `parentWorkflowRunId`.
- `docs/providers.md`: add one sentence to the Pi extension paragraph saying that pi-subagents async runs, including codemode-launched workflows, are tracked from `status.json` and that the bridge supplies asyncDir. Integrate it into the existing paragraph; don't append a new section.

### Flow

```
live direct:   tool_execution_start(subagent, workflowScript) → workflow row running
               bridge notify(id, asyncDir) → knownDirs
               tool_execution_end(details.mode=workflow, asyncDir) → register + project(status.json)
               poll every 250ms → step rows appear/settle (diffed) → terminal → all settled, polling off
live codemode: bridge notify → knownDirs
               tool_execution_end(codemode, "Async workflow [id]") → verify toolCallId prefix → register + project
               poll … as above
replay:        history toolResult → same mapping (bridge absent → default root) → one projection from current status.json
               dead owner / terminal ⇒ no running rows; subagent-notify settles too
```

## Tasks

Each task owns its files exclusively. Run tests from `packages/server`.

| ID  | Goal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Owned files                                                                                    | Consumes → Produces                    | Depends    | Targeted test                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| T1  | Capture real fixtures in a sandbox: Pi 1.0.4 + pi-subagents 0.71.0, a temp `PI_CODING_AGENT_DIR` copy and a temp `PI_SUBAGENTS_TEMP_ROOT`. Record one direct async workflow and one codemode-launched async workflow, each two short sequential steps. Capture the RPC events (`tool_execution_*`, the `extension_ui_request` notify from a throwaway copy of the bridge), the persisted messages, and the `status.json` snapshots taken at running, mid (step 1 done, step 2 running) and complete. Store them with provenance in the existing fixture format, plus `statusSnapshots`. Scrub absolute paths to placeholders the test replaces.                                                 | `extensions/pi-subagents/fixtures/workflow-direct.json`, `…/workflow-codemode.json`            | real Pi → fixtures                     | —          | `npx vitest run src/server/agent/providers/pi/extensions/pi-subagents/index.test.ts --bail=1` (existing tests still green) |
| T2  | `async-runs.ts` (registry types, `resolveAsyncDir`, `readAsyncStatus`, `isOwnerAlive`, `runState`, `stepStatus`, `projectRun` with diffing) and its unit tests: every state × step status pair; growing steps keep their ids; paused then resume; dead pid; partial/rejected terminal; diff suppression; owner settles on terminal for multi-step non-workflow runs; the real `38e069c4` shape (17 completed + 1 stopped step, run stopped) projects with no running rows.                                                                                                                                                                                                                      | `extensions/pi-subagents/async-runs.ts`, `…/async-runs.test.ts`                                | contract above → `projectRun` API      | —          | `npx vitest run src/server/agent/providers/pi/extensions/pi-subagents/async-runs.test.ts --bail=1`                         |
| T3  | `runtime-bridge.ts`: bridge source string and marker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `extensions/pi-subagents/runtime-bridge.ts`                                                    | — → `piSubagentsRuntimeBridge`, marker | —          | covered by T4 (the bridge string is executed against a fake `pi` in T4's test)                                             |
| T4  | Adapter wiring in `index.ts`: workflow args, `mapCodemode`, `mapRuntimeNotification`, `poll` through `projectRun`, unified registry, `runtimeBridge`. Extend `index.test.ts` with fixture-driven live (`verifySubagentFixture` / FakePi, temp status dir advanced through the snapshots) and replay (`streamPiHistory`) tests. Cover: direct, codemode, idle parent, complete, failed, stopped, dead owner, replay with no phantom, codemode id with a mismatched `toolCallId` ignored, a second host never sees the first host's run, ordinary single/parallel/chain/`bg_wait` unchanged. Execute the bridge string against a stub `pi.events` to check that it filters `parentWorkflowRunId`. | `extensions/pi-subagents/index.ts`, `…/index.test.ts`                                          | T1 fixtures, T2 API, T3 bridge         | T1, T2, T3 | `npx vitest run src/server/agent/providers/pi/extensions/pi-subagents/index.test.ts --bail=1`                              |
| T5  | Workspace status integration: assert that a Pi parent that is idle with a `running` provider subagent produces a `running` workspace descriptor, and that it returns to the parent's bucket after the rows settle. Add the case to the existing workspace-directory suite only if no existing test covers it; check first. Also make the `docs/providers.md` edit.                                                                                                                                                                                                                                                                                                                              | `packages/server/src/server/workspace-directory.test.ts` (only if needed), `docs/providers.md` | T4 behaviour                           | T4         | `npx vitest run src/server/workspace-directory.test.ts --bail=1`                                                           |

Waves (files are disjoint within each wave):

- **Wave 1:** T1, T2, T3 in parallel.
- **Wave 2:** T4.
- **Wave 3:** T5.

## Test and verification

- Targeted unit and integration runs: the commands in the table. The parent reruns T2, T4 and T5's files after integration, as the skill requires.
- `npm run typecheck`, `npm run lint`, and `npm run format` (or `npm run format:files -- <changed files>`) from the repo root. If cross-package types look stale, run `npm run build:server` first.
- No full suites locally. CI covers the rest.

## E2E journey (sandbox, real daemon, real Pi)

Sandbox: the worktree dev daemon from `npm run dev` (`PASEO_HOME=.dev/paseo-home`, `127.0.0.1:6768`) and the web app from `npm run dev:app`. **Never touch 6767.** Set Pi `PI_SUBAGENTS_TEMP_ROOT` to a scratch dir through the agent env so runs are isolated. Use a scratch git repo as the workspace and a second scratch repo for the isolation check. Pi uses the user's normal model config. Each workflow step is a `worker` child told to run `sleep 45 && echo done` in bash, so each step lasts long enough to observe.

Evidence for each step: sidebar screenshot (Playwright or the Paseo browser tools against the dev web app), `npm run cli -- ls -a -g` output, and a small `DaemonClient` probe (per `docs/ad-hoc-daemon-testing.md`, pointed at 6768) that prints the workspace descriptor `status` and the parent's provider subagents.

1. **Direct workflow, idle parent.** Prompt the Pi agent to call `subagent({ async: true, workflowScript })` with 2 sequential steps, then stop.
   → The parent goes idle. The workspace shows running. Provider subagents list the workflow row (running) and step 1 (running).
2. **Step transition.** Wait for step 1 to finish.
   → Step 1 is `completed`, step 2 is `running`, and the workspace stays running the whole time, with no grey flicker between steps.
3. **Completion.** Wait for the end.
   → All rows are `completed` and the workspace returns to the parent's idle bucket. A `subagent-notify` shows in the timeline.
4. **Codemode workflow.** Prompt the agent to launch the same workflow from a `codemode` script.
   → Same as 1–3, with rows linked to the codemode tool card.
5. **Stop.** Launch again, then ask the agent to call `subagent({ action: "stop", runId })`.
   → Rows become `canceled` and the indicator clears.
6. **Failure.** Launch a workflow whose second step uses a non-existent agent, or runs `exit 1` with acceptance that requires success.
   → The workflow row is `failed` and nothing stays running.
7. **Reload mid-run.** Launch, then restart **the dev daemon only** (`npm run dev` process on 6768). Reopen the agent.
   → Pi reports the workflow stopped. The replayed history shows the workflow and steps settled (`canceled`/`completed`), and the workspace is not running.
8. **Ordinary subagents regression.** `subagent({ agent: "scout", task, async: true })` and a foreground parallel run.
   → They behave as before: running while active, settled after.
9. **Isolation.** A second Pi agent in the second scratch workspace stays idle and grey during steps 1–4, and its provider subagents list is empty.

Record evidence in `docs/features/qa-evidence/` following `docs/qa.md`.

## Open notes

- When a user overrides `PI_SUBAGENTS_TEMP_ROOT` only through Pi's own environment, replay of **codemode** workflows can miss `status.json`, because the bridge isn't present during replay. Live tracking is unaffected. The only effect is that those replayed rows don't appear, and nothing phantom is produced.
- Codemode-launched **ordinary** async subagents (`Async: scout [id]`) work through the same path for free, if their `status.json` carries `toolCallId`. T1 checks this; if it is absent they stay unsupported (no rows).
