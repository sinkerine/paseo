# pi-btw side conversations and the Paseo BTW window — plan

Status: **Finalized after required human input.** The user selected the exact request prefix and read-only execution (D2, D4), layout A (docked card), and a new public `sinkerine/pi-btw` repository (D18, D20). Their latest instruction supersedes the earlier frozen-context choice: **“it should always auto pin to the latest finished turn”** (D3). They additionally required the BTW chip to toggle both show and hide. No further approval of this local design is required. GitHub creation/publication and Paseo project registration remain with the orchestrator's side-effect gate; this plan does not claim those operations have happened.

Selected showcase: [revision 4](https://artifacts.kazuki.m.mado.moe/a/5cb886d5-e7d9-4f5d-9792-c4e88189baec?revision=4), artifact `5cb886d5-e7d9-4f5d-9792-c4e88189baec`. It demonstrates A/B/C and compact sheets; **A** is selected. Mockup messages and cache counts are illustrative; it is not product verification.

Branch `pi-btw-extension-floating-window`, base `origin/main` `7a1dacf00`. Workspace `wks_781d222c08b49cad`, project `prj_fd25e9856e774463`.

Two deliverables:

- **pi-btw**, a standalone Pi extension in its own GitHub repository. `/btw <question>` opens a side conversation that sees the main agent's context and runs while the main agent keeps working. It reuses the main agent's provider prompt cache, and nothing reaches the main agent unless you send it.
- **The Paseo bridge.** It recognizes pi-btw threads, sends BTW commands without interrupting the running turn, and renders the thread as a floating in-app window: a docked card on wide layouts and a sheet on compact ones.

## 0. Diagnosis record (established before design)

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Evidence                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Nothing called pi-btw is registered as a Paseo project or present under `~/dev`, `~/.pi`, or `~/.paseo`. Public `dbachelder/pi-btw` (MIT, v0.8.1, `374465f0`, 2026-11-03) exists. Its forks (`L2ncE/pi-btw`) and same-named npm packages (`pi-btw`, `@signalridge/pi-btw`, `@narumitw/pi-btw`, …) exist too. The npm name `pi-btw` is taken.                                                                                                                                                                                                                                                                                                                | `paseo project ls`; `find`; web search; clone at `/tmp/pi-github-repos/…/87c0b9a7…`                                                                                 |
| F2  | dbachelder/pi-btw creates its child with a different serialized prefix from the parent's. It strips the date/cwd footer from `ctx.getSystemPrompt()` and appends a BTW prompt plus a `<btw_capabilities>` section. It removes `toolsAdded`/`toolsRemoved` from inherited system messages and declares its own tool set (`read,bash,edit,write` or read-only). It runs in `SessionManager.inMemory()` with a new session id, and it injects synthetic "continue thread" messages. The first system message therefore differs, so the parent's cached prefix cannot be reused (hypothesis H1 below, not measured). Follow-ups inside its own child do append. | `extensions/btw.ts:312-366` (prompt), `:500-507,520` (seed strips tool declarations), `:2124-2161` (in-memory child, tool list)                                     |
| F3  | Pi never exposes KV tensors. "KV cache" here means a provider-side prompt cache keyed on an exact request prefix, which Pi observes only as `usage.cacheRead` / `cacheWrite`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `docs/message-types.md:75-90`; pi-ai provider sources                                                                                                               |
| F4  | Each session request sends `options.sessionId = sessionManager.getSessionId()`. For openai-completions this becomes `prompt_cache_key` only when the base URL is `api.openai.com` or retention is `long` with `supportsLongCacheRetention`. It becomes `session_id`/`x-session-affinity`/`x-client-request-id` headers only with `compat.sendSessionAffinityHeaders`.                                                                                                                                                                                                                                                                                       | pi `dist/core/sdk.js:262-276`; pi-ai `dist/api/openai-completions.js:184-185,544-553,580-584`                                                                       |
| F5  | `Agent.sessionId` is a public mutable field ("Session identifier forwarded to providers for cache-aware backends"). The SDK starts cache warming only when `options.sessionId === sessionManager.getSessionId()`. A child that sends the parent's id is therefore never warmed by its own warmer.                                                                                                                                                                                                                                                                                                                                                           | pi-agent-core `dist/agent.d.ts:60-61`, `agent.js:143,311`; pi `dist/core/sdk.js:262-270`                                                                            |
| F6  | The agent loop compares the executable `context.tools` with the tools declared by transcript system messages. It inserts a `toolsAdded`/`toolsRemoved` system message before the first pending non-system message. For openai-completions without mid-conversation tool support, pi-ai folds the declarations into one top-level `tools` array. Narrowing the tool set therefore changes the serialized `tools` field even though the delta is appended.                                                                                                                                                                                                    | pi-agent-core `dist/agent-loop.js:214-249`; pi-ai `openai-completions.js:568-607,904-924`                                                                           |
| F7  | Prompt text and tool declarations live in transcript system messages. Mid-conversation system text is rendered in place on chat-completions but folded into the leading system message on providers that cannot accept it. Instructions added as a system message can therefore break the prefix on some providers, while instructions added as user content cannot.                                                                                                                                                                                                                                                                                        | pi-ai `dist/types.d.ts:336-361`; `docs/extensions.md:301`                                                                                                           |
| F8  | `context_with_system` delivers the complete transcript of each provider request after every `context` handler has run, and a handler may return it unchanged. `turn_end` carries the assistant message, `toolResults`, and their entry ids.                                                                                                                                                                                                                                                                                                                                                                                                                 | pi `dist/core/extensions/types.d.ts:679-692,828-835`                                                                                                                |
| F9  | Extensions can import `@earendil-works/pi-agent-core`, which the loader aliases, and can use `ctx.modelRegistry.streamSimple`. They can also use `SessionManager.create(cwd, sessionDir?, options?)` and `SessionManager.inMemory(cwd?, options?, entries?)`, `buildSessionContext`, `convertToLlm`, `pi.events` (`emit`/`on`), and `pi.appendEntry`, which writes custom entries excluded from model context.                                                                                                                                                                                                                                              | pi `dist/core/extensions/loader.js:54-73`; `dist/index.d.ts`; `session-manager.d.ts:13-16,190-201,386`; `event-bus.d.ts`; `types.d.ts:1272,1406`                    |
| F10 | In RPC mode an extension command sent through `prompt` runs immediately, even while streaming.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | pi `docs/rpc-commands.md` §prompt                                                                                                                                   |
| F11 | Today Paseo turns a slash command sent during a running Pi turn into **interrupt-and-replace**: `steerActiveTurn` returns `unavailable` for slash input. Sending `/btw` from Paseo would therefore kill the main run. An existing out-of-band path (`tryHandleOutOfBand`, used for `/compact`) runs a command without touching the active turn.                                                                                                                                                                                                                                                                                                             | `packages/server/src/server/agent/providers/pi/agent.ts:1465-1469,1763-1786`; `agent-manager.ts:3024-3080`; `agent-prompt.ts` (`tryRunOutOfBand` precedes steering) |
| F12 | Paseo's Pi extension adapters can run a `runtimeBridge` inside Pi. The bridge forwards `pi.events` through `ctx.ui.notify` markers to `mapRuntimeNotification`, which emits `provider_subagent` events and follows child JSONL files through `PiChildSessionFollower`. The host deletes a child's follower when its upsert reaches a non-running status, so a later follower restarts at offset 0 and replays the file.                                                                                                                                                                                                                                     | `providers/pi/extensions/contract.ts`; `gotgenes-pi-subagents/runtime-bridge.ts`; `host.ts` `followChildren`                                                        |
| F13 | Provider-subagent descriptors carry no presentation hint. The subagents track renders every one, using a popover on wide layouts and a sheet on compact ones. The track floats over the transcript through `panels/agent-tracks.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                       | `packages/protocol/src/messages.ts:5011-5030`; `docs/agent-lifecycle.md` §The subagents track                                                                       |
| F14 | The user's default provider `magpie` uses `openai-completions` against a non-OpenAI base URL with no `compat`. Pi sends no `prompt_cache_key` and no session headers to it. magpie keys its upstream affinity on a session header, or else on `conversationID(body)`, a hash derived from the first message. A byte-identical first message can preserve that derived conversation identity; this alone does not prove the same upstream account/replica or an actual cache hit. Runtime provider overrides and gateway routing still need measurement.                                                                                                     | `~/.pi/agent/models.json`; `~/dev/magpie/internal/gateway/gateway.go:9394-9440`, `affinity.go` header                                                               |
| F15 | Installed Pi is 1.4.0 (`/nix/store/l8niyvnm…-pi-coding-agent-1.4.0`). The user's own extension repos (`sinkerine/pi-hindsight`, `sinkerine/pi-artifacts`) use vitest, biome, `tsc --noEmit`, and `@earendil-works/*` dev/peer dependencies. `sinkerine/pi-goal-x` is a fork of a community extension.                                                                                                                                                                                                                                                                                                                                                       | `pi --version`; `~/dev/pi-*/package.json`                                                                                                                           |

## 1. Goal and acceptance criteria

Goal: let a user ask side questions about the main agent's live context. The questions don't interrupt the main agent, don't pollute its context, and reuse as much of its provider prompt cache as the provider allows. pi-btw must be useful in the Pi TUI alone, and Paseo must render the same thread as a floating window.

### Cache model (what "maximize KV cache utilization" can mean here)

- **Provider prompt caching, not KV tensors.** Pi and Paseo can't read, copy, or pin model KV state (F3). What they control is the request bytes. Reuse requires the same provider-tokenized prefix and compatible request settings, cache eligibility, and routing. Exact serialization of cache-relevant fields is the testable target; an equal prefix alone cannot guarantee a hit. The serialized prefix is `model` + `tools` + system prompt + messages, in the provider's own order (for example Anthropic: tools → system → messages), plus routing and cache identity (`prompt_cache_key`, affinity headers, or magpie's body hash) and retention (`cacheRetention`, TTL).
- **Strategy.** BTW's first request is the parent's last coherent request transcript, byte for byte, plus one appended BTW user message. At each question's dispatch, select the latest fully completed parent turn. If that boundary is unchanged, append to BTW's previous request. If it changed, replace only the inherited parent snapshot and replay the structured BTW suffix before the new question. This favors freshness; only the parent prefix is likely reusable after a rebase, while unchanged-boundary follow-ups can reuse the BTW suffix too.
- **Measured vs hypothetical.** Nothing here is measured yet. F2–F14 are statically validated code paths. These hypotheses become numbers in AC18:
  - **H1:** dbachelder/pi-btw's first question reads ~0 parent-cached tokens.
  - **H2:** pi-btw's first question within the TTL reads at least the parent's last request prefix.
  - **H3:** follow-ups at an unchanged parent boundary read the previous BTW request; after parent advancement the parent prefix can hit but the replayed BTW suffix is usually uncached.
  - **H4:** on magpie, without session headers, routing still matches because the first message is identical.
  - Provider/model-specific TTLs, minimum prefix sizes, region/account/replica routing, cache eviction, and the parent's `cacheWarming` policy bound H2. Unknown retention is reported as unknown; a fresh cache identity does not copy a provider cache. The extension creates no warming timer or extra idle model requests.

### Acceptance criteria

Each AC names its entry paths and evidence (test ids in §4, journey steps in §5).

**Standalone extension (repo `pi-btw`)**

- **AC1 — Side question while the main agent runs (TUI).** In `pi` interactive mode, `/btw <q>` and `/side <q>` sent while the main agent streams open the BTW overlay and stream an answer. The main run continues to completion, and its next request is unchanged by BTW. Evidence: `rpc.integration.test.ts` "busy parent", E2E-S1 TUI recording.
- **AC2 — Exact parent prefix on the first question.** The serialized body of BTW's first request starts with the parent's last coherent request. Its `messages` array element-for-element equals the parent's request messages, followed by the assistant message and tool results of that turn. `tools`, `model`, `prompt_cache_key`, and affinity headers are equal. This holds for openai-completions and anthropic-messages stub models, including representative Anthropic cache-control markers (which may move at the appended suffix), and a fixture extension that rewrites context in `context`. Compare ordered cache-relevant input, not the literal entire HTTP body: request ids, appended cache markers, and generated output are separate. Evidence: `prefix.integration.test.ts` (local HTTP stub capturing raw bodies), `prefix-report.json`.
- **AC3 — Automatic latest-finished pin.** At dispatch of each contextual question, the inherited prefix names the latest completed parent turn, even when a newer parent response or tool batch is still running. A queued question pins when dequeued. Same-boundary follow-ups append; a changed boundary replaces only the inherited prefix and retains the complete structured BTW suffix. Evidence: `boundary.test.ts` and `prefix.integration.test.ts` cases unchanged, advanced, busy-next-turn, queued, compaction, and parent-branch change.
- **AC4 — Main context isolation.** Main-agent requests made during and after a BTW thread contain no BTW content. The parent session file gains only `pi-btw/*` custom entries, which build no model context. Evidence: `prefix.integration.test.ts` "parent unchanged", `store.test.ts`.
- **AC5 — Tool policy without declaration changes.** BTW declares exactly the parent's tools. Only parent-declared read-only tools (`read`, `grep`, `find`, `ls`) execute. Any other call returns an error tool result with no side effect: the target file is unchanged and a forbidden bash call never launches its requested process. Evidence: `tools.test.ts`, `prefix.integration.test.ts` "blocked write".
- **AC6 — Explicit return only.** Content reaches the main agent only through `/btw:inject [instr]` and `/btw:summarize [instr]`. Both deliver one user message, queued as `followUp` while the main agent is busy. Evidence: `commands.test.ts`, `rpc.integration.test.ts` "inject while busy".
- **AC7 — Thread modes.** `/btw:new [q]` replaces the active BTW thread; `/btw:tangent [q]` uses no inherited conversation and its own cache identity. `/btw` and `/side` are aliases for the contextual thread. Empty-argument variants open the composer without a provider request. There is no manual Refresh command or button. Evidence: `commands.test.ts` mode/alias/empty-argument table, `rpc.integration.test.ts` and E2E-S1/S2.
- **AC8 — Cancellation.** `/btw:abort` (and Esc in the TUI) stops only the BTW request. The main run is unaffected, and the partial answer stays visible as aborted. Evidence: `rpc.integration.test.ts` "abort".
- **AC9 — Persistence and resume.** After a persistent parent Pi session restarts, `/btw <q>` restores the stored exact snapshot and complete structured BTW messages (including tool calls/results), preserving the last pinned request for display and recovery. Its next contextual question still auto-pins to the latest completed parent turn under AC3. A missing/corrupt snapshot refuses continuation with a visible error; it never silently rebuilds from newer parent context. In-memory parents show `resumable: false` and never promise restart recovery. Evidence: `rpc.integration.test.ts` "resume", `store.test.ts` corrupt/missing/in-memory cases.
- **AC10 — Context budget guard.** A BTW request whose estimated size exceeds the model's context window minus its output reserve is refused before any provider call, with an actionable message. Evidence: `thread.test.ts` "budget".

**Paseo bridge**

- **AC11 — Non-interrupting send.** With pi-btw installed, `/btw <q>` sent to a running Pi agent from the main composer or the BTW window doesn't cancel, replace, or steer the active turn, and the turn completes normally. Without pi-btw, `/btw` keeps today's behavior. Evidence: `agent.test.ts` "out-of-band extension command", `pi-btw.local.e2e.test.ts`.
- **AC12 — Recognition.** A pi-btw thread appears as a provider-subagent descriptor with `presentation: "side_conversation"` and a live timeline read from the BTW session file. The app shows it in the BTW window and not in the subagents track. An app without this change shows it as a normal provider-subagent row. Evidence: `pi-btw/index.test.ts`, `select.test.ts`, protocol test, `pi-btw.local.e2e.test.ts`.
- **AC13 — Wide floating window.** On a wide layout at 1440×900, the selected docked card floats within the owning agent pane above its composer. Evidence: `pi-btw-window.spec.ts` wide screenshot and `pi-btw-window.real.spec.ts` live journey screenshot.
- **AC14 — Compact window.** At 390×844, BTW opens as an `IsolatedBottomSheetModal` sheet and dismissal returns to its pill. Browser tests exercise compact web layout, not native keyboard or Android hit testing. Native keyboard/safe-area/Back behavior needs the device smoke specified in §4. Evidence: `pi-btw-window.spec.ts` compact screenshot, live browser journey, and native evidence or an explicit platform gap.
- **AC15 — Window actions.** The window offers follow-up, Stop (while running), Send to main, Summarize to main, New thread, and Clear. Each maps to one pi-btw command. Evidence: `send.test.ts`, E2E-P3.
- **AC16 — Reconnect and restart.** After the app reconnects, or the isolated daemon restarts and resumes the Pi agent, the BTW pill and window show the existing thread. The timeline has no duplicates. Evidence: `host` follower test, `pi-btw.local.e2e.test.ts` "restart", E2E-P5.
- **AC17 — Failure recovery.** A BTW provider failure shows a failed state with the error and a usable composer, and the next question retries. A malformed bridge payload is dropped with a warn log and no UI change. A missing pi-btw shows no BTW window. Evidence: `pi-btw/index.test.ts`, E2E-P6.

**Evidence and repository**

- **AC18 — Measured cache report.** A live run against the user's configured provider records `input`/`cacheRead`/`cacheWrite` for these requests: the parent's last request, BTW question 1, BTW follow-up, and, as a baseline, dbachelder/pi-btw 0.8.1 question 1 on the same session. It confirms or rejects H1–H4 with numbers. No pass threshold applies, because results depend on the provider. Evidence: `cache-report.md` in run artifacts.
- **AC19 — Documentation.** The required docs listed below exist and match the shipped behavior. Evidence: review diff.
- **AC20 — Separate repository and Paseo project.** pi-btw lives in its own public GitHub repo per D20 and is registered as a Paseo project after the orchestrator's side-effect gate. Paseo pins a recorded revision for E2E. Evidence: producer receipt (§3 T1), remote URL/revision, and `paseo project ls`.
- **AC21 — Chip toggles visibility.** Clicking the BTW chip while open hides the window; clicking it while hidden restores it. Neither click cancels a request, resets the thread, nor sends anything to the main agent. On compact layouts the sheet-header BTW chip provides the hide half of the same toggle while the composer chip is behind the modal. The header Minimize action also hides it. Evidence: `window-store.test.ts`, `pi-btw-window.spec.ts` toggle during a gated BTW request, same thread id before/after, wide and compact.
- **AC22 — Live Pi/provider proof.** A real installed Pi with the new extension, through an isolated daemon and real browser, answers a question from the actual live parent context while the main run continues, then answers another question after the parent completes a newer turn. Evidence: `pi-btw-window.real.spec.ts` run using the configured real provider; `live-pi-proof.md` records binary/package revisions, boundary ids, output and screenshots. A scripted provider or a fake Pi cannot satisfy this criterion.

### Decisions

Rulings use `Ruling: <decision> — <why> — <cost if wrong>`. No decisions below are waiting for human input.

- **D1 — Prompt caching only.** Ruling: optimize provider prompt-cache reuse by controlling request bytes. Never claim KV-tensor reuse — no API exposes tensors (F3). Cost if wrong: none.
- **D2 — Exact-prefix snapshot fork. [selected by user]** Ruling: BTW's context is the parent's last coherent request transcript as actually sent, captured at `context_with_system` (after all context transforms). It is followed by the assistant message and tool results from `turn_end`, then the BTW user message. Alternatives: rebuild from session entries (`buildSessionContext`), which misses per-request transforms such as tool-result collapsing; or dbachelder's rewritten prompt (F2), which shares no parent prefix. Cost if wrong: zero parent-cache reuse, with the same correctness.
  - A finished turn is one completed model response **and all its tool results** (`turn_end`), not `agent_end`/`agent_settled`. This allows BTW while the parent continues its multi-turn run. Never include an in-flight response, half-completed tool batch, newer unanswered user prompt, or dangling tool call. With no completed parent turn, report `no_finished_turn` and offer a tangent; never substitute the in-flight request.
- **D3 — Auto-pin latest finished turn. [latest explicit user instruction]** Ruling: immediately before each contextual model dispatch, resolve the latest complete parent boundary. Pin it for that BTW request's entire tool loop; later parent progress cannot mutate an in-flight BTW request. Before each queued follow-up, repeat the selection. Equal boundary digest → append; changed digest → rebuild as `[latest parent snapshot, entire structured BTW suffix, new question]`. Do not flatten/summarize BTW history or duplicate old inherited prefixes. This supersedes the user's initial frozen + manual Refresh selection. Display “Pinned to turn N” and, if the parent advances during the answer, “Next question uses turn M”. No manual Refresh action. Cost: repeated parent advancement can make every BTW suffix uncached; freshness is the user's selected priority.
- **D4 — Identical declarations, read-only execution. [selected by user]** Ruling: declare exactly the parent's folded tool set, using stubs built from the parent's declaration objects so `declareToolChanges` sees no delta (F6). Execute only the read-only built-ins the parent declares; every other call returns an error result. BTW instructions say which tools work. Bash, edit, and write are excluded because BTW runs concurrently with a main agent editing the same tree. Cost if wrong: the user wants BTW to run commands, which would need opt-in bash at no cache cost (execution only).
- **D5 — Cache identity and concurrency.** Ruling: use the parent's cache/routing identity through public `Agent.sessionId` (F5), retaining a distinct child file/session id. On APIs that serialize that value, the corresponding key/affinity matches; the observed magpie config uses the body-derived identity instead. Request/cancellation ids remain distinct. Prefer independent SSE requests for BTW rather than sharing a parent WebSocket or `previous_response_id`; sharing a routing key must not share mutable transport state. A provider without independent concurrent requests under that cache identity fails explicitly, never cancels the parent. No BTW cache-warming calls. Tangent uses its own identity. Cost: caches may still be evicted, expire, or be routed elsewhere, particularly for group models and rotated credentials.
- **D6 — Inherit model, thinking, and retention.** Ruling: use the parent's model, thinking level, and cache retention at boundary time. `/btw:model` and `/btw:thinking` overrides are allowed, and the state then reports `sharesParentPrefix: false, reason: "model_override"`. Cost if wrong: none.
- **D7 — BTW instructions as user content.** Ruling: wrap the first BTW question as `<btw>…instructions…</btw>\n\n<question>`. Never add a system message (F7). Cost if wrong: slightly weaker instruction priority.
- **D8 — Raw `Agent` instead of `AgentSession`.** Ruling: drive `@earendil-works/pi-agent-core` `Agent` with the snapshot messages. Its `streamFn` uses `ctx.modelRegistry.streamSimple` with the parent's request options, and `convertToLlm` is Pi's exported converter. AgentSession would re-derive the prompt and tools from its own resource loader and could append prompt or tool deltas. Cost if wrong: BTW reimplements small conveniences (retry, persistence glue).
- **D9 — Persistence.** Ruling: store the exact normalized model-visible snapshot once per boundary as `<agentDir>/btw/sessions/<parentSessionId>/<threadId>/<prefixDigest>.json`, and a Pi session JSONL containing only structured BTW messages beside it. Parent custom entries contain only the index/reference, never model context. Persist the snapshot atomically before announcing/indexing a thread; automatic repinning writes the chosen snapshot then an append-only `pi-btw/rebase` reference. Keep a single atomic latest-finished checkpoint per persistent parent as turns complete, so resume can select a newer completed turn without reconstructing transient context transforms. Retain snapshots required by the current thread/in-flight requests; prune superseded unreferenced checkpoints rather than storing every parent's full history again. Store directories/files privately (0700/0600); preserve array/key order used for serialization. Resume validates the digest and rebuilds runtime state from the stored snapshot, not from a changed parent file. Complete tool results and assistant signatures survive. Corruption is explicit and fail-closed. For an in-memory parent keep all of this in memory, report `resumable: false`, and do not claim cross-process recovery. Cost if wrong: extra serialization/disk writes for the latest checkpoint and selected boundaries; digest sharing and pruning bound retained copies.
- **D10 — One thread per parent session.** Ruling: one active thread. A question sent while BTW is answering queues as a BTW follow-up. Cost if wrong: none.
- **D11 — Explicit return.** Ruling: only inject and summarize write to the main agent. Neither clears the thread. Cost if wrong: none.
- **D12 — Summarize as a BTW continuation.** Ruling: enqueue “summarize this thread for the main agent” as a normal BTW question, applying D3 latest-finished pinning first. It can reuse the prior BTW suffix only if the parent boundary is unchanged. Show the summary, then explicitly inject it. Keep the thread on delivery failure and expose Retry. Cost: no extra summary-only context format, but a rebase may require reprocessing the suffix.
- **D13 — Context budget and compaction.** Ruling: parent compaction never mutates an in-flight BTW request; the next question auto-pins to its latest completed compacted turn, invalidating old prefix expectations. BTW itself does not silently compact. Estimate `parent prefix + BTW suffix + next question + output reserve` against the selected model context window before dispatch. Over-budget leaves the question draft intact and suggests New thread (drops the BTW suffix) or Tangent. Never truncate a tool pair or drop arbitrary parent messages. Cost: long threads can reach a visible limit.
- **D14 — Host contract on `pi.events`.** Ruling: pi-btw emits versioned `pi-btw:thread` events and answers `pi-btw:sync` requests. Hosts never parse TUI output. In RPC mode pi-btw doesn't `notify` answers. Cost if wrong: none.
- **D15 — Out-of-band extension commands in Paseo.** Ruling: `PiExtension.outOfBandCommands` declares names. The Pi agent's `tryHandleOutOfBand` routes a matching slash command through RPC `prompt` only when Pi's command list contains it. Main-composer `/btw` still records the user's breadcrumb row, which Pi history doesn't replay. Cost if wrong: if pi-btw isn't installed, `/btw` keeps today's behavior.
- **D16 — Protocol.** Ruling: an optional open-string `presentation` on `ProviderSubagentDescriptorPayloadSchema`, known value `"side_conversation"`. Clients treat unknown values as a normal track row. No capability gate, per AGENTS.md: old daemons never emit the field, and an old app shows a normal row. Cost if wrong: none.
- **D17 — Long-lived child observation.** Ruling: add an internal child-file `lifetime?: "conversation"` hint for BTW. The host parks its follower at idle and resumes the same `{id,file}` offset, rather than replaying from byte zero. For this mode apply byte/item budgets per read, not forever: the current 2 MiB/200-item lifetime caps would otherwise stop updates in a long thread. Default one-shot subagent behavior stays as implemented. Clear/removal and host close release parked followers. A new file/generation resets that reader explicitly. Evidence must include idle→running→idle and a thread beyond 200 items. Cost: retained reader offsets for the one active BTW thread per parent.
- **D18 — Window shape. [selected by user]** Ruling: layout **A**, docked card, from the showcase (latest revision 4):
  - Wide: a docked floating card at the bottom-right of the agent pane, above the composer track bar, `min(440, paneWidth − 32)` wide, at most 60% of the pane's height. It isn't draggable in v1.
  - Compact: an `IsolatedBottomSheetModal` sheet. Its header includes the same BTW chip toggle bound to the same visibility state, since a modal backdrop prevents reaching the original composer chip. The header chip hides; the composer chip reopens. Do not put a click-through hole in the modal backdrop.
  - The chip in `ComposerTrackBar` toggles show/hide in both directions. Header Minimize, sheet dismissal, and Escape hide the surface; none stops generation or changes the thread. Controls are always visible on native/touch layouts. Gate the overlay by owner pane focus; navigating away hides it without cancelling.
  - First discovery auto-opens once per thread per client. An upsert or status change must never reopen a user-hidden window. Visibility is local to the client, keyed by `(serverId, agentId, threadId)`; other clients can choose their own state.

  Cost if wrong: movable/resizable placement would be follow-up work with no provider contract change.

- **D19 — No feature flag.** Ruling: ship enabled, per AGENTS.md. Cost if wrong: none.
- **D20 — Repository. [selected by user]** Ruling: a **new public** `sinkerine/pi-btw`, written around this context strategy, MIT, with attribution and license preservation for any reused dbachelder/pi-btw code. Package name `@sinkerine/pi-btw` (npm `pi-btw` is taken), installed via `git:` pinned to the producer revision or a local path. No npm publication, Nix changes, or live Pi install in scope. The user settled destination and visibility; the orchestrator owns creation/publication and Paseo registration under its side-effect gate. Cost if wrong: TUI polish must be built instead of inherited.
- **D21 — Real Pi with a scripted HTTP model for deterministic proof.** Ruling: tests run the real Pi 1.4.0 binary/SDK and real pi-btw against a local OpenAI-compatible and Anthropic-compatible HTTP stub that records raw bodies. The cache-hit amount (AC18) has no numeric pass threshold, but real Pi/provider correctness and the live-browser journey are required (AC22). Scripted HTTP fixtures prove serialization and routing behavior only; they do not substitute for live provider proof. Cost if wrong: none.
- **D22 — Out of scope.** Nix packaging, `/nixfiles` pins, installing into the user's live Pi, draggable windows, and token-level streaming in Paseo are out of scope. Paseo renders completed messages from the BTW file, plus running status. Cost if wrong: follow-up work.

### Required docs

- pi-btw repo: `README.md` (commands, modes, tool policy, persistence), `docs/context-and-cache.md` (D1–D7, D13, measured results from AC18), `docs/host-contract.md` (contract v1), `AGENTS.md` (test commands), `CHANGELOG.md`.
- Paseo:
  - `docs/glossary.md`: add **BTW window** / **BTW conversation**, and keep them distinct from **Side pane**.
  - `docs/agent-lifecycle.md` §The subagents track: side-conversation descriptors render in the BTW window, not the track.
  - `docs/providers.md`, Pi extension adapters: `outOfBandCommands` and follower parking.
  - This plan.

### Human input and approval

- **Human input: required and obtained.** The user explicitly requested discussion of context/cache management. The first ask_user resolved D2 exact last request + question, initially D3 frozen + explicit Refresh, and D4 read-only execution. Their subsequent explicit correction **“it should always auto pin to the latest finished turn”** replaces that D3 selection. No repeated approval is needed for their direct instruction. They requested a showcase before selecting D18.
- **Actual resolution:** the user selected **“A but click on the chip should toggle both show/hide”**, then **“New public sinkerine/pi-btw”** in the repository question. D18 and D20 are settled. The showcase was republished as revision 2 with chip toggling and revision 3 with automatic pinning and no manual Refresh. Revision 4 adds the accessible compact sheet-header chip so the same hide action is reachable above the modal backdrop. The latest D3 correction is reflected in both the plan and showcase.
- **Infrastructure gate resolved:** at the user's request, `paseo agent open 1b050767-58e0-46ef-89e6-3e6c2b1b701d --json` returned `status: "opened"`; the daemon stayed running and untouched, and the orchestrator was notified.
- **Additional approval of this design: not required.** These are required design inputs, not a blanket approval of implementation or external effects. No instruction imposes a separate final design approval; finalize using status **finalized after required human input**. The orchestrator still resolves its external-operation gate before creating/publishing the chosen public repo or registering its Paseo project. The design agent has created neither.

## 2. Design

### Data flow

```text
Pi parent (RPC under Paseo, or TUI)
  context_with_system ──► BoundaryTracker.pendingRequest      (copy of the exact sent transcript)
  turn_end            ──► BoundaryTracker.coherent            (pending + assistant + toolResults)
  /btw <q>  ──► BtwController ──► BtwThread (pi-agent-core Agent)
                                   messages = snapshot ++ btwMessages ++ [user(<btw>…</btw> q)]
                                   tools    = declaration-identical stubs (+ read-only executors)
                                   sessionId= parent sessionId → same cache key/affinity/routing
                                   streamFn = ctx.modelRegistry.streamSimple(parent options)
             ├─ message_end ──► child JSONL (BTW messages only)
             ├─ pi.events.emit("pi-btw:thread", state) ──► TUI overlay | host bridge
             └─ pi.appendEntry("pi-btw/thread", index)   (no model context)
  /btw:inject|summarize ──► pi.sendUserMessage(text, busy ? {deliverAs:"followUp"} : {})

Paseo daemon
  runtimeBridge (inside Pi): pi.events.on("pi-btw:thread") → ctx.ui.notify("PASEO_PI_BTW {json}")
  piBtw adapter.mapRuntimeNotification → provider_subagent upsert(presentation:"side_conversation")
                                        + childSessions[{id,file}] → PiChildSessionFollower (parked on idle)
  send_agent_message_request("/btw …") → tryRunOutOfBand → PiAgentSession.tryHandleOutOfBand
                                        → runtimeSession.prompt(text)   (active turn untouched)
App
  provider-subagent store → selectBtwThread(agentId) → BtwPill (track bar) + BtwWindow
  wide: BtwFloatingCard (in-pane overlay)   compact: BtwSheet (IsolatedBottomSheetModal)
  window composer/actions → sendBtwCommand → send_agent_message_request (no messageId)
```

### Standalone repository `pi-btw` (external producer)

```text
pi-btw/
  package.json        name "@sinkerine/pi-btw", type module, "pi": { "extensions": ["./extensions/btw.ts"] }
                      peerDependencies @earendil-works/{pi-ai,pi-agent-core,pi-coding-agent,pi-tui} ">=1.4.0 <2"
                      devDependencies pinned 1.4.0 + vitest, typescript, @biomejs/biome
                      scripts: typecheck, lint (biome check .), test:unit, test:integration, measure:cache
  extensions/btw.ts   default export (pi: ExtensionAPI) => void; wires everything below
  src/contract.ts     host contract v1 (exported as "./contract")
  src/boundary.ts     BoundaryTracker
  src/thread.ts       BtwThread
  src/tools.ts        declaration-preserving tools
  src/store.ts        child JSONL + parent index entries
  src/commands.ts     command parsing and handlers
  src/digest.ts       prefix digest
  src/tui/overlay.ts  TUI overlay (ctx.mode === "tui" only)
  tests/unit/*.test.ts
  tests/integration/{prefix,rpc}.integration.test.ts, tests/support/http-stub.ts
  scripts/measure-cache.mjs
  docs/context-and-cache.md, docs/host-contract.md, README.md, AGENTS.md, CHANGELOG.md, LICENSE
```

#### Interfaces

```ts
// src/contract.ts
export const BTW_CONTRACT_VERSION = 1 as const;
export const BTW_THREAD_CHANNEL = "pi-btw:thread" as const; // pi-btw → hosts
export const BTW_SYNC_CHANNEL = "pi-btw:sync" as const; // hosts → pi-btw: re-emit current state
export type BtwMode = "contextual" | "tangent";
export type BtwStatus = "idle" | "running" | "failed" | "aborted";
export interface BtwBoundary {
  kind: "turn_end" | "none"; // contextual needs a completed turn; tangent has none
  parentLeafEntryId: string | null;
  parentTurnIndex: number | null;
  messageCount: number;
  prefixDigest: string; // sha256 hex of canonical JSON of snapshot AgentMessages
  pinnedAt: string; // ISO 8601; immutable during one BTW answer
}
export interface BtwCacheIdentity {
  provider: string;
  modelId: string;
  api: string;
  thinkingLevel: string;
  requestSessionId: string; // parent session id unless tangent
  sharesParentPrefix: boolean;
  reason: "model_override" | "tangent" | "unverified_serialization" | null;
}
export interface BtwUsageSample {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  at: string;
}
export interface BtwThreadState {
  version: typeof BTW_CONTRACT_VERSION;
  parentSessionId: string;
  threadId: string;
  mode: BtwMode;
  status: BtwStatus;
  title: string; // first question, ≤ 80 chars
  sessionFile: string | null; // null when the parent has no session file
  resumable: boolean;
  revision: number; // monotonic state revision; stale events are ignored
  boundary: BtwBoundary;
  parentAhead: number;
  cache: BtwCacheIdentity;
  lastUsage: BtwUsageSample | null;
  error: string | null;
  updatedAt: string;
}
export type BtwThreadEvent =
  | { type: "state"; thread: BtwThreadState }
  | {
      type: "closed";
      version: 1;
      parentSessionId: string;
      threadId: string;
      reason: "cleared" | "replaced";
    };

// src/boundary.ts
export interface BtwSnapshot {
  messages: AgentMessage[];
  boundary: BtwBoundary;
}
export class BoundaryTracker {
  constructor(pi: ExtensionAPI); // registers context_with_system, turn_end, agent_settled, session_start
  current(ctx: ExtensionContext): BtwSnapshot; // latest finished boundary; throws BtwError("no_finished_turn")
  completedTurnsSince(boundary: BtwBoundary): number;
}

// src/tools.ts
export const READ_ONLY_TOOL_NAMES: readonly ["read", "grep", "find", "ls"];
export function foldDeclaredTools(messages: readonly AgentMessage[]): Tool[]; // replay toolsAdded/toolsRemoved
export function createBtwTools(declared: readonly Tool[], cwd: string): AgentTool[];
// Same name/description/parameters objects; read-only names delegate to Pi's built-in tool factories,
// every other execute() throws BtwError("tool_unavailable", name).

// src/thread.ts
export interface BtwThreadOptions {
  ctx: ExtensionContext;
  snapshot: BtwSnapshot;
  mode: BtwMode;
  latestFinished(): BtwSnapshot; // evaluated at each contextual question's dispatch
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  requestSessionId: string;
  priorMessages: AgentMessage[];
  store: BtwStore;
  onState(state: BtwThreadState): void;
}
export class BtwThread {
  constructor(options: BtwThreadOptions);
  readonly id: string;
  ask(question: string): Promise<void>; // queues as follow-up while running
  summarize(instructions?: string): Promise<string>; // append-only summary request (D12)
  // ask() resolves latestFinished() when dequeued, then privately repins if its digest changed.
  abort(): void;
  transcriptText(): string; // BTW suffix only; never copy the inherited parent into /btw:inject
  state(): BtwThreadState;
  dispose(): Promise<void>;
}

// src/store.ts
export interface BtwThreadIndex {
  parentSessionId: string;
  threadId: string;
  sessionFile: string | null;
  mode: BtwMode;
  boundary: BtwBoundary;
  cache: BtwCacheIdentity;
}
export class BtwStore {
  static open(ctx: ExtensionContext, threadId: string, parentFile: string | undefined): BtwStore;
  appendMessage(message: AgentMessage): void;
  appendBoundary(boundary: BtwBoundary, kind: "boundary" | "rebase"): void;
  readMessages(): AgentMessage[];
  readonly file: string | null;
  saveSnapshot(snapshot: BtwSnapshot): Promise<string | null>; // path only for persistent parents; atomic
  loadSnapshot(digest: string): Promise<BtwSnapshot>; // validate digest; never silently rebuild
}
export function latestThreadIndex(branch: readonly SessionEntry[]): BtwThreadIndex | null; // last pi-btw/thread not followed by pi-btw/clear

// src/commands.ts — registered names (D10–D13)
// btw, side, btw:new, btw:tangent, btw:abort, btw:inject, btw:summarize, btw:clear, btw:model, btw:thinking, btw:status
export type BtwErrorCode =
  | "no_finished_turn"
  | "busy"
  | "over_budget"
  | "tool_unavailable"
  | "no_thread"
  | "model_unavailable"
  | "provider_error"
  | "snapshot_unavailable"
  | "unsupported_serialization";
export class BtwError extends Error {
  constructor(code: BtwErrorCode, detail?: string);
}
```

#### Conventions and errors

- Request options mirror the parent's `streamSimple` options: `sessionId`, `reasoning` from the thinking level, `cacheRetention`, `maxTokens`, `transport`, and the client identity header. T1 proves each in the byte test. If one isn't reproducible, it's documented in `context-and-cache.md` with its cache effect.
- pi-btw should load after extensions that transform context in `context_with_system`; transforms in `context` are always included. This is documented, and AC2 covers a `context` transformer.
- Errors surface as `status: "failed"` with `error`, plus a TUI notice. `over_budget` and `tool_unavailable` messages say what to do next. In RPC mode command handlers enqueue BTW work and acknowledge immediately, attaching a rejection handler that emits failed state. Do not await a whole BTW generation inside `tryRunOutOfBand`'s foreground mutation: that would prevent Stop and other commands from being admitted until completion. RPC tests must send Stop before releasing the held BTW provider response.
- `session_shutdown` aborts and disposes the thread idempotently, after the child file is flushed. Parent cancellation alone does not abort an independent BTW answer; parent session replacement/shutdown does. On reload, reject events from the old generation. Mark a crashed running BTW request interrupted and keep its partial transcript; never replay a question automatically.
- Scope parent indexes/checkpoints to the current native session id and active branch. A cloned/forked Pi session must never claim an inherited source thread or source in-flight work; an owner mismatch is ignored. Rewind/tree-switch reselects only a coherent boundary on the active branch. If the latest checkpoint no longer belongs to that branch, require a new completed parent turn rather than using abandoned context.
- At first installation into a session with no captured completed checkpoint, show `no_finished_turn` until one parent turn finishes; a session-history clone is not evidence of exact request serialization. Tangent still works.
- Plain RPC/SDK hosts consume the pi.events contract via a host bridge; `/btw:status` may notify status in RPC. JSON/print/headless operation must not open a TUI overlay. Text questions, Unicode, and multiline text are passed as JSON string values, never shell-built commands.
- The extension starts no daemon, HTTP server, external subagent workflow, or inherited extension factories. Built-in read-only tool execution retains cwd and the frozen declarations; arbitrary similarly named extension tools are not assumed read-only. Unsupported calls return an explicit tool result.
- Validate bridge version, native-session ownership, state revision, file identity and schema. Report malformed/unsupported events with one bounded warning. File followers read only the extension-owned thread file, never parent snapshot JSON. A provider error populates the descriptor description so the app can show it inline and keep a retryable composer.
- Every fallible window action has pending/success/error state. Draft text survives dispatch failure. Prevent duplicate Send/Inject/Summarize submissions while pending; thread revisions and a per-runtime generation token prevent late replies from replacing a newer thread. Do not automatically resend a command on ambiguous disconnect; reconcile state before a human retries. No automatic result forwarding on finish, hide, reconnect, or clear.

### Paseo integration boundary (smallest bridge)

```ts
// packages/server/src/server/agent/providers/pi/extensions/contract.ts
export interface PiExtension {
  id: string;
  runtimeBridge?: string;
  /** Slash commands this extension handles inside Pi without starting a run; sent out of band. */
  outOfBandCommands?: readonly string[];
  createSession(): PiExtensionSession;
}

// packages/server/src/server/agent/providers/pi/extensions/contract.ts also extends:
//   PiChildSessionFile.lifetime?: "conversation"; // opt-in reader parking/per-tick budgets for BTW

// packages/server/src/server/agent/providers/pi/extensions/pi-btw/index.ts
export const PI_BTW_MARKER = "PASEO_PI_BTW";
export const piBtwRuntimeBridge: string;
// session_start: capture ctx, then pi.events.emit("pi-btw:sync", {})
// pi.events.on("pi-btw:thread", e => ctx.ui.notify(`${PI_BTW_MARKER} ${JSON.stringify(e)}`, "info"))
export const piBtw: PiExtension;
// id "pi-btw"; outOfBandCommands = ["btw","side","btw:new","btw:tangent","btw:abort",
//   "btw:inject","btw:summarize","btw:clear","btw:model","btw:thinking","btw:status"]
// mapRuntimeNotification: zod-parse BtwThreadEvent v1 →
//   state  → { subagents: [upsert{ id:`btw:${threadId}`, title, description, status, hasTimeline:true,
//              subtitle, presentation:"side_conversation" }], childSessions: file ? [{ id, file, lifetime:"conversation" }] : [] }
//   closed → { subagents: [{ type:"remove", id }] }
// status map: running→"running", idle→"completed", failed→"failed", aborted→"canceled"
// subtitle: "Read-only · pinned turn N · next turn M · cache P%" (P = cacheRead/(input+cacheRead+cacheWrite)); omit unknown cache P.

// packages/server/src/server/agent/providers/pi/agent.ts — tryHandleOutOfBand adds:
//   Synchronously consult the initialized command cache for a name in outOfBandExtensionCommands.
//   Command discovery/bridge handshake initializes that set before BTW is advertised.
//   → { run: async () => { await this.runtimeSession.prompt(text); } }
//   tryHandleOutOfBand is synchronous; do not await inside it. Initialize command support at session
//   startup; a cold cache must not cause a /btw command to fall into turn replacement.

// packages/server/src/server/agent/providers/pi/extensions/host.ts — followChildren parks finished followers:
//   private readonly parked = new Map<string, Follower & { file: string }>();
//   conversation lifetime + finished id → read final, park; matching { id, file } → resume.
//   conversation lifetime uses per-read budgets (not an all-time 200-item ceiling);
//   remove/host close releases its reader; other subagent lifetimes keep their existing behavior.

// packages/server/src/server/agent/provider-subagents/store.ts
//   ProviderSubagentDescriptor.presentation: string | null; upsert input `presentation?: string | null` (sticky)

// packages/protocol/src/messages.ts — ProviderSubagentDescriptorPayloadSchema
//   // Open string: "side_conversation" renders in the BTW window; clients treat unknown values as track rows.
//   presentation: z.string().nullable().optional(),

// packages/app/src/btw/
export function selectBtwThread(rows: readonly ProviderSubagentRow[]): ProviderSubagentRow | null; // select.ts
export type BtwCommand =
  | { kind: "ask"; text: string }
  | { kind: "abort" }
  | { kind: "inject"; instructions?: string }
  | { kind: "summarize"; instructions?: string }
  | { kind: "new"; text?: string }
  | { kind: "clear" };
export function btwCommandText(command: BtwCommand): string; // send.ts
export function useSendBtwCommand(
  serverId: string,
  agentId: string,
): (command: BtwCommand) => Promise<void>; // no messageId
export const useBtwWindowStore: UseBoundStore<
  StoreApi<{
    // window-store.ts
    byThread: Record<string, "open" | "minimized">; // serverId + agentId + threadId
    setMode(key: string, mode: "open" | "minimized"): void;
    toggle(key: string): void; // both show→hide and hide→show
  }>
>;
export function BtwPill(props: { serverId: string; agentId: string }): ReactElement | null; // pill.tsx
export function BtwWindow(props: { serverId: string; agentId: string }): ReactElement | null; // window.tsx (layout switch)
// window-content.tsx (header, AgentStreamView of the provider-subagent timeline, composer, actions)
// floating-card.tsx (wide), sheet.tsx (compact)
```

- Track exclusion: `subagents/select.ts` and `use-subagent-tree.ts` drop `presentation === "side_conversation"` rows.
- Mounting: `panels/agent-tracks.tsx` renders `BtwPill`; `panels/agent-panel.tsx` renders `BtwWindow` inside the pane container. The window auto-opens only on first discovery of a `threadId`; later state/timeline updates preserve the client's visibility choice. The chip toggles either direction. The minimized window keeps its session observation active while the owning pane is mounted.
- Platform: no DOM APIs; Esc-to-minimize only behind `isWeb`; sheet keyboard handling per `docs/floating-panels.md` Gotcha 3 and the existing sheet stack; i18n strings in `packages/app/src/i18n/resources/*.ts`.

## 3. Tasks

### T1 — pi-btw extension repository (external producer)

- Split: separate producer — pi-btw is its own Git repository with its own toolchain, tests, and revision. Paseo consumes only its contract v1 and a pinned revision, and one worker in the Paseo worktree can't own commits in another repository under the Paseo gates.
- Goal: AC1–AC10, AC18, and the pi-btw side of AC19 and AC20. Include a small `tests/unit/tui.test.ts` for focus, Esc abort/dismiss ordering, and Unicode/narrow-width rendering using the existing pi-tui primitives.
- Owned files: everything under the new repo (default `~/dev/pi-btw`, created only after the side-effect gate).
- Produces: `src/contract.ts` v1, the `pi-btw:thread`/`pi-btw:sync` channels, the BTW session JSONL format, and the command names.
- Consumes: Pi 1.4.0 APIs (F4–F10).
- Unit command: `npm run typecheck && npm run lint && npx vitest run tests/unit --bail=1`.
- Producer receipt (required before T2's live gates): commit SHA; compatibility (`pi --version` 1.4.0, peer range); `npm pack --json` tarball sha256 or `git archive HEAD | sha256sum`; unit and integration logs; `prefix-report.json`; `cache-report.md`.

### T2 — Paseo bridge, protocol field, and BTW window

- Split: separate producer — T2 consumes the independently versioned T1 repository contract; all Paseo protocol/server/app work remains one task because it shares one build and wiring chain.
- Goal: AC11–AC17, AC21–AC22, and the Paseo side of AC19 and AC20.
- Owned files:
  - protocol: `packages/protocol/src/messages.ts`, `packages/protocol/tests/validation/ws-outbound.test.ts`
  - server store: `packages/server/src/server/agent/provider-subagents/store.ts` (+test)
  - Pi extensions: `packages/server/src/server/agent/providers/pi/extensions/{contract.ts,host.ts,child-session.ts,registry.ts,index.test.ts}`, `…/pi-btw/{index.ts,index.test.ts}`
  - Pi agent: `packages/server/src/server/agent/providers/pi/agent.ts` (+`agent.test.ts`)
  - daemon e2e: `packages/server/src/server/daemon-e2e/pi-btw.local.e2e.test.ts` + `fixtures/pi-btw-stub/`
  - app: `packages/app/src/btw/**`, `packages/app/src/subagents/{select.ts,use-subagent-tree.ts}` (+tests), `packages/app/src/panels/{agent-tracks.tsx,agent-panel.tsx}`, `packages/app/src/i18n/resources/*.ts`
  - app e2e: `packages/app/e2e/browser/pi-btw-window.spec.ts` (deterministic local HTTP fixture), `pi-btw-window.real.spec.ts` (actual provider), `packages/app/e2e/support/helpers/pi-btw.ts`; native smoke files under existing `packages/app/e2e/mobile/agent-device/pi-btw.{ios,android}.ad`
  - docs: the Paseo docs in Required docs
- Consumes: contract v1 (the doc's shape is mirrored in a zod schema in `pi-btw/index.ts`).
- Dependencies: unit work can start from the contract. `pi-btw.local.e2e.test.ts`, the Playwright spec, and the Pi workflow regressions need T1's receipt and use `PASEO_PI_BTW_PACKAGE=<checkout at SHA>`.
- Unit command: `npm exec --workspace=@getpaseo/server -- vitest run src/server/agent/providers/pi/extensions/pi-btw/index.test.ts --maxWorkers=1 --bail=1`.

### Waves (presentation only)

- Wave 1: T1 and T2 unit and UI work in parallel.
- Gate G1: T1 receipt.
- Wave 2: T2 real-Pi daemon E2E, Playwright journey, and Pi workflow regressions against the pinned T1 SHA.

### Conflicts and uncertainty

- All workers are direct children of the orchestrator; the design agent delegates nothing. One writer per repository/worktree. T1's approved producer workspace and T2's Paseo worktree must be distinct.
- No file overlap between T1 and T2. T2 owns protocol generation and all `build:server` output; do not run concurrent builds in its worktree. Browser and workflow tests run sequentially to avoid competing Metro/Chromium/Pi processes.
- Shared resources are per-run temp `PI_CODING_AGENT_DIR`s and each Playwright worker's isolated daemon. Never use port 6767.
- Uncertain items that T1 must prove first and report:
  - The client identity header and `cacheRetention` can be reproduced in BTW options.
  - RPC `prompt` with an extension command during streaming needs no `streamingBehavior` (F10).
- **G0 serialization gate:** T1 must show ordered prefix/loaded tool equality with Pi 1.4.0. If a cache-relevant field or provider transform cannot be preserved, do not weaken AC2 into a pass: report the captured divergence and stop that path for orchestrator design correction. `context_with_system` capture alone does not prove the final provider payload is equal. Never send `fork`/`clone` to the parent: those APIs switch/abort its runtime rather than producing an independent request.

## 4. Test and verification

### Environment and discovery

- Export `PASEO_PI_BINARY=/nix/store/l8niyvnm0wbpmk1faq8lxw96nf6d5hqr-pi-coding-agent-1.4.0/bin/pi`; assert `--version` = 1.4.0. Export `PASEO_PI_BTW_PACKAGE` as the absolute producer checkout **at the receipt SHA**, not a moving branch. Node and Chromium runtime libraries come from the existing Nix/direnv development shell (`docs/development.md`).
- pi-subagents for the workflow regressions: `PASEO_PI_SUBAGENTS_PACKAGE`, the installed 0.84.0 path from `~/.pi/agent/settings.json`.
- Stub models: `openai-completions` with `compat.sendSessionAffinityHeaders: true` and `supportsLongCacheRetention: true` under `PI_CACHE_RETENTION=long`, so `prompt_cache_key` and the headers are serialized. An `anthropic-messages` stub model is also used. All pi-btw tests use a temp `PI_CODING_AGENT_DIR`.
- Runners: pi-btw uses vitest with `tests/unit` and `tests/integration`. Paseo uses vitest projects (`unit`/`browser` in app; server excludes `*.e2e.test.ts` from unit runs) and Playwright projects (`browser`, `real-provider`).
- Generated inputs: protocol AOT validators regenerate on `build`/`typecheck`/`test` npm hooks. Direct `npm exec … vitest` does not invoke pretest: run `npm run generate:validators --workspace=@getpaseo/protocol` first. Run `npm run build:server` after changing `messages.ts` and before diagnosing cross-package type errors; `npm run build:client` suffices when only protocol/client declarations changed. Never add duplicate local types to silence stale `dist`.
- Runner discovery before execution: `npm exec --workspace=@getpaseo/server -- vitest list src/server/daemon-e2e/pi-btw.local.e2e.test.ts`; `npm exec --workspace=@getpaseo/app -- vitest list src/btw --project=unit`; `npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/pi-btw-window.spec.ts --list`; `npm run test:e2e:real --workspace=@getpaseo/app -- e2e/browser/pi-btw-window.real.spec.ts --list`. Zero selected tests is a failure, not a green receipt.
- Real provider fixtures use the configured provider through a disposable Pi agent directory (credentials/provider config only; no goal/subagent auto-resume extensions), with no auth prechecks or conditional skips. Never print credentials. Unset inherited child-only `PI_*` identifiers before launching fixtures, following `e2e/support/helpers/pi-workflow.ts`.

### Targeted unit and integration

| Test                                                           | Command                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pi-btw unit (boundary, tools, thread, store, commands, digest) | `cd ~/dev/pi-btw && npx vitest run tests/unit --bail=1`                                                                                                                                                                           |
| pi-btw prefix (AC2–AC5)                                        | `cd ~/dev/pi-btw && PI_BINARY=$PASEO_PI_BINARY npx vitest run tests/integration/prefix.integration.test.ts --bail=1`                                                                                                              |
| pi-btw RPC real binary (AC1, AC6, AC8, AC9)                    | `cd ~/dev/pi-btw && PI_BINARY=$PASEO_PI_BINARY npx vitest run tests/integration/rpc.integration.test.ts --maxWorkers=1 --bail=1`                                                                                                  |
| pi-btw gates                                                   | `cd ~/dev/pi-btw && npm run typecheck && npm run lint`                                                                                                                                                                            |
| Paseo adapter                                                  | `npm exec --workspace=@getpaseo/server -- vitest run src/server/agent/providers/pi/extensions/pi-btw/index.test.ts --maxWorkers=1 --bail=1`                                                                                       |
| Paseo host parking and long-thread cadence                     | `npm exec --workspace=@getpaseo/server -- vitest run src/server/agent/providers/pi/extensions/index.test.ts --maxWorkers=1 --bail=1`                                                                                              |
| Paseo out-of-band                                              | `npm exec --workspace=@getpaseo/server -- vitest run src/server/agent/providers/pi/agent.test.ts -t "out-of-band" --maxWorkers=1 --bail=1` (name the new tests with this phrase; validate the filter selects them)                |
| Paseo store                                                    | `npm exec --workspace=@getpaseo/server -- vitest run src/server/agent/provider-subagents/store.test.ts --maxWorkers=1 --bail=1`                                                                                                   |
| Protocol                                                       | `npm exec --workspace=@getpaseo/protocol -- vitest run tests/validation/ws-outbound.test.ts --bail=1` (add presentation, absent-field, unknown-value, and old-client unknown-key parsing cases to this existing suite)            |
| App BTW + track exclusion                                      | `npm exec --workspace=@getpaseo/app -- vitest run src/btw src/subagents/select.test.ts --project=unit --maxWorkers=1 --bail=1` (window-state, command encoding, ownership and selection; these files belong to this feature only) |
| i18n                                                           | `npx vitest run packages/app/src/i18n/resources.test.ts --bail=1`                                                                                                                                                                 |
| Daemon real-Pi (AC11, AC12, AC16, AC17)                        | `PASEO_PI_BTW_PACKAGE=~/dev/pi-btw npm exec --workspace=@getpaseo/server -- vitest run src/server/daemon-e2e/pi-btw.local.e2e.test.ts --maxWorkers=1 --bail=1`                                                                    |
| Pi workflow regression (host/registry change)                  | `npm exec --workspace=@getpaseo/server -- vitest run src/server/daemon-e2e/pi-workflow-subagents.local.e2e.test.ts --maxWorkers=1 --bail=1`                                                                                       |
| Pi workflow tree regression                                    | `npm run test:e2e:real --workspace=@getpaseo/app -- e2e/browser/pi-workflow-subagent-tree.real.spec.ts`                                                                                                                           |
| Deterministic BTW window/failure journey (AC13–AC17, AC21)     | `npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/pi-btw-window.spec.ts --workers=1`                                                                                                                                     |
| Live-provider BTW window journey (AC22)                        | `npm run test:e2e:real --workspace=@getpaseo/app -- e2e/browser/pi-btw-window.real.spec.ts --workers=1`                                                                                                                           |

### Scoped native smoke

Use the existing Agent Device runner, not the whole mobile suite. Once the device is connected to the same isolated fixture host and this checkout's Metro, run `agent-device test packages/app/e2e/mobile/agent-device/pi-btw.android.ad --metro-port "$PASEO_MOBILE_E2E_METRO_PORT" --timeout 120000 --fail-fast --artifacts-dir artifacts/pi-btw-native-android`; the iOS command substitutes `pi-btw.ios.ad` and `artifacts/pi-btw-native-ios`. Verify `agent-device test --help` on that host before the run. Record keyboard-visible composer bounds, sheet taps and Back/dismiss behavior. No device means an explicit unverified platform, not a pass.

### Implementation verification

The T2 implementation includes bridge, protocol, follower, command-routing and app tests, plus producer-backed daemon/browser journeys and native smoke scripts. Independent local checks and their current results belong in the task receipt under the run artifacts. Producer-backed execution waits for G1; test source or discovery does not establish a live-provider, browser, native or cache-measurement pass. Run the inventory above against the recorded producer revision and record platform gaps explicitly. The test inventory above is the implementation acceptance work.

### Repo gates

`npm run build:server`, `npm run typecheck`, `npm run lint`, `npm run format` before commit, `npm run format:check`. For targeted rewriting use `npm run format:files -- <changed paths>`; for targeted lint use `npm run lint -- <changed paths>`. Do not invoke formatter/linter binaries directly. `bash scripts/update-nix.sh --check` is needed only if Paseo dependencies change; none are planned. Never run full suites.

### Live cache measurement (AC18, evidence only)

Run `cd ~/dev/pi-btw && node scripts/measure-cache.mjs --out <runDir>/cache-report.md`. It uses the user's configured default provider and model.

1. Seed a parent session using a synthetic/public context fixture comfortably beyond the provider's documented minimum (20k tokens as a test target, not a universal minimum). Log physical model/provider/API and prompt/settings digests without recording credentials.
2. Ask BTW question 1 promptly; follow up without parent advancement; then finish another parent turn and ask again to measure auto-repin cost. Record time-to-first-token, elapsed time, raw provider usage availability and `input/cacheRead/cacheWrite` per request.
3. Compare against dbachelder/pi-btw **commit `374465f0a2bd3df502c4f981405e61567d92046b`** in a separate disposable agent directory, with equivalent parent context/model, and record order/timing. Never load both extensions with colliding commands. This observational comparison cannot establish causal routing equality by itself.
4. Record TTL/retention/account-routing facts when available; unknown counters are unknown, not zero hits. State H1–H4 as supported, rejected, or inconclusive; no invented percentage or speedup. Always provide provider failure evidence rather than an auth skip.

The script adds no auth checks; a provider failure is reported as-is.

### Isolated smoke recipe

1. Create a temp `PI_CODING_AGENT_DIR` with `settings.json` `packages: [<pi-btw checkout>]` and a stub `models.json`.
2. Start the stub server.
3. Run `pi --mode rpc` with that dir.
4. First finish parent turn A. Start and hold parent turn B; send RPC `prompt` with `/btw why?`. The BTW request must pin A, never unfinished B. Release B; the next BTW question must pin B. The extension starts no daemon or server; only the test harness starts the local HTTP stub.
5. Subscribe before sending: the test's inline host bridge listens on `pi-btw:thread`. Expect running→idle state and a child JSONL below `<agentDir>/btw/sessions/<parentSessionId>/`. On plain RPC, `/btw:status` emits a status notification; the host contract is pi.events, not terminal scraping.
6. In the browser journey, reuse `e2e/support/fixtures.ts` for Metro, worker-specific disposable daemon/home/port, throwaway project/workspace, and cleanup. Never point a fixture at 6767. Close/remove owned agents, workspaces and project records before removing temp directories. Preserve logs and screenshots in ignored worktree `artifacts/`.

### Coverage and visual evidence

Capture wide and compact screenshots of the window open, the minimized pill, the running state, the failed state, and the restored-after-restart state, all attached by the Playwright spec. Save `prefix-report.json` and `cache-report.md` in run artifacts.

### Platform matrix

| Platform                  | Evidence                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web (wide)                | Real-browser Playwright, wide viewport                                                                                                                                                                                                                                                                                                                                          |
| Web (compact)             | Real-browser Playwright, 390×844                                                                                                                                                                                                                                                                                                                                                |
| Electron desktop renderer | Web shares renderer code, but a Chromium run is not a real Electron-window run. Open the isolated browser journey in Desktop when available; otherwise report real Electron as untested.                                                                                                                                                                                        |
| iOS/Android               | Required smoke: open the sheet, type with the software keyboard visible, scroll/select text, tap chip show/hide, dismiss via Android Back/swipe, reopen while BTW runs, and verify safe-area/touch hit regions. Use Agent Device per `docs/mobile-testing.md`. If the worker has no device/runtime, report that platform gap; compact browser screenshots are not native proof. |

## 5. E2E journey

E2E runs once for the initial feature addition. Later pushes and deploys don't re-run it; the existing unit tests still apply.

**Standalone (pi-btw, TUI and RPC)**

- **E2E-S1.** `pi` with pi-btw; start a long main task; type `/btw what file defines X?`.
  - Expected: the overlay streams an answer while the main spinner continues, and the main task completes.
  - Evidence: asciinema/tmux capture, plus the RPC test log.
- **E2E-S2.** Ask a follow-up, then `/btw:inject focus on X`.
  - Expected: the main agent receives one user message after its current run.
  - Evidence: the parent transcript.
- **E2E-S3.** `/btw:abort` during a BTW answer.
  - Expected: BTW shows aborted and the main run is unaffected.
- **E2E-S4.** Restart `pi -c`; `/btw another?`.
  - Expected: the structured suffix and exact last pin are restored; `btw:status` reports resumable and the selected boundary. The next question auto-pins to the latest finished parent turn. Corrupting the stored snapshot produces `snapshot_unavailable`, never a silent rebase. A separate in-memory session visibly cannot resume.

**Paseo (isolated daemon, real Pi, real browser)**

- **E2E-P1 (wide).** Finish parent turn A in a real Pi session, then hold its next turn B running and type `/btw why?` in the main composer. The deterministic spec uses the local HTTP stub; repeat against the actual live provider in the real-provider spec.
  - Expected: the main turn keeps running and later completes. The BTW window opens docked bottom-right, shows the answer, and the subagents track has no BTW row.
  - Evidence: screenshots, daemon log with no turn replacement.
- **E2E-P2.** Click the chip while open, while hidden, and again while the BTW answer runs. Also use header Minimize.
  - Expected: each chip click toggles visibility both directions, with the same thread/request continuing and no duplicate rows. A running/completed state update does not reopen a hidden card.
- **E2E-P3.** Window follow-up, Stop, Summarize to main, and Send to main.
  - Expected: after parent B finishes, the follow-up automatically pins B and keeps the prior BTW suffix. Stop affects only BTW. The summary and explicit Send to main each deliver exactly one follow-up, and the main turn isn't interrupted. Closing/minimizing alone sends nothing.
- **E2E-P4 (compact, 390×844).** Repeat P1 and P3.
  - Expected: a compact sheet and bidirectional chip toggle; dismissal minimizes to the pill. Run the native software-keyboard smoke separately; browser viewport emulation does not prove IME placement.
  - Evidence: screenshots.
- **E2E-P5.** Restart the isolated daemon.
  - Expected: the Pi agent resumes and the pill and window show the existing thread with no duplicates.
- **E2E-P6 (failure).** The stub returns a 500 for the BTW request.
  - Expected: the window shows failed with the error, the next question succeeds, and the main agent is unaffected. Also, with pi-btw absent from settings, `/btw x` behaves as today and no window appears.
