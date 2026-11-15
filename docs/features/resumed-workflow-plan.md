# Resumed Pi workflow recognition — bug fix plan

Status: **finalized autonomously (2026-11-14)**. Human input or approval: not required (D9).
Branch `fix/resumed-workflow-not-recognized`, base `origin/main` @ `2e9d69649`.
Runtime contract: Pi 1.4.0 (`/nix/store/rlmv3n25j9ajzv8n24rzjjf1hl9lwcal-pi-coding-agent-1.4.0`), pi-subagents 0.84.0 (`/nix/store/6aw6iwkk0rmkjaddpgmpnwvsi6gcmy0m-pi-subagents-0.84.0/lib/node_modules/pi-subagents`).

## Root cause

A workflow that pi-subagents resumes on its own never reaches Paseo's workflow tracker while it runs.

1. **No tool call.** At Pi `session_start` (reason `startup`), `planWorkflowAutoResumes` claims each interrupted top-level workflow. `launchWorkflowAutoResume` then runs `executor.executeWorkflowResume(randomUUID(), …)` (`src/extension/index.ts:676,1027`). The new run gets a fresh run id and a random `toolCallId`. No `subagent` tool call is written to the parent session, so `piSubagents.mapToolCall` → `workflows.launch` never runs (`pi-subagents/index.ts`).
2. **Its only parent-visible evidence misses the live stream.** The interrupted run's terminal notice carries `Auto-resumed as <newRunId>.` (`notify.ts:347-354`, `workflow-resume-claim.ts:242-256`). Pi 1.4 RPC mode calls `session.bindExtensions()`, which emits `session_start`, before `session.subscribe(output)` (`modes/rpc/rpc-mode.js:228-266`). Custom messages appended during session start are therefore persisted to the session file but may never reach Paseo's live adapter. Paseo's tracker also ignores that line today (`parseWorkflowTerminalNotice`).
3. **Result.** The live adapter learns about the new run only from its first `subagent-incremental-child-notify` (no `asyncDir`, no polling) or its final `subagent-notify`. Until then `listProviderSubagents(parent)` shows the older, terminal workflows and none of the resumed run. Running child transcripts are not followed. A running resumed workflow also stops vetoing idle-runtime collection (`agent-manager.ts:2273` checks running provider subagents). This matches the 2026-11-14 incident: a recovered web-export workflow missing from the daemon list, which showed only older terminal workflows.

The existing real E2E (`pi-workflow-subagents.local.e2e.test.ts`, `restartAndResumeSourceWorkflow`) checks the resumed run's artifacts and claim. It never checks that the resumed tree appears in the daemon list, so the gap is untested.

This is not the same as the paths below. They already work and must not regress:

- **Retained single-worker resume.** `subagent({action:"resume", id, message})` returns a receipt with `mode: "single"` and is handled by `mapResume`.
- **Manual workflow resume by id.** `subagent({action:"resume", id:<workflow>})` returns a `mode: "workflow"` receipt under the real tool call id, handled by `workflows.launch`.
- **Revived workflow children.** These reuse a retained transcript (`isResumedChild`).
- **Native-fork ownership.** Inherited history entries produce no provider subagents (`history-mapper.ts` `setEntryOwnership`).

## 1. Goal and acceptance criteria

**Goal:** a workflow that pi-subagents resumes without a tool call, whether auto-resumed at Pi startup or resumed by id, appears in its parent agent's provider-subagent tree as soon as it starts. The tree follows the run live until it settles and is rebuilt from history on replay. No unrelated or forked session gains it.

The user can reach a resumed workflow through these entry paths:

- **E1, live auto-resume.** The daemon or Pi restarts. Opening, prompting, or fetching the agent timeline starts Pi, and pi-subagents auto-resumes the workflow. Or the boot wake does this, if it is ever enabled.
- **E2, history replay.** The parent timeline is hydrated (`streamHistory` → replay host) after the interrupted run's notice was persisted.
- **E3, manual resume by id.** This is a tool call, so the regression path applies.
- **E4, ordinary tool-launched workflow.** It now also emits a start report, so the concurrency path applies.

| AC  | Observable behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Evidence (real implementing code, named path)                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1 | E1. A live Pi session reports a workflow start with no tool call and no notice. The parent's provider-subagent store gains `pi-subagents-workflow:<newRunId>` with status `running`, plus its group and child rows (titles, subtitles, statuses) from the new run's `status.json`.                                                                                                                                                                                                                                           | `pi-subagents/index.test.ts` › "recognizes an auto-resumed workflow from the runtime bridge and follows it to completion". It drives `PiRpcAgentClient` + `FakePi`. The notify text comes from executing the real combined `piExtensionRuntimeBridge` with a fake `pi` and emitting `subagent:async-started`. `FakePi` then emits that text as `extension_ui_request`/`notify`. The test asserts `ProviderSubagentStore` rows from `session.subscribe`. |
| AC2 | E1, continued. The adopted run is polled. Appended lines in its running child's `sessionFile` stream into that child's timeline. When `status.json` becomes `complete` with completed steps, the root, groups and children settle to `completed` and polling stops.                                                                                                                                                                                                                                                          | Same test: append to the child file and poll the child timeline; rewrite status as complete and poll statuses; a later tick emits no further root upserts.                                                                                                                                                                                                                                                                                              |
| AC3 | Runtime bridge contract. The Paseo integration bridge forwards one `PASEO_PI_SUBAGENTS_WORKFLOW_STARTED {runId, asyncDir}` notify per `subagent:async-started` event that has `mode: "workflow"`, string `id` and `asyncDir`, and a `sessionId` equal to the current session (`getSessionFile() ?? getSessionId()`). This includes events emitted before the bridge's `session_start` ctx exists. It forwards nothing for another session's id, a non-workflow mode, or missing fields.                                      | `pi-subagents/runtime-bridge.test.ts` › "forwards only this session's workflow starts, including ones before session start". It executes the combined `piExtensionRuntimeBridge` from `../index.js`, all bridges together, which also proves there are no identifier collisions. It uses a multi-listener fake `pi` and asserts the captured `ctx.ui.notify` calls.                                                                                     |
| AC4 | E2. A replayed history has the interrupted run's terminal notice with `Auto-resumed as <newRunId>.` or `Resumed as <newRunId>.`. The new run's status names the old run in `workflow.resumeOrigin.sourceRunId` and has the same `sessionId`. Replay then renders the old workflow `canceled` and the new workflow's tree from its current status: `running` with live owner pid, `completed` when complete, `canceled` with a dead owner pid. A resumed run whose own notice names a further resume is rebuilt the same way. | `pi-subagents/index.test.ts` › "rebuilds an auto-resumed workflow from the interrupted run's notice on replay". It uses `streamPiHistory` with the sanitized fixture `fixtures/workflow/resumed-notices.json` and seeded run directories, and asserts store rows for all three owner states and a second-generation chain.                                                                                                                              |
| AC5 | E2 rejection. No rows for the named run are created in these cases: the named run's status is missing or unreadable; `resumeOrigin.sourceRunId` differs or is absent; `sessionId` differs; the old run's own status is unreadable; or the line is `Not auto-resumed:` / `Resume by hand:` / `Relaunch it by hand with`. The old run still renders `canceled`.                                                                                                                                                                | `pi-subagents/index.test.ts` › "ignores resume lines whose run does not prove lineage". Replay through `streamPiHistory`; it asserts the store holds only the old workflow's rows.                                                                                                                                                                                                                                                                      |
| AC6 | E4, concurrency. A tool-launched workflow's start report arriving before or after its `subagent` tool result yields exactly one tree for that run id. Rows are identical to the launch-only path, the launch's tool call id remains the run's owner for the poll ownership check, and repeated start reports emit nothing new.                                                                                                                                                                                               | `pi-subagents/index.test.ts` › "keeps one tree when the start report precedes or follows the launch result". It uses `createPiExtensionHost()` with `mapRuntimeNotification` + `mapToolCall` (captured `workflowLaunch` shape) in both orders, then compares `workflowStoreState`.                                                                                                                                                                      |
| AC7 | E3 regression. A completed `subagent({action:"resume", id:<workflowRunId>})` whose result has `details: {mode:"workflow", runId:<newRunId>, asyncDir}` registers `pi-subagents-workflow:<newRunId>` under that call, live and on replay. It is not treated as a single-worker resume.                                                                                                                                                                                                                                        | `pi-subagents/index.test.ts` › "registers a manual workflow resume receipt as its new workflow". Live host + replay host, asserting equal store state with no `resume-call` single-worker row.                                                                                                                                                                                                                                                          |
| AC8 | Invalid report. A notify that starts with the marker but has malformed JSON or a missing or empty `runId`/`asyncDir` produces no subagent rows and no generic chat `notification` timeline item.                                                                                                                                                                                                                                                                                                                             | `pi-subagents/index.test.ts` › "claims an invalid workflow start report without a chat notification". It drives `PiRpcAgentClient` + `FakePi` and asserts no `timeline` event with `item.type === "notification"` and an empty store.                                                                                                                                                                                                                   |
| AC9 | Real counterpart, isolated daemon with real Pi 1.4.0 + pi-subagents 0.84.0. The daemon restarts and the source agent's Pi auto-resumes the held workflow. `listProviderSubagents(source.id)` then contains `pi-subagents-workflow:<claim.newRunId>` `running` and `…/T2.review` `running` before the gate opens, and both `completed` after the run completes. The fork never lists the resumed run.                                                                                                                         | `daemon-e2e/pi-workflow-subagents.local.e2e.test.ts`: add assertions to the existing `restartAndResumeSourceWorkflow` and completion section of `runNativeForkWorkflowOwnership` (both existing tests: `loseHeldRunner` false/true). Also assert `listProviderSubagents(fork.id)` has no row starting with the resumed id. Record evidence with the existing `record()`.                                                                                |

### Lifecycle, resume, retry and concurrency transitions

| Transition                                                                      | Coverage                                                                                                                                                                          |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh tool-call launch, live and replay                                         | Existing regressions: "maps the captured codemode workflow to the same real store tree…", "streams T2.review while running…", "claims successful async workflow results…"         |
| Start report before or after tool result; repeated report                       | AC6                                                                                                                                                                               |
| Interrupted (`runtime-replaced`/`owner-exited`) → auto-resume, live             | AC1, AC2, AC9                                                                                                                                                                     |
| Interrupted → auto-resume, rebuilt from history                                 | AC4                                                                                                                                                                               |
| Resumed run interrupted again → resumed again                                   | AC4 (second generation), AC1 for each live start                                                                                                                                  |
| Resumed run's owner dies                                                        | AC4 (dead pid), existing "workflow owner liveness" tests                                                                                                                          |
| Auto-resume refused or cancelled before start (no new run, or a stale claim id) | AC5                                                                                                                                                                               |
| Manual resume by id                                                             | AC7                                                                                                                                                                               |
| Relaunch with `reuseFrom` (`Relaunched as`)                                     | Tool-call launch path (D3); existing launch regressions                                                                                                                           |
| Retained single-worker `action:"resume"`                                        | Existing regressions: "registers a retained single-worker resume…", "admits only successful resume receipts…", "a resumed row can discover its already-read retained transcript…" |
| Revived workflow child reusing a transcript                                     | Existing regression "hydrates and follows a proven resumed workflow child beyond one-shot limits"                                                                                 |
| Native fork before and after source auto-resume                                 | AC9 + existing fork E2E assertions; AC3 session filter                                                                                                                            |
| Rewind force-hydrate while an adopted run is live                               | D6; no new AC                                                                                                                                                                     |

### Decisions

- **D1.** Ruling: discover live resumed workflows through a Paseo runtime bridge on pi-subagents' public `subagent:async-started` event (`mode: "workflow"`). It is listed in `rpc.ts` `events.asyncStarted` and in `docs/observability.md:335-339`, which says it fires "after their initial `status.json` is durable". The bridge forwards it with `ctx.ui.notify`. Why: RPC `notify` is written straight to stdout (`rpc-mode.js` `createExtensionUIContext`) and does not depend on the post-`session_start` subscription. The event fires for every workflow launch, including `executeWorkflowResume`. Cost if wrong: if a future pi-subagents drops the event, live recognition falls back to D2/notices; AC3/AC9 detect it.
- **D2.** Ruling: on the terminal-notice path, adopt the run named by the interrupted run's `Auto-resumed as <id>.` / `Resumed as <id>.` line, but only when the named status proves lineage (`workflow.resumeOrigin.sourceRunId` equals the old run id, and `sessionId` equals the old run's `sessionId`). Why: history is the only durable evidence, and the replay host never sees bridge notifies. Cost if wrong: a resumed run is missing on replay until its own notices arrive, which is today's behavior.
- **D3.** Ruling: do not adopt from `Relaunched as` lines. Why: `reuseFrom` relaunches are ordinary tool calls that `launch()` already maps, and their status carries no `resumeOrigin`. Cost if wrong: none observable; the tool-call row covers it.
- **D4.** Ruling: the bridge enforces session ownership (`event.sessionId` equals the current session file or id), and the adapter checks basename(`asyncDir`) == `runId`. The adapter adds no own-identity check. Why: the adapter does not know its session file. Bridge events are in-process for this parent, and forks run in a separate Pi with inherited history excluded. Cost if wrong: a same-process foreign session's workflow could appear. Pi RPC hosts one session at a time and re-runs `session_start` on switch.
- **D5.** Ruling: a resumed workflow gets its own `Workflow` root (`pi-subagents-workflow:<newRunId>`, no `toolCallId`). No chat timeline row is added, the old root keeps `canceled`, and there is no protocol or app change. Why: there is no tool call to attach to, and the existing tree, track and chip consume running provider subagents. Cost if wrong: users see two `Workflow` roots without a lineage label; a later presentation change can add one.
- **D6.** Ruling: do not add `replay()` to the pi-subagents adapter. Why: force-hydrate (rewind) deletes the parent's rows, and the live adapter's 250 ms poll re-emits every row of an unsettled adopted run. D2 also rebuilds it from history. Cost if wrong: rows can be missing for one poll tick after a rewind.
- **D7.** Ruling: author the AC4/AC5 notice fixture from the installed 0.84.0 formatter (`formatSingleCompletion` + `formatCorrelationLines` + `describeWorkflowResume`) with sanitized placeholders and provenance. If the AC9 run captures the real interrupted notice from the isolated source session, replace the authored text with that capture, sanitized. Why: providers.md requires real-extension provenance, and the isolated scripted E2E session holds no private data. Cost if wrong: the fixture drifts from the real format; AC9 still proves the live path.
- **D8.** Ruling: classify this as a bug fix and skip the e2e-feature initial-feature E2E phase. The repository-mandated Pi workflow checks still bind: the daemon local E2E with AC9 assertions, and the browser real spec as an unchanged regression. Why: this restores recognition of existing workflow behavior. Cost if wrong: none; the mandated real checks still run.
- **D9.** Decision: human input or approval is not required. There are no destructive, external, security-sensitive or out-of-worktree effects. Scope and behavior follow from the request and the existing workflow-tree contract, and the user did not ask for review. Gate: none. Resolution: finalized autonomously.

### Documentation items

- **DOC1.** `docs/providers.md` (Pi extension adapters paragraph, line 72). Rewrite the pi-subagents sentences to cover these points:
  - Auto-resumed workflows have no tool call.
  - The runtime bridge forwards `subagent:async-started` workflow starts live.
  - On replay, the interrupted run's `Auto-resumed as`/`Resumed as` line rebuilds the resumed tree once its status proves `resumeOrigin` lineage and the same session.
  - Gotcha: Pi 1.4 RPC subscribes stdout only after `session_start`, so custom messages sent during session start reach history but not the live stream.

  Integrate this into the paragraph; do not append it.

- **DOC2.** The fixture `fixtures/workflow/resumed-notices.json` records `provenance` (package, version, source path or commit, Pi version, capture date, and whether it was authored or captured), as in `real-notices.json`.

## 2. Design

### Module boundaries

All changes stay inside `packages/server/src/server/agent/providers/pi/extensions/pi-subagents/`, plus the existing local E2E and DOC1. `host.ts`, `contract.ts`, `agent.ts` and `extensions/index.ts` are unchanged. `piExtensionRuntimeBridge` already concatenates every registered extension's `runtimeBridge`, and `PiExtensionHost.mapRuntimeNotification` already routes notify text to adapters. A thrown adapter error is already claimed without a chat row.

| Module                    | Owns                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `runtime-bridge.ts` (new) | Bridge source string, marker, and the strict parser for the notify payload                 |
| `index.ts`                | `runtimeBridge` registration and `mapRuntimeNotification`, delegating to `workflows.adopt` |
| `workflow.ts`             | `adopt` and the D2 lineage-checked adoption inside `mapNotice`; poll reuse                 |
| `notice.ts`               | `resumedRunId` on `WorkflowTerminalNotice`                                                 |

### Data flow

**Live path (AC1, AC2, AC6).**

1. pi-subagents emits `subagent:async-started` in-process.
2. The bridge checks the session and calls `ctx.ui.notify("PASEO_PI_SUBAGENTS_WORKFLOW_STARTED {…}")`.
3. Pi RPC writes it as `extension_ui_request`/`notify` to stdout.
4. `PiAgentSession.handleExtensionUiRequest` calls `extensionHost.mapRuntimeNotification`, then `piSubagents.mapRuntimeNotification`, then `parseWorkflowStartNotification`, then `workflows.adopt`.
5. The mapping becomes `provider_subagent` events and child-session followers.
6. Each 250 ms `host.poll()` calls `workflows.poll()`, which re-reads `status.json` until the run settles or its owner dies.

**Replay path (AC4, AC5).**

1. The replay host's `mapCustomMessage(subagent-notify)` reaches `workflows.mapNotice`, and `parseWorkflowTerminalNotice` returns `resumedRunId`.
2. The old run renders as today.
3. If `resumedRunId` is set and the old status is readable, `adoptResumed` reads `<dirname(old asyncDir)>/<resumedRunId>/status.json` and checks lineage.
4. If lineage holds, it calls `adopt` and merges the mapping into the old run's mapping.
5. The replay host does not poll, because `follow()` is never called there.

**Bridge source**, exported as a string and concatenated into `paseoIntegration(pi)`. All identifiers carry the `piSubagentsWorkflow` prefix.

```js
let piSubagentsWorkflowContext;
const piSubagentsWorkflowStarts = [];
function reportPiSubagentsWorkflowStart(ctx, event) {
  const current = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
  if (event.sessionId !== current) return;
  ctx.ui.notify(
    "PASEO_PI_SUBAGENTS_WORKFLOW_STARTED " +
      JSON.stringify({ runId: event.id, asyncDir: event.asyncDir }),
    "info",
  );
}
pi.on("session_start", (_event, ctx) => {
  piSubagentsWorkflowContext = ctx;
  for (const event of piSubagentsWorkflowStarts.splice(0))
    reportPiSubagentsWorkflowStart(ctx, event);
});
pi.events.on("subagent:async-started", (event) => {
  if (
    event?.mode !== "workflow" ||
    typeof event.id !== "string" ||
    typeof event.asyncDir !== "string"
  )
    return;
  if (piSubagentsWorkflowContext) reportPiSubagentsWorkflowStart(piSubagentsWorkflowContext, event);
  else piSubagentsWorkflowStarts.push(event);
});
```

The queue covers this case: another extension's async `session_start` handler delays Paseo's handler past pi-subagents' `setImmediate` launch.

### Interfaces

```ts
// runtime-bridge.ts
export const PI_SUBAGENTS_WORKFLOW_STARTED_MARKER = "PASEO_PI_SUBAGENTS_WORKFLOW_STARTED";
export const piSubagentsRuntimeBridge: string;
export interface PiWorkflowStart {
  runId: string;
  asyncDir: string;
}
/** undefined for any other notify; throws (SyntaxError/ZodError) for a marker with an invalid payload. */
export function parseWorkflowStartNotification(message: string): PiWorkflowStart | undefined;

// notice.ts
export interface WorkflowTerminalNotice {
  workflowRunId: string;
  asyncDir: string;
  status: "completed" | "failed" | "canceled";
  children: WorkflowChildRunEntry[];
  /** From `Auto-resumed as <id>.` or `Resumed as <id>.`; never from refusal or by-hand lines. */
  resumedRunId?: string;
}

// workflow.ts
export interface PiWorkflowTracker {
  launch(details: z.infer<typeof WorkflowLaunchDetails>, callId?: string): PiExtensionCustomMapping;
  /**
   * Tracks a workflow this session started without a tool call. Returns undefined when the run
   * already has a directory, or when basename(asyncDir) !== runId.
   */
  adopt(start: PiWorkflowStart): PiExtensionCustomMapping | undefined;
  recoverMission(mission: unknown): PiExtensionCustomMapping | undefined;
  mapNotice(message: PiCustomMessage): PiExtensionCustomMapping | undefined;
  poll(): PiExtensionCustomMapping | undefined;
}

// index.ts, inside the session object returned by createSession()
mapRuntimeNotification(message: string): PiExtensionCustomMapping | undefined;
// → undefined if not the marker; otherwise workflows.adopt(start) ?? { subagents: [] }
```

**`adopt` semantics:**

- It uses the existing `remember`, `applyStatus`, `applyOwnerLiveness` and `render`, and sets `run.asyncDir` and `run.polling = true`.
- It leaves `run.callId` untouched, so an earlier or later `launch` keeps poll ownership (AC6).
- With a readable status, it renders the full tree, like `recoverMission`: status `canceled` if the owner is dead, otherwise the mapped workflow state.
- With an unreadable status, it returns a root-only `running` row, like `launch`, and the next poll fills in the rest.
- It does not change `launch`'s first-render behavior. Existing tests expect a root-only row for a running launch.

**`adoptResumed(notice, oldStatus)`** is internal to `workflow.ts`. It uses a separate schema, `z.object({ sessionId: z.string(), workflow: z.object({ resumeOrigin: z.object({ sourceRunId: z.string() }).passthrough() }).passthrough() }).passthrough()`, safe-parsed against the passthrough status. `WorkflowStatus` stays unchanged, so existing parsing cannot regress. `adoptResumed` returns undefined whenever any D2 check fails.

**Errors.**

- An invalid marker payload throws inside `mapRuntimeNotification`. The host logs it once and returns an empty claimed output (AC8).
- File read errors keep the existing `readStatus` behavior: an `ENOENT` code or `SyntaxError` means undefined; anything else rethrows to `safe()`.
- Nothing is written to pi-subagents artifacts.

**Conventions.**

- Keep functions under the lint complexity limit by extracting `adoptResumed`.
- Keep the `paseo/no-sync-io` disable on `workflow.ts`; the new reads use the same `readStatus`.
- No `COMPAT` tag; no protocol change.
- Use the glossary term "subagents track" in comments and docs only where needed.

## 3. Tasks

One task, consolidated review.

### T1 — Recognize resumed workflows live and on replay

- **Goal:** AC1–AC9, DOC1, DOC2.
- **Owned files:**
  - `packages/server/src/server/agent/providers/pi/extensions/pi-subagents/runtime-bridge.ts` (new)
  - `…/pi-subagents/runtime-bridge.test.ts` (new)
  - `…/pi-subagents/index.ts`, `…/pi-subagents/index.test.ts`
  - `…/pi-subagents/workflow.ts`, `…/pi-subagents/workflow.test.ts` (parser cases for `resumedRunId`)
  - `…/pi-subagents/notice.ts`
  - `…/pi-subagents/fixtures/workflow/resumed-notices.json` (new)
  - `packages/server/src/server/daemon-e2e/pi-workflow-subagents.local.e2e.test.ts`
  - `docs/providers.md`
- **Consumes:**
  - `PiExtension.runtimeBridge` and `PiExtensionSession.mapRuntimeNotification` (`contract.ts`)
  - `PiExtensionHost` routing (`host.ts`) and `piExtensionRuntimeBridge` aggregation (`extensions/index.ts`)
  - pi-subagents 0.84.0: `subagent:async-started` payload, notice correlation lines, `status.json` `workflow.resumeOrigin`
- **Produces:** the interfaces in §2.
- **Dependencies:** none.
- **TDD:** write AC1, AC3, AC4 and AC8 tests first. Record the failing-before run on the base tree, the passing-after run, and the AC9 assertion outcome.
- **Targeted unit command**, under the orchestrator's isolation wrapper:

```bash
cd packages/server && npx vitest run src/server/agent/providers/pi/extensions/pi-subagents src/server/agent/providers/pi/extensions/index.test.ts src/server/agent/providers/pi/extensions/gotgenes-pi-subagents/index.test.ts --bail=1 --maxWorkers=1
```

There are no file or build conflicts and no waves; the task touches only server-internal files.

**Review:** one consolidated review of T1's full diff against AC1–AC9 and D1–D9.

## 4. Test and verification

Run every command from the worktree root unless shown otherwise. Run heavy commands one at a time under `/home/sinkerine/dev/paseo/.git/worktrees/stale-rhino/e2e-feature-build.lock`, never in parallel with another build, browser or native job. Never touch the daemon on 6767, `~/.paseo`, or private session or config files. Do not run full suites.

| #   | Check                                                     | Command                                                                                                                                                                                                                                                                                                                                                                                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | Targeted unit (new + existing regressions)                | T1 command above                                                                                                                                                                                                                                                                                                                                                                                      | Covers AC1–AC8 and every existing pi-subagents, host and gotgenes-bridge regression. Runner: server Vitest 4.1.6 (`packages/server/vitest.config.ts`); the orchestrator smoke-tested it on async-runs.test.ts. Failing-before evidence is the same command on the base tree with only the new tests applied.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| V2  | Pi agent regression                                       | `cd packages/server && npx vitest run src/server/agent/providers/pi/agent.test.ts --bail=1 --maxWorkers=1 > /tmp/resumed-workflow-agent.txt 2>&1`                                                                                                                                                                                                                                                     | The bridge string is concatenated into the generated integration extension (`agent.ts:761`). Read the log afterward.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| V3a | Required consumer build (ordered before V3b, V7 and V8)   | `npm run build:server` under the build lock                                                                                                                                                                                                                                                                                                                                                           | `@getpaseo/server` owns and consumes every changed interface. This builds server deps first (`build:client`, which runs protocol, relay and client, then highlight, plugin and relay in parallel), then `@getpaseo/server` (`build:lib` + `build:scripts`), then `@getpaseo/cli`. It proves the changed sources compile through the shipping `tsconfig.server.json` build and that the CLI still builds against the server's declarations. Outputs are gitignored and are not product changes: `packages/{protocol,relay,client,highlight,plugin,server,cli}/dist/`. `packages/server/dist/server/…` includes the compiled `agent/providers/pi/extensions/pi-subagents/runtime-bridge.js` and the copied skills, builtin plugins and assets. Nothing generated is tracked or committed. V7 and V8 run after this build so the daemon and app harnesses see current declarations. Rerun it after any later T1 source repair, before rerunning V3b, V7 or V8. |
| V3b | Root typecheck                                            | `npm run typecheck`                                                                                                                                                                                                                                                                                                                                                                                   | Runs after V3a. Every consumer of the changed interfaces (`workflow.ts`, `notice.ts`, `runtime-bridge.ts`) is inside `@getpaseo/server`; no app, desktop or protocol code imports them. Root typecheck covers every workspace against the fresh declarations from V3a.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| V4  | Root lint                                                 | `npm run lint`                                                                                                                                                                                                                                                                                                                                                                                        | Targeted first if useful: `npm run lint -- <owned files>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| V5  | Format                                                    | `npm run format:files -- <owned files>` then `npm run format:check`                                                                                                                                                                                                                                                                                                                                   | Inspect the diff afterward.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| V6  | Nix hash check                                            | `bash scripts/update-nix.sh --check`                                                                                                                                                                                                                                                                                                                                                                  | Required only if `package-lock.json` changes. No dependency change is planned, so skip it and state why.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| V7  | Repository-mandated daemon Pi workflow E2E, including AC9 | `cd packages/server && PASEO_PI_BINARY=/nix/store/rlmv3n25j9ajzv8n24rzjjf1hl9lwcal-pi-coding-agent-1.4.0/bin/pi PASEO_PI_SUBAGENTS_PACKAGE=/nix/store/6aw6iwkk0rmkjaddpgmpnwvsi6gcmy0m-pi-subagents-0.84.0/lib/node_modules/pi-subagents npx vitest run src/server/daemon-e2e/pi-workflow-subagents.local.e2e.test.ts --maxWorkers=1 --bail=1 > ../../artifacts/resumed-workflow/daemon-e2e.txt 2>&1` | Real counterpart contract. The file's defaults name store paths that are absent on this host, so the env overrides are mandatory. It is self-isolating: in-process daemon, temp root, `PI_SUBAGENTS_TEMP_ROOT`, scripted model, no credentials, and it kills rooted processes. It runs all tests in the file: direct workflow + isolated restart replay, plus both native-fork ownership variants that carry AC9. Keep the `record()` evidence under ignored `artifacts/resumed-workflow/`. If protocol `dist` imports fail, run `npm run build:client` under the lock first.                                                                                                                                                                                                                                                                                                                                                                               |
| V8  | Repository-mandated browser Pi workflow tree              | `cd packages/app && PASEO_PI_BINARY=… PASEO_PI_SUBAGENTS_PACKAGE=… npx playwright test --project=real-provider e2e/browser/pi-workflow-subagent-tree.real.spec.ts --output=../../artifacts/resumed-workflow/browser`                                                                                                                                                                                  | Unchanged regression; this fix adds no browser assertions. It uses the same env values as V7. Its harness owns Metro, the disposable daemon home and ports. Do not use `npm run test:e2e:real`: it forks `.dev/paseo-home`, which is absent here, and this spec builds its own daemon config. Prerequisite: Chromium runtime dependencies from the development shell (`docs/development.md#nix-and-direnv`). Serialize it after V7.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| V9  | Isolated smoke                                            | V1 is the isolated smoke for the fix; V7 is the isolated real-runtime smoke.                                                                                                                                                                                                                                                                                                                          | No shared daemon, emulator or Metro is used.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

**Inputs and prerequisites.**

- No generated inputs change: no protocol, zod-aot, i18n or assets. The only generated outputs are V3a's gitignored `dist/` trees.
- Ordered sequence: V1 → V2 → V3a → V3b → V4 → V5 → (V6 if applicable) → V7 → V8. Each heavy step (V3a, V7, V8) runs alone under the build lock.
- Visual checks: none. There is no UI change, and V8's own screenshots are regression evidence only.

**Repair ownership.**

- T1 owns every failure in V1–V8 that traces to its owned files or its new assertions, and repairs it without a retry cap.
- A failure in an unchanged existing test or harness, such as a V8 environment failure, gets diagnosed statically and reported with logs to the orchestrator. Do not edit files outside T1's ownership without a ruling.
- A real-counterpart mismatch in V7 means the installed pi-subagents differs from the cited 0.84.0 contract, for example a missing event or a different line format. Repair it in the adapter or bridge and update DOC1 and the fixture provenance.

## 5. E2E journey

The e2e-feature initial-feature E2E phase is **skipped**: this is a bug fix that restores recognition of existing workflow behavior (D8). The scope does not add a new feature. No new AGENTS E2E requirement is added.

The relevant observable journey is exercised by the repository-mandated V7 run, AC9:

1. In an isolated daemon, a Pi agent runs the scripted workflow until `T2.review` holds on a gate.
2. The daemon stops and restarts. Fetching the source agent's timeline starts Pi, and pi-subagents auto-resumes the workflow under a new run id (`resumed-by.1.json`, `trigger: auto`).
3. Before the gate opens, the daemon's provider-subagent list for the source agent shows the new `Workflow` root and `T2.review` as running. Before the fix, that list held only the original, interrupted workflow.
4. The gate opens. The resumed root and `T2.review` settle to completed.
5. The native fork's list never contains the resumed run.

V8 separately confirms that the browser subagents track still renders and reloads a live workflow tree.
