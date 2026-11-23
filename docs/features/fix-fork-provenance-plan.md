# Fix Native Pi Session Fork Provenance Coverage

**Revision:** r1
**Classification:** Bug fix (no new feature; existing native Pi session fork contract)
**Branch / Worktree:** `improve-forking-feature-delay` (`/home/sinkerine/.paseo/worktrees/28vpgp2p/thirsty-turtle`)

## Goal

Fix native Pi session fork failing with:

> `Could not fork the session — The native run provenance does not cover the active source ancestry.`

when non-message entries (such as extension `custom` state entries, `model_change`, `thinking_level_change`, `label`, `session_info`, or `compaction`) are appended to the Pi session JSONL after Paseo's last `observedLeafId`, while keeping fail-closed rejection for every genuinely ambiguous or unobserved message boundary.

## Problem, Root Cause, and Evidence

### Reported Failure

Forking Pi agent `8893b447-243a-4104-a8db-23d1623c95d6` fails with `NativeSessionForkError("boundary_mismatch", "The native run provenance does not cover the active source ancestry.")`, thrown by `validateFramingCoverage` in `packages/server/src/server/agent/providers/pi/session-fork.ts:165-186`.

### Read-Only Evidence from Session `8893b447-243a-4104-a8db-23d1623c95d6`

Inspecting `~/.paseo/agents/home-sinkerine-dev-tiny-llm/8893b447-243a-4104-a8db-23d1623c95d6.json` and its native Pi JSONL (`~/.pi/agent/sessions/--home-sinkerine-dev-tiny-llm--/2026-11-22T23-16-54-756Z_01a2058c-5d63-70ce-b98c-a950e9bba8cb.jsonl`) read-only shows:

- Persisted `nativeSessionForkFraming`:
  - `valid: true`
  - `sourceSessionId: "01a2058c-5d63-70ce-b98c-a950e9bba8cb"` (matches header `id`)
  - `sourceNativeHandle`: matches file path
  - `startEntryId: "e50da00a"` (index `1`, `thinking_level_change`)
  - `observedLeafId: "4a1d0d0d"` (index `24`, `message` with `role: "assistant"`, `ts: 2026-11-22T23:47:00.669Z`)
  - `boundaries`: `3b3b8bf0` (`trigger`, user turn 1), `496f1a3a` (`unknown`, `pi-artifacts.guidance`), `7ce03445` (`unknown`, `hindsight-memory.recall`), `01986d4e` (`trigger`, user turn 2), `f9b646e7` (`unknown`, `hindsight-memory.recall`)
- Active JSONL path has 27 entries (indices `0..26`); active leaf is `6f4e90c3` (index `26`), **not** `4a1d0d0d`:
  - `[24] 4a1d0d0d` (`type: "message"`, `role: "assistant"`, `23:47:00.669Z`) ← `observedLeafId`
  - `[25] e0c74b67` (`type: "custom"`, `customType: "hindsight-memory.state"`, `23:47:00.690Z`)
  - `[26] 6f4e90c3` (`type: "custom"`, `customType: "hindsight-memory.state"`, `23:47:00.701Z`) ← current leaf

Earlier in the same session, entries `[15..21]` are also `type: "custom"` entries (`hindsight-memory.state`, `pi-btw/thread`, `hindsight-memory.diagnostics`) appended between turns while idle.

### Aggregate Local Evidence

A read-only scan of all persisted Pi agents in `~/.paseo/agents` (319 with `nativeSessionForkFraming`, 286 with `valid: true`) shows:

- `169 / 286` have `observedLeafId !== activeLeaf`.
- **`155 / 169` (91.7%)** have strictly non-message entries after `observedLeafId`: `151` `custom`, `1` `model_change`, `2` `custom + model_change`, `1` `custom + model_change + thinking_level_change`.
- Among `11` non-archived idle/closed Pi agents with valid framing, **`10 / 11`** (including `8893b447`) fail to fork due to trailing `custom` (`hindsight-memory.state`, `pi-goal:accounting`) entries.
- The remaining `14 / 169` mismatches are genuinely unobserved messages (9 running/archived mid-`toolUse` turns with trailing `message` entries, 5 with trailing unobserved `custom_message` entries) that must continue to fail closed on idle turn forks.

### Root Cause

1. Paseo's Pi integration extension (`packages/server/src/server/agent/providers/pi/agent.ts:707-822`) calls `emitForkFraming(ctx)` on `session_start`, `before_agent_start`, `agent_end`, `agent_settled`, `session_compact`, and boundary capture. Other Pi extensions (such as `hindsight-memory`, `pi-btw`, `pi-goal`) call `pi.appendEntry(...)` after Paseo's `agent_end` handler or while idle, and Pi also appends `model_change`, `thinking_level_change`, `label`, and `session_info` entries while idle without firing turn lifecycle events. None of these non-message entries can trigger an LLM run or introduce a `message` or `custom_message`.
2. The codebase already encodes the exact coverage invariant in `hasNoUnobservedNativeMessages` (`packages/server/src/server/agent/native-fork-framing.ts:23-34`): `observedLeafId` must lie on the active ancestry (when non-null), and no entry strictly after `observedLeafId` may have `type === "message"` or `type === "custom_message"`. `PiRpcAgentSession.handleForkFraming` (`agent.ts:2234`) already relies on `hasNoUnobservedNativeMessages` when resuming sessions.
3. However, `packages/server/src/server/agent/providers/pi/session-fork.ts` enforces strict leaf equality (`framing.observedLeafId !== path.at(-1)?.id`) in **three** places instead of checking coverage with `hasNoUnobservedNativeMessages`:
   - `validateFramingCoverage` (`session-fork.ts:177`) — throws `boundary_mismatch` on any turn fork when non-message entries follow `observedLeafId`.
   - `rebindPiForkFraming` (`session-fork.ts:456`) — silently drops (`returns undefined`) valid provenance on the forked/cloned child agent whenever non-message entries follow `observedLeafId`, breaking subsequent turn forks on that child.
   - `resolvePiSessionForkTransaction` (`session-fork.ts:273`) — enters the running-prefix fallback path instead of delegating directly to `resolvePiForkTarget` when `sourceRunning` is true and only non-message entries follow `observedLeafId`.

## Scope and Exclusions

### In Scope

- Fix framing coverage validation in `packages/server/src/server/agent/providers/pi/session-fork.ts` across `validateFramingCoverage`, `resolvePiSessionForkTransaction`, and `rebindPiForkFraming` using `hasNoUnobservedNativeMessages` and explicit index ordering (`covered !== undefined`, `selected <= covered`, `start <= covered`).
- Add failure-first regression tests in `packages/server/src/server/agent/providers/pi/session-fork.test.ts` with a compact sanitized fixture reproducing session `8893b447-243a-4104-a8db-23d1623c95d6` plus edge-case coverage for non-message tails, running-source transactions, framing rebinding, and fail-closed rejection cases.
- Update `docs/providers.md` with one concise sentence noting non-message tail coverage vs. unobserved message rejection.

### Exclusions

- Do **not** change fork latency/performance (explicitly excluded by the user's narrowed scope).
- Do **not** modify `paseoIntegration` extension hooks in `packages/server/src/server/agent/providers/pi/agent.ts`: extension hooks cannot capture idle `pi.appendEntry` writes or retroactive entries already persisted on disk in existing sessions like `8893b447`.
- Do **not** relax fail-closed behavior for unobserved `message` entries, unobserved `custom_message` entries, `valid: false` framing, off-branch / rewound `observedLeafId`, `selected <= start`, or `unknown` custom boundaries preceding the next trigger.
- Do **not** touch wire protocol schemas, UI components, or `AgentManager`.

## Protected State

- **User's source session `8893b447-243a-4104-a8db-23d1623c95d6`** (`~/.paseo/agents/home-sinkerine-dev-tiny-llm/8893b447-243a-4104-a8db-23d1623c95d6.json` and `~/.pi/agent/sessions/--home-sinkerine-dev-tiny-llm--/2026-11-22T23-16-54-756Z_01a2058c-5d63-70ce-b98c-a950e9bba8cb.jsonl`) must remain completely untouched. Tests use only a sanitized, repo-local fixture under `packages/server/src/server/agent/providers/pi/fixtures/session-fork/` containing no personal memory content or local home paths.
- **Any forked source session file** must remain read-only across `readPiSessionPath`, `resolvePiSessionForkTransaction`, `resolvePiForkTarget`, and `rebindPiForkFraming` (no writes, no mutation of `handle.metadata.nativeSessionForkFraming`).
- **Main Paseo daemon on port 6767** must never be restarted or targeted.

## Real Entry Paths

1. **Turn fork ("Fork session from here"):**
   App Split menu (`assistant-fork-menu.tsx`) → `useNativeForkAgent` → `agent.fork_session.request` (`target: "turn"`, `boundary`) → `AgentManager.forkAgentSession` → `resolveNativeForkTarget` (`native-fork-boundary.ts`) → `PiRpcAgentClient.forkSession` (`providers/pi/agent.ts`) → `readPiForkSource` → `resolvePiSessionForkTransaction` → `resolvePiForkTarget` → `resolveObservedNextTrigger` → `validateFramingCoverage` → `materializePiBranch` → `rebindPiForkFraming`.
2. **Session clone ("Clone session"):**
   Workspace tab menu (`workspace-tab-menu.ts`) → `useNativeForkAgent` → `agent.fork_session.request` (`target: "latest"`) → `AgentManager.forkAgentSession` → `PiRpcAgentClient.forkSession` → `resolvePiSessionForkTransaction` (`kind: "latest"`) → `materializePiBranch` → `rebindPiForkFraming`.

## Design Decisions

| ID  | Decision                                                                                                                                                                               | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Cost if wrong                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Reuse `hasNoUnobservedNativeMessages` as the single coverage predicate in `session-fork.ts`.**                                                                                       | `native-fork-framing.ts` already defines and exports the exact Pi provenance invariant (`observedLeafId` on active ancestry and no `message` or `custom_message` after it), and `handleForkFraming` (`agent.ts:2234`) already uses it on resume. Using the same predicate in `session-fork.ts` eliminates drift between resume validation and fork resolution.                                                                                                          | Low; confined to `session-fork.ts` and `native-fork-framing.ts`. If Pi ever introduces a new JSONL entry type that can trigger an LLM turn, updating `hasNoUnobservedNativeMessages` updates both resume and fork together. |
| D2  | **Enforce explicit index bounds (`covered !== undefined`, `selected <= covered` in `validateFramingCoverage`; `covered !== undefined`, `start <= covered` in `rebindPiForkFraming`).** | Guards against `observedLeafId === null` with a non-message `selected` entry, off-branch/rewound `observedLeafId`, and corrupted inverted framing (`start > covered`). Keeps fail-closed semantics airtight.                                                                                                                                                                                                                                                            | Negligible; pure index comparisons on the already-built `positions` map.                                                                                                                                                    |
| D3  | **Update `rebindPiForkFraming` alongside `validateFramingCoverage` and `resolvePiSessionForkTransaction`.**                                                                            | Fixing only `validateFramingCoverage` would let the first fork succeed but silently drop `nativeSessionForkFraming` on the forked/cloned child (breaking any second-generation fork on a session with passive `custom_message` entries). Because `hasNoUnobservedNativeMessages` proves no unobserved `message`/`custom_message` exists up through `source.path.at(-1)`, setting `observedLeafId: branch.path.at(-1)?.id ?? null` on the copied branch prefix is sound. | Low; rebound framing still validates every boundary against `source.path`, filters boundaries to `copied`, and never mutates the input handle.                                                                              |
| D4  | **Keep `cutIndex = path.length - 1` when forking the latest completed turn (`nextTrigger < 0`).**                                                                                      | Trailing non-message entries (`hindsight-memory.state`, `model_change`, `thinking_level_change`, `label`) belong to the post-response state of that run, matching both earlier-turn cuts (`nextTrigger - 1` includes trailing `custom` entries before the next user prompt) and `Clone session` (`latest`).                                                                                                                                                             | Low; changing to cut at `observedLeafId` would drop post-turn extension state and idle model/thinking changes while differing from Clone.                                                                                   |
| D5  | **Use a compact, sanitized fixture modeled on `8893b447-243a-4104-a8db-23d1623c95d6` rather than copying raw personal JSONL.**                                                         | The real session file is 135 KB and contains personal hindsight memory digests and local filesystem paths. A compact sanitized fixture preserves the exact Pi v3 entry graph (including passive `custom_message` entries in both turns, `pi-btw/thread` and `hindsight-memory` `custom` entries between turns, and two trailing `custom` entries after `observedLeafId`) without leaking private data or bloating git.                                                  | None; preserves 100% of structural fidelity while remaining clean and reviewable.                                                                                                                                           |

## Acceptance Criteria

- **AC1 — Earlier-turn and latest-turn fork succeed with trailing non-message entries.** Given a Pi session matching `8893b447-243a-4104-a8db-23d1623c95d6` (where `observedLeafId` is the final assistant message and trailing `custom`, `model_change`, `thinking_level_change`, `label`, `session_info`, or `compaction` entries follow it on the active ancestry):
  - Forking an earlier completed turn resolves `targetEntryId` to the entry immediately preceding the next trigger (`nextTrigger - 1`).
  - Forking the latest completed turn resolves `targetEntryId` to the active leaf (`path.at(-1).id`).
  - Both succeed through `resolveNativeForkTarget` + `resolvePiSessionForkTransaction(..., false)` and `resolvePiForkTarget`.
- **AC2 — Fork provenance survives rebinding on both turn fork and clone.** When `source.path` has valid framing followed only by non-message entries, `rebindPiForkFraming(source, handle, branch)` returns a valid rebound `NativeSessionForkFraming` bound to `branch.header.id`, `branch.file`, `observedLeafId: branch.path.at(-1)?.id ?? null`, and only the boundaries present in `branch.path`. A subsequent turn fork on the rebound child branch resolves accurately without throwing.
- **AC3 — Running-source transaction preserves prefix and non-message tail behavior.**
  - When `sourceRunning === true` and only non-message entries follow `observedLeafId`, `resolvePiSessionForkTransaction` resolves an earlier completed turn via `resolvePiForkTarget` with `framingSource: source`.
  - When `sourceRunning === true` and an unobserved `message` (e.g., in-flight assistant/tool/user) or `custom_message` follows `observedLeafId` (even after intermediate non-message entries), `resolvePiSessionForkTransaction` uses the covered prefix up to `observedLeafId` for an earlier turn with a proven next trigger, and rejects `selected >= covered` with `boundary_mismatch`.
- **AC4 — Fail-closed rejection preserved for genuinely ambiguous or invalid boundaries.** All of the following still throw `NativeSessionForkError` with `code: "boundary_mismatch"` (or return `undefined` from `rebindPiForkFraming`):
  - Any unobserved `type: "message"` (user, assistant, toolResult, system, etc.) after `observedLeafId` when idle (`sourceRunning === false`).
  - Any unobserved `type: "custom_message"` after `observedLeafId` when idle (`sourceRunning === false`).
  - `observedLeafId` missing from the active ancestry (truncated path, off-branch, or rewound path).
  - `selected <= start` or `selected > covered` (including `observedLeafId: null` with non-empty path).
  - Inverted `start > covered` in `rebindPiForkFraming`.
  - `valid: false`, mismatched `sourceSessionId` or `sourceNativeHandle`, off-branch/duplicate boundary entry, or an `unknown` custom boundary preceding the next trigger.
- **AC5 — Source immutability.** Neither the sanitized fixture file nor `handle.metadata.nativeSessionForkFraming` is mutated during resolution or rebinding.
- **AC6 — Static and targeted verification pass.** Targeted Vitest suite, `npm run typecheck`, and `npm run lint` pass with zero errors.

## Documentation

- **DOC1 — `docs/providers.md`:** In the Pi native session fork paragraph (around line 210), add one concise sentence stating that non-message entries appended after `observedLeafId` (such as extension `custom` state or idle `model_change`) do not invalidate provenance coverage, while any unobserved `message` or `custom_message` fails closed with `boundary_mismatch`.

## Design

### Module Boundaries and Data Flow

No new modules or public API signatures are introduced. All code changes stay within `packages/server/src/server/agent/providers/pi/session-fork.ts`, importing the existing `hasNoUnobservedNativeMessages` helper from `../../native-fork-framing.js`:

```ts
import {
  hasNoUnobservedNativeMessages,
  NativeSessionForkFramingSchema,
  type NativeSessionForkFraming,
} from "../../native-fork-framing.js";
```

1. **`validateFramingCoverage` (`session-fork.ts`):**

   ```ts
   function validateFramingCoverage({
     source,
     framing,
     positions,
     selected,
   }: PiFramingCoverageInput): number {
     const path = source.path;
     const start = framing.startEntryId === null ? -1 : positions.get(framing.startEntryId);
     const covered = framing.observedLeafId === null ? -1 : positions.get(framing.observedLeafId);
     const sourceMatches =
       framing.valid &&
       framing.sourceSessionId === source.header.id &&
       framing.sourceNativeHandle === source.file;
     if (
       !sourceMatches ||
       start === undefined ||
       covered === undefined ||
       selected <= start ||
       selected > covered ||
       !hasNoUnobservedNativeMessages(framing, path)
     ) {
       throw new NativeSessionForkError(
         "boundary_mismatch",
         "The native run provenance does not cover the active source ancestry.",
       );
     }
     return start;
   }
   ```

2. **`resolvePiSessionForkTransaction` (`session-fork.ts`):**
   Replace `framing.observedLeafId === source.path.at(-1)?.id` with `hasNoUnobservedNativeMessages(framing, source.path)`:

   ```ts
   export function resolvePiSessionForkTransaction(
     source: PiSessionPath,
     target: NativeSessionForkTarget,
     sourceRunning: boolean,
   ) {
     const framing = target.kind === "turn" ? target.framing : undefined;
     if (
       !sourceRunning ||
       target.kind !== "turn" ||
       !framing ||
       hasNoUnobservedNativeMessages(framing, source.path)
     ) {
       return { ...resolvePiForkTarget(source, target), framingSource: source };
     }
     // Existing covered-prefix branch unchanged for in-flight message/custom_message appends.
     ...
   }
   ```

3. **`rebindPiForkFraming` (`session-fork.ts`):**
   ```ts
   const start = framing.startEntryId === null ? -1 : positions.get(framing.startEntryId);
   const covered = framing.observedLeafId === null ? -1 : positions.get(framing.observedLeafId);
   if (
     !framing.valid ||
     framing.sourceSessionId !== source.header.id ||
     framing.sourceNativeHandle !== source.file ||
     start === undefined ||
     covered === undefined ||
     start > covered ||
     !hasNoUnobservedNativeMessages(framing, source.path)
   )
     return undefined;
   ```
   The rest of `rebindPiForkFraming` (label-safe `startEntryId`, boundary validation against `source.path`, filtering boundaries to `copied`, and emitting `observedLeafId: branch.path.at(-1)?.id ?? null`) remains unchanged.

### Error Contract

- All rejected coverage cases continue to throw `NativeSessionForkError("boundary_mismatch", "The native run provenance does not cover the active source ancestry.")` (preserving error code and message).
- Running-source prefix rejections continue to throw `NativeSessionForkError("boundary_mismatch", ...)` with their existing messages.
- `rebindPiForkFraming` continues to return `undefined` (never throwing) when framing cannot be validly rebound.

## Task Plan

### T1 — Allow non-message tail entries in Pi fork provenance coverage and add failure-first regression tests (single task)

Single vertical task covering implementation, regression fixture/tests, and doc update (no split justified; the change is localized to one module and its direct unit test suite).

**Files:**

- `packages/server/src/server/agent/providers/pi/fixtures/session-fork/trailing-custom-framing-session.jsonl` (new, sanitized fixture modeled on `8893b447-243a-4104-a8db-23d1623c95d6`)
- `packages/server/src/server/agent/providers/pi/fixtures/session-fork/trailing-custom-framing-persistence.json` (new, matching persisted `nativeSessionForkFraming`)
- `packages/server/src/server/agent/providers/pi/session-fork.test.ts` (update: add failure-first regression tests before editing production code)
- `packages/server/src/server/agent/providers/pi/session-fork.ts` (update: `validateFramingCoverage`, `resolvePiSessionForkTransaction`, `rebindPiForkFraming`)
- `docs/providers.md` (update: DOC1)

**Execution order (TDD red→green):**

1. Create the sanitized fixture files reproducing `8893b447-243a-4104-a8db-23d1623c95d6` (two turns with passive `custom_message` entries, inter-turn `custom` entries, and trailing `hindsight-memory.state` `custom` entries after `observedLeafId`).
2. Add regression tests to `session-fork.test.ts` covering AC1–AC5 and run `npx vitest run packages/server/src/server/agent/providers/pi/session-fork.test.ts --bail=1` to confirm the new tests **fail** with `boundary_mismatch` ("The native run provenance does not cover the active source ancestry.") before the fix.
3. Update `session-fork.ts` (`validateFramingCoverage`, `resolvePiSessionForkTransaction`, `rebindPiForkFraming`) to use `hasNoUnobservedNativeMessages` and explicit `covered` bounds.
4. Update `docs/providers.md` (DOC1).
5. Run the verification commands below and `npm run format:files` on touched files.

## Criterion → Test Map

| Criterion | Verification / Test                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1       | `session-fork.test.ts`: sanitized `8893b447`-shaped fixture through `readPiSessionPath` + `streamPiHistory` + `resolveNativeForkTarget` + `resolvePiForkTarget` and `resolvePiSessionForkTransaction(..., false)` for both turn 1 (earlier turn) and turn 2 (latest turn), plus additional non-message tail types (`model_change`, `thinking_level_change`, `label`, `session_info`, `compaction`).                       |
| AC2       | `session-fork.test.ts`: `rebindPiForkFraming` on trailing non-message source for both an earlier-turn branch and a full/clone branch, followed by a second-generation `resolvePiForkTarget` on the rebound branch.                                                                                                                                                                                                        |
| AC3       | `session-fork.test.ts`: `resolvePiSessionForkTransaction(..., true)` with (a) trailing non-message entries only, and (b) trailing non-message entries plus an in-flight `message` or `custom_message` (verifying earlier turn succeeds with prefix and `selected >= covered` rejects with `boundary_mismatch`).                                                                                                           |
| AC4       | `session-fork.test.ts`: fail-closed assertions for trailing unobserved `message` (user/assistant/toolResult) when idle, trailing unobserved `custom_message` when idle, off-branch/rewound/truncated `observedLeafId`, `selected <= start`, `selected > covered` / `observedLeafId: null`, inverted `start > covered` in `rebindPiForkFraming`, and existing `valid: false` / identity / `unknown` custom boundary tests. |
| AC5       | `session-fork.test.ts`: assert input `handle.metadata.nativeSessionForkFraming` deep-equals original snapshot and fixture file contents remain unchanged.                                                                                                                                                                                                                                                                 |
| AC6       | Exact vitest, typecheck, and lint commands pass.                                                                                                                                                                                                                                                                                                                                                                          |

## Verification Commands

```bash
npx vitest run packages/server/src/server/agent/providers/pi/session-fork.test.ts --bail=1
npx vitest run packages/server/src/server/agent/native-fork-boundary.test.ts --bail=1
npm run typecheck
npm run lint
npm run format:check:files -- packages/server/src/server/agent/providers/pi/session-fork.ts packages/server/src/server/agent/providers/pi/session-fork.test.ts docs/providers.md
```

## E2E Routing Decision

Checked `e2e-paths.yml` against all planned modified/added paths (`packages/server/src/server/agent/providers/pi/session-fork.ts`, `session-fork.test.ts`, `fixtures/session-fork/trailing-custom-framing-*`, `docs/providers.md`):

- **Matched groups in `e2e-paths.yml`:**
  - `browser` (glob `packages/server/src/server/agent/**`; affected spec is `packages/app/e2e/browser/pi-native-fork.real.spec.ts`; no `required_tests` in `browser`).
  - `pi-workflow` (glob `packages/server/src/server/agent/providers/pi/**`; `required_tests`: `packages/app/e2e/browser/pi-workflow-subagent-tree.real.spec.ts`).
- **Decision:** Skip local E2E execution for this change.
  - Per the design brief's Classification and root `AGENTS.md`, this is a targeted **bug fix** to an existing feature (not a new feature), touching only pure server-side provenance coverage checks in `session-fork.ts`. No UI, protocol, client, runtime launch, or workflow-subagent-tree code changes.
  - `pi-workflow-subagent-tree.real.spec.ts` exercises Pi workflow subagent trees and does not exercise `session-fork.ts`.
  - Targeted Vitest unit tests (`session-fork.test.ts`, `native-fork-boundary.test.ts`), `npm run typecheck`, and `npm run lint` directly prove the changed contract and all fail-closed boundaries.
  - No `e2e-paths.yml` or `.github/ci-paths.yml` updates are needed because all changed files stay within existing routed directories.

## Approval

- **Approved revision:** `r1`
- **Timestamp:** `2026-11-22T15:59:36-08:00 PST`
- **Question (`ask_user`):** `Do you approve docs/features/fix-fork-provenance-plan.md (r1) for implementation?`
- **User answer:** `Approve plan (r1)`
