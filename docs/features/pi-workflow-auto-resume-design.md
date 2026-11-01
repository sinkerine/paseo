# Pi workflow auto-resume after daemon restart — design

Status: **proposed (2026-10-31)**

When the daemon boots, start the Pi agents whose sessions have an interrupted pi-subagents workflow. pi-subagents then resumes the workflow on its own. Every other agent keeps starting on demand.

## Problem

A daemon restart kills every Pi process. pi-subagents marks each background workflow it owned as stopped with cause `runtime-replaced`. It can resume those workflows, but it only checks for them when Pi's `session_start` event fires. The daemon starts agents only when a client opens or prompts them (`packages/server/src/server/bootstrap.ts:1444`). So an agent that was idle while a workflow ran in the background has no Pi process until a person returns.

The keepass2android session on 2026-11-01 shows the gap (times UTC):

| Time     | Event                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 00:10:14 | The agent starts workflow `f2f1da54` with `async: true` and goes idle.                                                                         |
| 00:16:47 | The daemon gets SIGTERM and restarts on build `0.13.2-b2541b3`. Pi exits and the workflow stops as `runtime-replaced`.                         |
| 00:16:48 | The new daemon logs `agents will initialize on demand`.                                                                                        |
| 00:19:59 | The user opens the agent and Pi starts. In the same second pi-subagents claims the workflow (`trigger: auto`) and relaunches it as `26849f74`. |
| 00:24:00 | The resumed workflow completes and its notice wakes the agent.                                                                                 |

The workflow sat for 3 minutes 12 seconds only because nobody opened the agent. Overnight, it would have sat until morning. After 24 hours pi-subagents stops auto-resuming it, and the user has to resume it by hand.

## Goals and non-goals

Goals:

- An interrupted workflow resumes within seconds of the daemon coming back, with no client connected.
- The daemon starts only agents that have resumable work. With 83 agent records, starting all of them costs too much.
- pi-subagents stays the only code that decides whether and how a workflow resumes. Paseo only starts the process.

Non-goals:

- Resuming single or chain runs, or foreground runs. pi-subagents does not auto-resume those either.
- Resuming a turn that was cut off mid-response. That is a separate question for every provider.
- Other providers. The hook is generic, but this design only adds a Pi check.

## Detection

Paseo runs a cheap filter that errs on the side of waking an agent. pi-subagents makes the real decision once Pi starts. Waking an agent with nothing to resume costs one idle Pi process. Missing one strands a workflow, so the filter leans toward waking.

**Where the runs live.** pi-subagents writes every background run to `<root>/async-subagent-runs/<runId>/`. The root is `$PI_SUBAGENTS_TEMP_ROOT`, or `os.tmpdir()/pi-subagents-uid-<uid>` when that is unset. Paseo resolves the root with the env the Pi process gets: the daemon env, then the provider's `runtimeSettings.env`. Pi run from a terminal uses the same root, so Paseo must not move it.

**Which agents are candidates.** Non-archived records whose provider is `pi`. A record's `persistence.nativeHandle` is its session file path, and pi-subagents writes that same path as `status.sessionId`. That pairs runs with agents without reading any session JSONL.

**Which runs count.** Paseo reads `status.json` in each top-level run directory, one pass of about 300 small files. A run marks its agent for waking when all of these hold:

| Check                  | Field or file                                                                                                                    | Why                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Top-level workflow     | `mode` is `workflow`, no `parentWorkflowRunId`                                                                                   | pi-subagents resumes only these.                                                                                                          |
| Belongs to a candidate | `sessionId` equals a candidate's `nativeHandle`                                                                                  | Pairs the run with its agent.                                                                                                             |
| Interrupted            | `state: stopped` with `workflow.stopCause` `runtime-replaced` or `owner-exited`; or `state` `running`/`queued` with a dead `pid` | The second case covers SIGKILL and crashes, where Pi never wrote a stop cause. pi-subagents marks those `owner-exited` on its next start. |
| Recent                 | `endedAt`, or `lastUpdate` for a dead owner, within 24 hours                                                                     | pi-subagents' `AUTO_RESUME_MAX_AGE_MS`.                                                                                                   |
| Not already handled    | no `resume-refused.json`; no unreleased `resumed-by.<n>.json` whose `newRunId` directory exists                                  | Stops the daemon from waking an agent on every boot for a run that already resumed.                                                       |

The check lives next to `extensions/pi-subagents/async-runs.ts`, which already parses `status.json`. Its schema gains the optional fields above. It stays read-only: Paseo never writes claim or refusal files. Those formats belong to pi-subagents and change between versions.

## Waking agents at boot

The daemon wakes each marked agent through `ensureUnarchivedAgentLoaded`, the path a client open already takes. Nothing new reaches Pi, and nothing is sent to the agent.

1. **Provider hook.** `AgentClient` gains an optional method:
   `findAgentsWithInterruptedWork?(handles: AgentPersistenceHandle[]): Promise<Set<string>>`
   It takes the handles of non-archived agents and returns the native handles that need a live process. The Pi client runs the Detection check. Other providers leave it out.
2. **Boot step.** In `bootstrap.ts`, after `Agent registry loaded` and after the server is listening, start the wake step in the background. It groups non-archived records by provider and calls each client's hook. Boot never waits on it.
3. **Load.** Each match goes to `ensureUnarchivedAgentLoaded` with `broadcastTimeline: true`, at most 2 at a time. That is a resume with the interactive purpose, so Pi starts with `--session <file>`. `session_start` then fires with reason `startup`, and pi-subagents plans and launches the resume itself.
4. **Log.** One line per wake (`agentId`, the run ids that matched) and one summary line (`checked`, `woken`, `failed`). This leaves a trail in `daemon.log` the next time someone asks why a workflow did not come back.

After step 3 the daemon does nothing more. The resumed workflow's completion notice is an ordinary pi-subagents message with `triggerTurn`. It wakes the agent the same way it did at 00:24:00 in the Problem timeline.

A woken agent behaves like one a client opened. It stays loaded under the same rules, and any client that connects sees it as live.

## Edge cases

| Case                                                  | Behavior                                                                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The user opens the agent while the boot wake loads it | `ensureAgentLoaded` shares the in-flight load through `pendingAgentInitializations`. Pi starts once.                                                                            |
| The agent is archived during the wake                 | `ensureUnarchivedAgentLoaded` checks again after loading and closes it.                                                                                                         |
| A Pi terminal session holds the same session file     | pi-subagents' claim files decide who resumes. The second claimant sees `claim-busy` and does nothing.                                                                           |
| pi-subagents is missing, or `autoResume: false`       | Detection finds no runs, or Pi starts and declines. The cost is one idle Pi process per marked agent.                                                                           |
| A pi-subagents release changes the run format         | Unknown fields are ignored, and a status that fails to parse is skipped. The worst case returns to today's behavior: resume on open.                                            |
| The Pi launch fails (bad model, missing binary)       | Log a warning and move on. The agent shows its usual load error when opened.                                                                                                    |
| Many agents match after a long outage                 | Waking runs 2 at a time. Each resumed workflow is still bounded by pi-subagents' own capacity limits.                                                                           |
| The daemon restarts again during the wake             | pi-subagents gives up any planned claim it has not started, so the next boot finds the run again. After 3 resumes that followed Pi exits, pi-subagents refuses and records why. |

Crash loops are already capped by that limit of 3, so Paseo adds no retry counter of its own.

## Testing

1. **Detection unit tests**, added to the existing pi-subagents test suite. Build run directories in a temp root covering each row of the Detection table, plus a pass and a fail case for each. Include a running status whose owner pid is dead, and a run with a released claim.
2. **Boot wake test**, in the `AgentManager` or bootstrap suite, with a fake provider whose hook returns one handle. Assert that only that agent loads, that it loads once while a client open races it, and that an archived record is skipped.
3. **Real Pi end-to-end**, in `daemon-e2e/pi.real.e2e.test.ts`. Start a Pi agent with an async workflow that sleeps, restart the in-process daemon with no client connected, and wait for a `resumed-by.1.json` with `trigger: auto` plus the resumed run's completion notice in the timeline.
4. **Manual QA.** Restart the dev daemon while a workflow runs. Check `daemon.log` for the wake summary and the agent's timeline for `Auto-resumed as <id>`.

## Open questions

- [ ] Should detached single and chain runs also wake their agent? pi-subagents doesn't resume them, but a run that finished while Pi was down only reports its result once Pi starts.
- [ ] Should the same check run when a Pi process exits on its own while the daemon stays up? That case strands workflows in the same way, but this design only covers boot.
- [ ] Is a limit of 2 concurrent wakes right? Pi start cost on this machine hasn't been measured.
- [ ] Should the app mark an agent the daemon woke by itself, for example with a timeline line? Today the first sign is pi-subagents' `Auto-resumed as` notice.
