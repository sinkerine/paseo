# Stable scrolling during generation

Design only. Branch: `feat/stable-scroll-streaming-desktop-android`; base:
`7a1dacf00f16af796db08d53215cf77fcad7c7df` (`refs/remotes/origin/main`).
Workspace: `wks_da41f59bef2b1438`.

Design decisions are finalized autonomously; human design input and design approval are not required.
**Ready for implementation:** the user explicitly instructed, "handoff again and let it start impl".
This authorizes the formal handoff and implementation to proceed despite the earlier G0 visible-tab
hold. Successful visible-tab opening is not claimed. G1, the separate Android tool-installation gate,
is still pending for the E2E phase. No software has been installed, feature code implemented, or
commit created during design.

## 1. Goal and acceptance criteria

Generation must leave the reader's viewport in place on desktop Electron and Android, including when
it starts exactly at the end. Output continues rendering below that position. Manual scrolling and
explicit navigation continue to work.

### Decisions and gate resolution

- **D1. Stable is the default.** Ruling: stop following output, including while resting at the end —
  this is the user's explicit definition — cost if wrong: readers who prefer following must scroll
  or tap **Scroll to bottom** again. No preference, experimental flag, or protocol capability gate.
- **D2. Explicit navigation lands once.** Ruling: initial route entry/reload, send, rewind, and
  **Scroll to bottom** retain their existing destination at the end, but stop following after that
  landing settles — preserves existing entry paths without introducing prompt repositioning or
  blank reply space — cost if wrong: a sent message's reply can grow below the fold until the reader
  moves. Send does not move the prompt to the top. An ordinary output event never starts a landing.
- **D3. Bounded landing lifecycle.** Ruling: reuse the current readiness and measurement guards;
  after the first eligible landing write, stop keeping the end after two consecutive painted-frame
  samples within 1 logical px of the end, or 60 eligible frames, whichever comes first — virtualized
  placement needs settling, while generation must not extend navigation indefinitely — cost if
  wrong: a very slow measurement can leave the landing slightly short, with the button available.
  Hidden/unmeasurable frames do not consume the budget. An explicit new request restarts it. A
  user scroll cancels the request, retries, and lifecycle immediately. A budget expiry also clears
  pending verification; subsequent content/layout events cannot revive that request.
- **D4. Gesture completion and completion of a turn do not enable following.** Ruling: reaching the
  end by wheel/keyboard/scrollbar/swipe/momentum, collapsing a disclosure back to the end, receiving
  a final answer, cancellation, or error all leave the viewport resting — otherwise D1 would be
  bypassed — cost if wrong: additional taps to catch up. Keep the equal-height turn-footer contract.
- **D5. Send entry paths.** Ruling: preserve `scrollToBottom("message-sent")` from Composer's
  `submitMessage` → `onMessageSent` → `AgentPanel.handleMessageSent` — this already covers ordinary
  Send/Enter, sending during a running turn, and Queue track **Send now** — cost if wrong: the jump
  can precede the optimistic prompt by one layout, as it can today. Bounded settling covers that
  layout. Automatic queued dispatch and remote/provider messages do not create new navigation
  intent. Existing error UI remains responsible for a failed send; failure never starts another jump.
- **D6. Retained returns.** Ruling: hiding/showing the same retained chat preserves its reading
  position, even if it was at the end when hidden — tab activation alone is not a request to chase
  output — cost if wrong: the reader has to request latest. A genuinely new route request still
  lands once. Do not change route definitions, restore logic, or active workspace selection.
- **D7. Underfilled transcripts.** Ruling: Android starts short content at the top, matching web,
  by removing native `alignItemsAtEnd` — bottom alignment itself moves visible text while the
  scroll offset is zero — cost if wrong: short transcripts occupy the top instead of the bottom.
  Verify empty → short → overflowing output, not only long history. Keep native `initialScrollAtEnd`
  for initial overflowing history placement; the existing LegendList patch prevents it rearming on
  each data change.
- **D8. Layout changes.** Ruling: preserve the existing reading-row anchors for history prepends,
  virtualization, delayed measurement, and live-head → history handoff — a fixed numeric offset
  alone is insufficient when content above the reader changes — cost if wrong: work remains in
  the platform strategies. User-caused viewport resizing/keyboard motion may reposition the view;
  after it settles, subsequent generation must not move it. Normal content-bound clamping after a
  collapse/rewind is allowed. No new resize-to-end behavior or permanent blank spacer.
- **D9. Button meaning.** Ruling: outside a landing, show the existing **Scroll to bottom** control
  whenever the end is more than 1 logical px below the viewport, or the timeline has newer unloaded
  history — this is the recovery action once following is gone — cost if wrong: slight threshold
  flicker, covered by subpixel tests. During a landing keep the existing wider threshold to avoid
  flashing. Tail fetch errors retain the existing visible history-load error and retry action.
- **D10. Platform boundaries.** Ruling: modify both `strategy-web.tsx` (Electron and browser, wide
  and compact) and `strategy-native.tsx` (Android and shared iOS) — removing the JS web scroll alone
  leaves native's UI-thread end pin following — cost if wrong: shared iOS behavior also changes.
  iOS simulator evidence is unavailable on this Linux host and must be reported as untested.
  Native Kotlin/Swift scroll subclasses and dependency patches retain their clamp/disclosure fixes.
- **D11. Scope.** Ruling: app-local scroll policy; no server/provider/protocol changes — output
  delivery and paced reveal already work independently of position — cost if wrong: none expected.
  Existing protocol/capability compatibility is checked through builds/typecheck; do not introduce
  optional wire fields or compatibility shims for a client viewport behavior.
- **D12. Approval resolution.** Ruling: no human design decision is required — the at-bottom case
  is explicit and D2–D11 are reversible implementation/product choices with stated costs — cost if
  wrong: revise this plan before implementation. The user subsequently authorized progression with
  "handoff again and let it start impl"; this is explicit permission to hand off and begin
  implementation, not a claim that the user reviewed each design detail.
  **G0 resolved by explicit user override:** the earlier visible-tab prerequisite no longer blocks
  `PLAN_READY` or implementation. The failed open remains recorded as `Paseo desktop app not found`;
  read-only inspection shows Nix Desktop running via `~/.nix-profile/bin/paseo-desktop`, whereas CLI
  Linux lookup checks only `/usr/bin/Paseo`, `/opt/Paseo/Paseo`, and `~/Applications/Paseo.AppImage`.
  Successful visible-tab opening is not claimed. No Desktop installation, daemon change, or
  replacement session is authorized or needed for this handoff.
  **G1** is the workflow approval for software installs and effects outside this worktree. At E2E
  setup, present the concrete missing emulator/image/SDK packages and local Agent Device install
  below to the orchestrator. Until G1 resolves, do not install or accept SDK licenses. A missing
  Nix dev-shell dependency or Electron download is also an install under G1; inspect first and
  reuse existing store/browser binaries where available. A design handoff does not imply G1 approval.

### Observable criteria and evidence

Each criterion below is required. Evidence IDs refer to §4 and §5. Numeric stability assertions
exclude frames in an explicit landing, a user gesture, or a documented layout change. Re-baseline
immediately after those operations finish; do not wait for generation to finish before measuring.

| ID       | Observable behavior                                                                                                                                                                                                                           | Exact evidence                                                                                                                                                                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AC1**  | An overflowing chat resting exactly at the end stays at the same offset and keeps the same visible text position as output grows by at least 300 logical px over at least 5 seconds.                                                          | U1 landing lifecycle tests; B1 real-browser geometry test; E1/desktop J2; E2/real Electron J2; E3/Android A3.                                                                                                                                                                                   |
| **AC2**  | Reading earlier history during generation stays anchored as output grows below: fixed visible message/paragraph y, not just a constant list offset.                                                                                           | U2 `reading-anchor.test.ts`; B1 detached-growth test; E1/E2 J3 and E3 A4.                                                                                                                                                                                                                       |
| **AC3**  | Manual wheel, scrollbar drag, PageUp/End, and Android swipe/momentum move the view; reaching the end does not restart following.                                                                                                              | U1 user-scroll cases; E1 J4 (all desktop inputs), E2 J4 (wheel), E3 A5 (swipe/momentum).                                                                                                                                                                                                        |
| **AC4**  | Clicking **Scroll to bottom** during generation reaches the current end once, hides the button at the end, and later output leaves the view stable with the button available again.                                                           | B1 explicit-handle test; E1/E2 J5; E3 A6. Tail-not-loaded variant: E1 `chat-outline.spec.ts` "indexes unloaded prompts and jumps with one bounded merged page", extended to assert stability after return; failure: U2 `timeline-tail-navigation.test.ts` and E1 existing timeline retry cases. |
| **AC5**  | Send/Enter while idle, sending while running (steer/interrupt setting), and Queue track **Send now** each retain the one-shot end destination; generation after each landing does not move the view.                                          | E1 J6, parameterized by entry path/send setting; E2 J6 idle Send; E3 A7 idle Send and running Send. The bounded settlement includes optimistic/canonical prompt reconciliation.                                                                                                                 |
| **AC6**  | Opening a long chat and reloading during generation each land once at the end after authoritative readiness; a user scroll supersedes a delayed request.                                                                                      | U1 readiness/cancellation/budget tests; B1 initial-entry tests; E1 J1/J8; E3 A1/A9.                                                                                                                                                                                                             |
| **AC7**  | Returning to the same retained chat preserves the reading position, including when left at the end while output arrived in the background.                                                                                                    | E1/E2 J8; E3 A9. Snapshot before leaving and first visible frames on return; no return-to-end jump.                                                                                                                                                                                             |
| **AC8**  | Completing, cancelling, or failing a turn never starts following or forces a jump. The live message remains anchored through its history handoff and final reveal.                                                                            | B1 live-to-history test; E1 J7 with short/long replies and scrolled-up/end positions; E3 A8 completion and cancellation. Record first post-boundary frames.                                                                                                                                     |
| **AC9**  | An empty/underfilled chat stays top aligned as the first output arrives and crosses into overflow, with no alignment shift.                                                                                                                   | B1 short-content test; E1 J9; E3 A2. Android screenshots prove row position, since offset zero alone cannot detect bottom-alignment movement.                                                                                                                                                   |
| **AC10** | Disclosures preserve their tapped edge, then remain resting even when collapse reaches the end.                                                                                                                                               | U1 release tests; B1 disclosure cases; E1 existing `turn-collapse.spec.ts` affected cases; E3 A10 short user-message Show more/less. Native last-row bottom-edge end holds must not continue following a subsequently arriving reply.                                                           |
| **AC11** | Loading older history, a virtualized-window transition, and delayed height changes above the reader preserve the visible reading anchor. After composer growth, keyboard open/close, or viewport resize settles, subsequent output is stable. | U2 reading-anchor and history-start suites; B1 virtual/size cases; E1 J10 and existing timeline-scroll traversal; E3 A10 keyboard and older history. Native module clamp regression N1.                                                                                                         |
| **AC12** | Real Linux Electron and a real Android native app execute the relevant journeys through an isolated daemon, with inspectable measurements and screenshots.                                                                                    | E2/E3, platform matrix and logs (§4). Compact browser emulation is not Android evidence.                                                                                                                                                                                                        |
| **AC13** | Targeted unit/browser checks, applicable builds, lint, typecheck, formatting, and dependency hash check pass; stream position work does not introduce per-token render work for history.                                                      | C1–C5, U1/U2, B1, N1; P1 before/after hot-path and frame samples. No full suites locally.                                                                                                                                                                                                       |
| **AC14** | Documentation explains the new ownership and repeatable resource-bounded Android setup without adding future push/deploy E2E requirements.                                                                                                    | DOC1–DOC4, review the documented commands against the E3 run.                                                                                                                                                                                                                                   |

Stability thresholds: web/Electron max anchor drift ≤1 CSS px, recorded each animation frame;
Android ≤2 device px between samples, with screenshot/video checks for intermediate jumps. Growth
is proven by changed rendered response text and growing content/row bounds, not a server-only event.
For prepends, offset may change to keep the anchor y fixed. For pure tail growth, both remain fixed.

## 2. Design

### Existing ownership and data flow

Read sources before implementation: `bottom-anchor-controller.ts`, `strategy-web.tsx`,
`strategy-native.tsx`, `native-end-pin.tsx`, `reading-anchor.ts`, `native-disclosure-hold.ts`,
`strategy.ts`, `view.tsx`, and `panels/agent-panel.tsx` under `packages/app/src/`.

```
provider → daemon coalescer → timeline reducer queue → paced reveal → rendered row height
                                                             ↓
web: reading-anchor reconciliation          native: LegendList visible-row MVCP
     (no permanent followOutput)                     (no permanent end pin)

route entry / composer send / rewind / Scroll to bottom
  → existing StreamViewportHandle.scrollToBottom(reason)
  → guarded landing at end → bounded settlement → resting
```

Web currently has its own `followOutput` state; it does not use the native bottom-anchor hook.
Layout effects, MutationObserver, and ResizeObserver all call the web follow path. Native mounts
`EndPinnedScrollView`'s zero-height `paseo-end-pin` while the controller is sticky. React Native holds
that pin on the UI thread. LegendList MVCP takes over when detached. Both owners must transition.

### Boundaries and exact interfaces

Add one small pure `packages/app/src/agent-stream/end-landing.ts` shared by the two actual platform
adapters. It decides when a requested landing ends, not where rows render or how to scroll.

```ts
export interface EndLandingGeometry {
  ready: boolean;
  atEnd: boolean;
}
export interface EndLandingPorts {
  read(): EndLandingGeometry;
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
  onSettled(): void;
}
export interface EndLanding {
  start(): void;
  cancel(): void;
  isActive(): boolean;
}
export function createEndLanding(ports: EndLandingPorts): EndLanding;
```

`start` cancels the previous frame, resets counts, and schedules one frame at a time. A `ready`
sample increments the 60-frame budget and either increments the at-end streak or resets it. Two
at-end samples or budget expiry finish the lifecycle before invoking `onSettled` once. `cancel`
cancels frames and finishes without invoking `onSettled`. Both are safe during unmount. Only call
`start` from a navigation request/first eligible attempt; content size changes never restart it.
Injected scheduler/geometry make U1 deterministic without React mounting or patched globals.

Preserve these existing public shapes:

```ts
export type BottomAnchorMode = "sticky-bottom" | "detached";
export interface BottomAnchorRouteRequest {
  reason: "initial-entry" | "resume";
  agentId: string;
  requestKey: string;
}
export interface BottomAnchorLocalRequest {
  reason: "jump-to-bottom" | "message-sent" | "rewind";
  agentId: string;
}
// Existing StreamViewportHandle, unchanged signature:
scrollToBottom(reason?: BottomAnchorLocalRequest["reason"]): void;
holdRow(rowId: string, apply: () => void, triggerEdge: DisclosureTriggerEdge): void;
prepareForViewportChange(): void;
```

Native controller driver gains `settleLanding(): void`, exposed by `useBottomAnchorController`.
It clears attempts, pending verification/request, blocked reason, and transitions to `detached`.
`sticky-bottom` now means only an active explicit landing. Begin with `detached`; the initial
LegendList placement remains its existing owner. Add these exact required ports to
`CreateBottomAnchorControllerDriverInput`:

```ts
onLandingAttempt(): void;
onLandingCancelled(): void;
```

Invoke `onLandingAttempt` once on the first eligible `runAttempt` for a new request, before
`scrollToBottom`. Invoke `onLandingCancelled` when a new request supersedes an old one, user intent
or a disclosure cancels a request, `settleLanding` clears it, or the driver is destroyed. The hook
adapter wires them to `EndLanding.start`/`cancel`, so no mode-synchronizing effect is needed.
Add `isActive: boolean` to `useBottomAnchorController`'s input; native passes its existing retained
panel activity. Its lifecycle `read` uses that activity, existing positive current-key geometry,
authoritative readiness, and distance from end ≤1 px. `onSettled` calls `driver.settleLanding`.
Keep the scheduler injectable in the driver test harness; hook adapter owns the native frame
implementation.

If avoiding a circular hook closure, supply the driver's completion callback to the lifecycle when
the driver is created through the existing driver ref. Do not use an effect chain to synchronize
mode into another set of React state.

Test adapter signatures (new harness modules only):

```ts
// packages/desktop/e2e/agent-stable-scroll.electron.mjs (JSDoc types in .mjs)
export interface StableScrollDesktopInput {
  page: import("@playwright/test").Page;
  daemonPort: number;
  serverId: string;
  artifactDir: string;
}
export interface StableScrollDesktopReport {
  steps: readonly StableScrollStepResult[];
}
export interface StableScrollStepResult {
  name: string;
  maxAnchorDriftPx: number;
  maxOffsetDriftPx: number;
  renderedGrowthPx: number;
  evidencePath: string;
}
export function runStableScrollRegression(
  input: StableScrollDesktopInput,
): Promise<StableScrollDesktopReport>;
```

Electron runner calls the module after its existing desktop startup/host readiness, using the
isolated daemon and selected server ID, before unrelated settings/browser scenarios when the
stable-scroll selection is set. The module seeds its own agents and cleans its projects in `finally`.
The Android `.mjs` is a direct CLI entrypoint consuming the explicitly named environment in E3;
its output is JSON samples and per-step results, and any failed assertion makes the process exit
nonzero. No feature RPC or production diagnostics interface is introduced.

### Web adapter

In `strategy-web.tsx`:

1. Treat `followOutput` only as active landing ownership. Preserve current readiness/activation-key
   handling. Start bounded settlement at the first measurable `scrollMessagesToBottom` for that
   request. On settle, cancel scheduled sticks and set following false before another observer
   can write an offset. Capture the reading anchor from committed geometry at that handoff.
2. Remove reattachment in `handleDomScroll` when a downward movement reaches the end, and in
   `reconcileReadingPosition` when a disclosure collapses to the end. Scroll events update the
   reading anchor and button geometry; they cannot create navigation intent.
3. Cancel the current request on actual viewport user intent. Retain nested scroller/editable-field
   checks: a wheel in a tool details scroller or PageUp inside an input must not alter outer scroll
   ownership. Include downward viewport intent during a landing, not only upward movement.
4. Keep `ResizeObserver`/layout reading reconciliation while resting, including reveal inside a
   message that does not rerender its parent. Remove MutationObserver's permanent force-follow;
   during an active landing it may still finish the requested navigation. Set `overflowAnchor`
   to `none` while resting to keep one correction owner.
5. Preserve retained geometry without treating `isActive` toggles as new landing requests. On
   hide, cancel the lifecycle/pending sticks and release following; returning does not restart
   them. Suspend measurements while hidden/non-positive; do not record zero-height geometry.
6. Publish button availability at the 1 px end threshold while resting, and the wider existing
   threshold only during navigation. No new button, label, setting, or store-wide subscription.

### Native adapter

In `bottom-anchor-controller.ts` and `strategy-native.tsx`:

1. Wire `onLandingAttempt`, bounded settlement, and cancellation. Request readiness/retries stay
   until success or lifecycle expiry, not forever. Retained-panel hide releases the landing and
   cancels its frame loop; returning alone cannot restart it. A drag cancels blocked requests too;
   ending a drag/momentum at the end remains detached. `releaseDisclosure` clears a hold without
   re-sticking.
2. `isEndPinned` includes only an active explicit landing or the existing transient bottom-edge
   disclosure hold. Ordinary growth and turn lifecycle events never mount the pin. Preserve the
   native synchronous clamp and gesture protections; no Kotlin/Swift edits are planned.
3. While resting, keep LegendList `{ data: true, size: true, shouldRestorePosition }` and the
   current patched anchor-lock behavior. Keep `maintainScrollAtEnd` disabled. Remove
   `alignItemsAtEnd` so short content does not translate upward on every size change.
4. Keep the last-row bottom-edge disclosure's delayed apply and pin sequence. A newly arriving
   row below that anchor already drops the end hold in the same commit. Ensure release does not
   invoke any landing; drag cancels the hold. Verify with A10, not just JS mocks.
5. A keyboard translates the list/composer on the UI thread; preserve that contract. Do not add a
   keyboard-sized inset or resize-to-end shortcut. Retain native jump animation policy, cancelling
   it on user gesture. The 60-frame settlement bound applies after the first eligible attempt;
   B1/U1 test a long animated jump so its end remains reachable before settling.

No source in the daemon, protocol, reveal pipeline, Markdown renderer, or presentation projection
needs changing. Tests must still exercise final reveal and live/history row identity transitions.

### Errors and conventions

Use existing measurable-geometry/readiness guards. A blocked initial request waits for history;
user intent cancels it. A failed/exhausted landing releases ownership and leaves the existing button
usable rather than creating an unbounded content-driven retry loop. Tail-return fetch errors retain
`returnToTimelineTail`'s visible error callback. Don't swallow errors or add retry flags. No provider
auth checks, mocked transport, new npm jobs, or manual dependency patches.

Use pure injected ports for new unit coverage. `strategy-web.test.tsx` is legacy JSDOM with mocks;
rewrite obsolete expectations only, and place new rendered-geometry cases in the existing real
browser suite (`strategy-web.browser.test.tsx`). Do not add new JSDOM/RN renderer tests.

### Required documentation

- **DOC1:** Integrate D1–D9 into `docs/agent-stream-disclosure.md`: rewrite "Following output",
  "Who owns the offset", and "User scroll" to distinguish transient navigation from resting
  reading. Keep the disclosure/keyboard constraints, end-hold exception, and native-clamp guidance.
  Update adjacent strategy and `StreamViewportHandle` comments. One subject owner, no new doc.
- **DOC2:** Integrate the verified isolated setup/resource settings into `docs/android.md`'s
  local prerequisites/build/emulator sections. Link to the mobile journey; don't duplicate it.
- **DOC3:** Add the targeted Android journey command, required connected disposable daemon, ports,
  evidence path, and cleanup to `docs/mobile-testing.md`. Describe debug-native evidence and its
  limits; browser compact mode is not a native substitute.
- **DOC4:** In `docs/testing.md`'s existing desktop regression description, document the targeted
  stable-scroll selection in its existing real-Electron runner and link to DOC1. No push/deploy
  E2E requirements in `AGENTS.md`/`CLAUDE.md` or anywhere else.

## 3. Tasks

### T1 — Complete stable scrolling, wiring, tests, and documentation

Single task, one writer. Dependencies: G0 resolved by explicit user authorization to proceed;
G1 remains required before Android provisioning.
No split: controller, both viewports, and tests change one small interaction contract and share the
same files/build outputs. No additional task is justified by a separate producer or parallel gain.

Owned files:

- New `packages/app/src/agent-stream/end-landing.ts` and `.test.ts`.
- Existing `bottom-anchor-controller.ts`/`.test.ts`, `strategy-web.tsx`, `strategy-native.tsx`,
  `strategy.ts`, `strategy-web.browser.test.tsx`, and obsolete assertions in `strategy-web.test.tsx`
  under `packages/app/src/agent-stream/`. Change `native-disclosure-hold.ts`/`.test.ts` only if
  A10 exposes a hold that does not release; keep its tested delayed-apply contract.
- Existing browser E2E suites `agent-stream-ui.spec.ts`, `agent-scroll-return.spec.ts`, and
  `agent-timeline-scroll-smoothness.spec.ts`, plus affected cases in `turn-collapse.spec.ts`,
  `agent-message-rewind.spec.ts`, `chat-outline.spec.ts`, and `agent-message-submission.spec.ts` under
  `packages/app/e2e/browser/`. Add feature cases to these existing suites instead of a new npm job.
- Existing `packages/app/e2e/support/helpers/agent-bottom-anchor.ts`, `agent-stream.ts`, and
  `timeline-scroll-smoothness.ts`. Replace
  `expectScrollFollowsNewContent` with two-sided stable-viewport evidence. Replace the obsolete
  `maxFollowGap` assertion with measured drift while output grows, preserving its paragraph test.
- New `packages/desktop/e2e/agent-stable-scroll.electron.mjs` called by existing
  `browser-tabs.e2e.mjs`; add `PASEO_DESKTOP_STABLE_SCROLL_ONLY=1` selection like existing `*_ONLY`
  selections. CI's existing `test:e2e:browser-tabs` job still runs it unconditionally in the full
  runner. This selector controls a test subset, not feature availability.
- New `packages/app/e2e/mobile/stable-scroll/android.mjs`: Agent Device plus real disposable
  daemon and sample/evidence collection, matching existing Android mobile harness conventions.
- DOC1–DOC4.

Consumed interfaces: existing `StreamViewportHandle`, route/local request types, native MVCP and
end-pin wrapper, `seedMockAgentWorkspace({ port, model, repo })`, existing browser/Electron harnesses,
and mock provider `one-minute-stream`/`bursty-stream`/`e2e-fast-stream` models. Produced interfaces:
`EndLanding*`, `createEndLanding`, driver `settleLanding`/`onLandingAttempt`/`onLandingCancelled`,
plus the exact desktop test adapter in §2.

Exact unit command U1 (from `packages/app`):

```bash
npx vitest run src/agent-stream/end-landing.test.ts \
  src/agent-stream/bottom-anchor-controller.test.ts src/agent-stream/strategy-web.test.tsx \
  --project=unit --maxWorkers=1 --bail=1
```

Waves: implementation with vertical RED→GREEN slices → one consolidated review → targeted E2E
including repairs. No early review needed: platform ownership is known and concrete tests cover the
boundary. Correct any consequential new uncertainty through a focused review before expanding
scope. Review checks that resting never reattaches, budget expiry cannot revive, input cancels,
and both Android owners (pin and underfill alignment) are addressed.

Conflicts: one writer owns both strategies; no parallel Gradle, Metro/Playwright, Electron, or
emulator runs. Generated `packages/app/android`, workspace `dist` outputs, Metro cache, AVD state,
and isolated homes each have one process owner. See §4 for serialization.

## 4. Test and verification

### 4.1 Host inspection and prerequisites

Inspected read-only on 2026-11-11; recheck before resource-intensive steps:

| Capability             | Observation                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host                   | NixOS 26.11, x86_64, 32 logical CPUs, ~60 GiB RAM, ~30 GiB available at inspection, **no swap**, ~239 GiB disk free.                                                                                                                                                                                                        |
| Acceleration           | `/dev/kvm` exists and is accessible; actual emulator `-accel-check` still required.                                                                                                                                                                                                                                         |
| Tools in current PATH  | node/npm, nix, direnv, taskset, flock, systemd-run, steam-run. No java/adb/emulator/sdkmanager/avdmanager/agent-device/maestro/mise.                                                                                                                                                                                        |
| Existing store tools   | JDK 21 `/nix/store/p3ckxs1gmqir4m2b6yknbbka33da1y4m-openjdk-21.0.12.1+1`; partial SDK `/nix/store/rx2gmv09cbbmvhjg60f8ap8jl1cll8cm-android-sdk-env/share/android-sdk`, with command-line tools, build tools 35/36/37, platforms 34/37 and NDK 27.2. No emulator or system image there; it is not the required complete SDK. |
| Required app toolchain | Installed RN 0.86.3 catalog: compile/target SDK 36, build tools 36.0.0, NDK 27.1.12297006. App config: min SDK 29, Kotlin 2.1.20, development package `sh.paseo.debug`. Docs pin JDK 21. Generated Gradle wrapper is authoritative.                                                                                         |
| Browsers               | Playwright 1.58.2 Chromium revision 1208 is cached. `nix develop` supplies browser libraries and xvfb-run. Electron npm package is 44.2.0; its binary is absent. Installed Desktop runs Nix Electron 43.8.3.                                                                                                                |
| Shared processes       | Main Paseo daemon on 6767, shared ADB on 5037, another project's Gradle (~2.2 GiB) and Kotlin (~1.2 GiB). Never stop these. Existing `~/.android/avd/element_x_thread_drawer` belongs to another project.                                                                                                                   |

No installation, emulator boot, or build was performed during design. Every resource limit below
is a recommendation, not a successful setting. Recheck actual tool help, available RAM, CPU affinity,
ports, and SDK compatibility at G1; record any changed setting in this plan.

Design-phase checks already run: `npm run lint` passed (0 warnings/errors on 5,418 files), and
`npm run typecheck` passed all workspaces. The latter exercised the protocol validator-generation
hook. Formatting used `npm run format:files -- docs/features/stable-scroll-plan.md`. These check the
current checkout and the plan only; no feature tests, native build, or E2E outcome is claimed.

### 4.2 Commands and inventory

Run from the repo root except where `cd` is shown. Create ignored `artifacts/stable-scroll/logs`
and a worktree-local temporary directory before running commands. Set `TMPDIR`/`TMP`/`TEMP` to that
directory so harness temp repositories and homes remain inside the worktree. Long output goes to
logs; inspect exit status and read the logs. Do not run full local suites or add feature npm jobs.

- **C1 format:** `npm run format:files -- docs/features/stable-scroll-plan.md` for this design
  deliverable. After implementation, use `npm run format` then `npm run format:check`. Actual scripts
  use oxfmt despite older AGENTS.md prose naming Biome; invoke npm scripts only.
- **C2 lint:** `npm run lint` after the change; use `npm run lint -- <changed code files>` for
  focused fixes. New `.mjs` harnesses are code files too.
- **C3 build and typecheck:** `npm run build:client` before diagnosing declarations; then
  `npm run typecheck`. The protocol package's `prebuild` and `pretypecheck` hooks run
  `generate:validators` (`scripts/generate-validation-aot.mjs`); retain its generated
  `src/generated/validation/ws-outbound.aot.ts` as an existing build input and do not hand-edit it.
  If server/client declarations or isolated daemon startup are stale, run
  `npm run build:server` before changing consumers. Real Electron needs its existing
  `npm run build:main --workspace=@getpaseo/desktop` (already run by its runner script).
- **C4 cross-package compatibility:** no wire changes. Root typecheck covers existing app/client/
  server/desktop signatures; daemon smoke uses the checkout's source and built workspace inputs.
  No fabricated version-capability gates. Record daemon/app/Electron/Android binary revisions.
- **C5 hash/diff:** `bash scripts/update-nix.sh --check`, `git diff --check`; no lockfile hash changes
  expected. Add no AGENTS.md push/deploy checks.
- **U1** exact task command above; test ready/stale geometry, request restart, two-frame settlement,
  60-frame expiry under ongoing growth, hidden frames, gesture cancellation before/after readiness,
  late verifier callbacks, resize/content updates after settlement, and no re-stick on end/release.
- **U2** existing adjacent pure tests, one targeted invocation from `packages/app`:

  ```bash
  npx vitest run src/agent-stream/reading-anchor.test.ts \
    src/agent-stream/native-disclosure-hold.test.ts src/agent-stream/render-strategy.test.ts \
    src/agent-stream/history-start-pagination.test.ts src/agent-stream/timeline-tail-navigation.test.ts \
    src/agent-stream/native-scroll-animation.test.ts --project=unit --maxWorkers=1 --bail=1
  ```

- **B1** real browser geometry via existing Vitest browser project (Chromium; real React DOM,
  native LegendList web adapter tests do not count as Android evidence):

  ```bash
  cd packages/app
  npx vitest run src/agent-stream/strategy-web.browser.test.tsx \
    src/agent-stream/disclosure.browser.test.tsx \
    src/agent-stream/legend-list-held-row.browser.test.tsx --project=browser --maxWorkers=1 --bail=1
  ```

  Run in `nix develop`; project discovery is `packages/app/vitest.config.ts`, whose projects are
  `unit` and `browser`. The browser project owns its websocket global setup. New tests use real
  layout, not JSDOM. Account for subpixel rounding and hidden retained measurements.

- **E1** existing isolated app Playwright harness:

  ```bash
  nix develop --command npm run test:e2e --workspace=@getpaseo/app -- \
    e2e/browser/agent-stream-ui.spec.ts e2e/browser/agent-scroll-return.spec.ts \
    e2e/browser/agent-timeline-scroll-smoothness.spec.ts e2e/browser/agent-message-rewind.spec.ts \
    e2e/browser/turn-collapse.spec.ts --project=browser --workers=1
  ```

  Put the new send variants in a `stable scrolling send` describe block in
  `agent-message-submission.spec.ts`, so their exact targeted command is:

  ```bash
  nix develop --command npm run test:e2e --workspace=@getpaseo/app -- \
    e2e/browser/agent-message-submission.spec.ts --project=browser --workers=1 \
    --grep 'stable scrolling send|keeps layout stable when submitting to an agent with existing history|keeps the submitted row stable through draft create handoff'
  ```

  Adjacent tail-return, history-prepend, failure/retry, and navigation checks:

  ```bash
  nix develop --command npm run test:e2e --workspace=@getpaseo/app -- \
    e2e/browser/agent-timeline-pagination.spec.ts e2e/browser/agent-timeline-sync-retry.spec.ts \
    e2e/browser/chat-find.spec.ts e2e/browser/chat-outline.spec.ts \
    --project=browser --workers=1 \
    --grep 'keeps visible history anchored when live output grows during a prepend|keeps the history-start gutter and visible position stable through the final page|a refused catch-up offers a retry that reports pending, failure, and recovery|a refused first load offers a retry instead of a dead panel|keeps keyboard scrolling the chat after closing Find|counts every occurrence of a virtualized message and steps between them|indexes unloaded prompts and jumps with one bounded merged page|keeps the prompt marked while reading split Markdown blocks and after completion'
  ```

  Discovery: `packages/app/playwright.config.ts`, `browser` project. Run each command above with
  `--list` appended before execution and confirm each required title/parameterized variant is
  discovered; an empty grep result is a failed setup, not a skipped check. Global setup
  prewarms Metro; per-worker fixtures own disposable homes, daemon ports, and project cleanup.
  Preserve cleanup calls, not just deletion of temp directories. New numeric cases run at both
  desktop wide (1280×800) and compact web (390×844) through parameterized tests in the same suites.

- **E2** real Electron, using the existing runner rather than the Chromium desktop-bridge fixture:

  ```bash
  PASEO_DESKTOP_STABLE_SCROLL_ONLY=1 \
  PASEO_DESKTOP_BROWSER_E2E_ARTIFACT_DIR="$PWD/artifacts/stable-scroll/electron" \
  ELECTRON_OVERRIDE_DIST_PATH=/nix/store/ymncbmjz7cmphkxxgl4yan6mrwfvxgsl-electron-unwrapped-43.8.3/libexec/electron \
    nix develop --command npm run test:e2e:browser-tabs --workspace=@getpaseo/desktop
  ```

  That store binary was verified present and GC-rooted; re-resolve if it disappears. This is an
  installed 43.8.3 runtime exercising the current renderer; report the difference from repo Electron
  44.2.0. If 44.2.0 is required, provision under G1 rather than allowing `require("electron")` to
  auto-download it. The runner owns disposable PASEO_HOME, user data, Metro, daemon and CDP ports,
  xvfb-run, and teardown. Existing CI `desktop-tests` executes the complete runner on the PR.

- **P1 performance:** before and after, record the same targeted
  `cd packages/app && npx vitest bench --project unit src/agent-stream/stream-tick.bench.ts` and
  `nix develop --command npm run test:e2e:stream-smoothness --workspace=@getpaseo/app`.
  Compare matched mock/provider/settings, not historical real-Haiku numbers to mock numbers.
  Evidence: per-delta cost, frame gaps, chars-per-frame CV, history row rerenders and viewport drift.
  No new per-token state subscription/measurement loop beyond existing viewport observers.
- **N1 native regression:** after Android prebuild, retain the existing clamp instrumentation:
  `cd packages/app/android && ./gradlew :paseo-scroll:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=sh.paseo.scroll.VisibleContentPositionClampTest -PreactNativeArchitectures=x86_64 -Pandroid.cmakeVersion=3.30.5 -Pkotlin.compiler.execution.strategy=in-process -I "$E2E/native-memory.gradle" --no-daemon --max-workers=1 -Dorg.gradle.parallel=false`
  on the isolated serial below, after building test APKs with the emulator stopped. The connected
  task should reuse those outputs; if it needs substantial recompilation, stop the owned emulator,
  compile with §4.3's build cap, then reboot it and rerun this targeted connected test.
  The app's `test:android` npm script covers other native modules, not this scroll module; no need
  to run that unrelated module set for an unchanged native implementation. If a native source
  repair becomes necessary, run its exact existing unit/instrumentation target too and rebuild APK.

### 4.3 Android environment setup (E3, after G1)

All commands are a recipe for the E2E phase, not proof they ran. Use one shell at repo root and keep
`REPO_ROOT`/`E2E` absolute. Configure local npm/Gradle/Android state. G1 covers tool installation,
license acceptance and any Nix/SDK dependencies required by the setup; no global installs.

1. **Allocate isolated paths and ports.** Use daemon 6793, Metro 8093, ADB 5047, emulator console/ADB
   5580/5581 (`emulator-5580`). Check each is free with `ss -ltn`; if busy choose a new coherent set
   and record it, never stop the owner. Export:

   ```bash
   export REPO_ROOT="$PWD" E2E="$PWD/.dev/android-e2e"
   export SDK_SOURCE=/nix/store/rx2gmv09cbbmvhjg60f8ap8jl1cll8cm-android-sdk-env/share/android-sdk
   mkdir -p "$E2E"/{sdk,avd,android-user,gradle-home,tools,tmp,logs,evidence}
   export ANDROID_HOME="$E2E/sdk" ANDROID_SDK_ROOT="$E2E/sdk"
   export ANDROID_AVD_HOME="$E2E/avd" ANDROID_USER_HOME="$E2E/android-user"
   export ANDROID_EMULATOR_HOME="$E2E/android-user"
   export ANDROID_ADB_SERVER_PORT=5047 ADB_SERVER_SOCKET=tcp:localhost:5047
   export ANDROID_SERIAL=emulator-5580 GRADLE_USER_HOME="$E2E/gradle-home"
   export AGENT_DEVICE_STATE_DIR="$E2E/agent-device" npm_config_cache="$E2E/npm-cache"
   export TMPDIR="$E2E/tmp" TMP="$E2E/tmp" TEMP="$E2E/tmp"
   export JAVA_HOME=/nix/store/p3ckxs1gmqir4m2b6yknbbka33da1y4m-openjdk-21.0.12.1+1/lib/openjdk
   export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$E2E/tools/node_modules/.bin:$PATH"
   ```

   Save these exact exports to `$E2E/env.sh` for every later shell. Do not repurpose HOME or write
   shared `~/.gradle`/`~/.android`. Do not run `adb kill-server` against default 5037.

2. **Provision missing SDK/image/tooling.** Reuse the inspected read-only command-line tools from
   `$SDK_SOURCE=/nix/store/rx2gmv09cbbmvhjg60f8ap8jl1cll8cm-android-sdk-env/share/android-sdk`:
   prefix each SDK-manager call with its actual `cmdline-tools/latest/bin/` path and pass
   `--sdk_root="$ANDROID_HOME"`. Under G1 accept licenses and install:

   ```bash
   export SDK_SOURCE=/nix/store/rx2gmv09cbbmvhjg60f8ap8jl1cll8cm-android-sdk-env/share/android-sdk
   "$SDK_SOURCE/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" --licenses
   "$SDK_SOURCE/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" \
     'cmdline-tools;latest' 'platform-tools' 'emulator' 'platforms;android-36' 'build-tools;36.0.0' \
     'ndk;27.1.12297006' 'cmake;3.30.5' 'system-images;android-35;google_apis;x86_64'
   ```

   RN's installed `ReactAndroid/build.gradle.kts` names CMake 3.30.5. Pin the local build with
   `-Pandroid.cmakeVersion=3.30.5`, supported by Expo's installed root-project plugin, so library
   subprojects do not silently request a second default CMake. Confirm the generated project and
   SDK manager support it before building.

   The read-only Nix bootstrap wrapper injects its own tools directory. Once installation completes,
   use `$ANDROID_HOME/cmdline-tools/latest/bin/{sdkmanager,avdmanager}` from the isolated SDK so
   AVD creation resolves the newly installed system image there. Record the command-line-tools
   package's resolved revision; do not assume the bootstrap wrapper sees the mutable image.

   API 35 is a runtime image; the app still compiles/targets API 36. Match x86_64 to this host so
   KVM works; ARM64 APKs cannot run on this AVD. Prefer Google APIs without Play Store background
   apps. Record `java -version`, `sdkmanager --list_installed`, `adb version`, `emulator -version`
   and `emulator -accel-check`. Installed Google tools/NDK must load through host nix-ld; if a
   shared library is missing use the existing `steam-run` compatibility environment under G1 and
   record it. Do not patch /lib or system configuration.

   Install Agent Device locally with `npm install --prefix "$E2E/tools" --no-audit --no-fund agent-device`
   only after G1; record and pin the resolved version for repeatability. Verify `agent-device --help`,
   snapshot/gesture/deep-link command syntax and Android serial selection. If it ignores the
   isolated ADB socket, resolve that before proceeding; never silently use the shared server.

3. **Build without the emulator.** Verify ≥16 GiB MemAvailable. Run `npm run build:client` and:

   ```bash
   cd "$REPO_ROOT/packages/app"
   APP_VARIANT=development CI=1 npx expo prebuild --platform android --clean --non-interactive --no-install
   cd android
   ```

   This creates ignored `packages/app/android`. Inspect generated wrapper version, compile SDK,
   build tools, NDK, CMake, autolinking of `paseo-scroll`, and Gradle properties before downloading
   a different version. No generated native source gets committed.

   For a concrete C++ concurrency bound, write `$E2E/native-memory.gradle` with this Gradle init
   snippet (local build configuration, applied to application and library plugins):

   ```groovy
   gradle.beforeProject { project ->
     ["com.android.application", "com.android.library"].each { pluginId ->
       project.plugins.withId(pluginId) {
         project.extensions.getByName("android").defaultConfig.externalNativeBuild.cmake.arguments.addAll([
           "-DCMAKE_JOB_POOLS:STRING=paseo_compile=2;paseo_link=1",
           "-DCMAKE_JOB_POOL_COMPILE:STRING=paseo_compile",
           "-DCMAKE_JOB_POOL_LINK:STRING=paseo_link"
         ])
       }
     }
   }
   ```

   Validate this against the generated AGP DSL. It sets CMake's Ninja job-pool defaults for CMake
   targets, not a made-up Gradle CMake property. Inspect generated `build.ninja` for
   `pool = paseo_compile` and `pool = paseo_link`. A library may override its targets' job pools;
   if the defaults are not honored, adjust the local init setup before building, and record the
   actual limit. `CMAKE_BUILD_PARALLEL_LEVEL=2` alone does **not** guarantee a cap when AGP invokes
   Ninja directly.

   Proposed serial build command (use `set -o pipefail` so tee cannot hide failure):

   ```bash
   export CMAKE_BUILD_PARALLEL_LEVEL=2
   set -o pipefail
   flock "$E2E/android-build.lock" \
     systemd-run --user --scope --unit=paseo-stable-scroll-build \
       -p MemoryAccounting=yes -p MemoryMax=14G -p MemorySwapMax=0 \
     ./gradlew :app:assembleDebug -I "$E2E/native-memory.gradle" \
       -PreactNativeArchitectures=x86_64 -Pandroid.cmakeVersion=3.30.5 \
       -Pkotlin.compiler.execution.strategy=in-process \
       --no-daemon --max-workers=2 -Dorg.gradle.parallel=false -Dorg.gradle.vfs.watch=false \
       -Dorg.gradle.jvmargs="-Xmx4g -XX:MaxMetaspaceSize=1g -XX:ActiveProcessorCount=4 -XX:+UseParallelGC -Dfile.encoding=UTF-8" \
       2>&1 | tee "$E2E/logs/gradle.log"
   ```

   Sample `systemctl --user show paseo-stable-scroll-build.scope -p MemoryCurrent -p MemoryPeak`
   every 2 seconds from a second shell until it exits; save the highest peak before the transient
   scope disappears. Capture build elapsed time and concurrent clang/linker RSS. Compile the native
   instrumentation APKs with the same limits using
   `:paseo-scroll:assembleDebug :paseo-scroll:assembleDebugAndroidTest` before booting if N1 needs
   substantial compilation. Do not run a global `gradle --stop` or kill other JVMs.

4. **Create an isolated AVD.** Use `avdmanager` from the isolated SDK's installed command-line tools,
   with `ANDROID_HOME` and `ANDROID_AVD_HOME` above:

   ```bash
   echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd \
     -n paseo-stable-scroll -k 'system-images;android-35;google_apis;x86_64' \
     -d pixel_7 -p "$E2E/avd/paseo-stable-scroll.avd"
   ```

   Set existing entries in its `config.ini` (replace, don't append duplicate keys): `hw.ramSize=3072`,
   `vm.heapSize=512`, `hw.cpu.ncore=4`, `disk.dataPartition.size=6G`, `hw.keyboard=yes`.
   Keep the Pixel 7 display/density initially. The test uses a docked software keyboard when needed.

5. **Boot and wait for actual readiness.** Verify ≥8 GiB MemAvailable and no build running. Start
   in a named user scope with `MemoryMax=6G`, logs under `$E2E/logs`, and:

   ```bash
   emulator @paseo-stable-scroll -ports 5580,5581 -memory 3072 -cores 4 -accel on \
     -gpu swiftshader_indirect -no-window -no-audio -no-boot-anim -no-snapshot \
     -camera-back none -camera-front none
   ```

   Check installed `emulator -help-gpu` first: if the legacy `swiftshader_indirect` name has been
   removed, use the supported `swiftshader` mode and record it. Software GPU is for reproducible
   position assertions, not native smoothness performance claims. Enable video/screenshot capture
   in the headless emulator. Use `adb -P 5047 -s emulator-5580 wait-for-device`, poll
   `sys.boot_completed=1` with a deadline, and verify PackageManager responds. Failure collects
   emulator logs; it does not justify restarting the main daemon.

6. **Start a disposable daemon and Metro.** Each process gets a recorded PID/process group and
   exit trap. From repo root, use the same daemon entrypoint as the Electron harness:

   ```bash
   PASEO_HOME="$E2E/paseo-home" PASEO_LISTEN=127.0.0.1:6793 PASEO_NODE_ENV=development \
   PASEO_CORS_ORIGINS='*' PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD=0 \
   PASEO_DICTATION_ENABLED=0 PASEO_VOICE_MODE_ENABLED=0 \
     node --import tsx packages/server/scripts/dev-runner.ts
   ```

   Keep stdout and daemon log under `$E2E`; wait for the seed client handshake/server-info, not
   only a listening port. In a separate owned process from `packages/app`:

   ```bash
   APP_VARIANT=development EXPO_UNSTABLE_HEADLESS=1 CI=1 \
   REACT_NATIVE_PACKAGER_HOSTNAME=localhost EXPO_PUBLIC_LOCAL_DAEMON=localhost:6793 \
     npx expo start --dev-client --port 8093 --clear --max-workers 2
   ```

   Verify `http://127.0.0.1:8093/status` returns `packager-status:running`. Reverse both ports with
   `adb -P 5047 -s emulator-5580 reverse tcp:8093 tcp:8093` and `reverse tcp:6793 tcp:6793`.
   Both native URLs use localhost through reverse; `EXPO_PUBLIC_LOCAL_DAEMON` is inlined at bundle
   time. Changing it requires restarting only this owned Metro/cache, not any daemon on 6767.

7. **Install, launch and connect.** Install the generated
   `packages/app/android/app/build/outputs/apk/debug/app-debug.apk` via isolated ADB. A fresh AVD
   guarantees no existing personal app data. Launch development client with:

   ```bash
   adb -P 5047 -s emulator-5580 shell am start -W -a android.intent.action.VIEW \
     -d 'paseo://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8093' sh.paseo.debug
   ```

   Verify the installed package/version and native UI, not merely am-start success. Deep-link syntax
   must be confirmed against this generated dev client; if it opens the launcher, enter
   `http://localhost:8093` using Agent Device and the existing
   `packages/app/maestro/flows/android-dev-client.yaml` as the reference. At Welcome, choose direct
   connection to `localhost:6793`. Never reuse `flows/land-in-chat.yaml` unchanged: it hard-codes 6767. Wait for connected host and workspace/composer without a redbox.

8. **Run automation.** `android.mjs` uses `node --import tsx` to reuse
   `seedMockAgentWorkspace({ port: 6793, model: "one-minute-stream", repoPrefix: "stable-scroll-", title: "Stable scroll QA" })` and
   guaranteed cleanup. Supply `E2E_SERVER_ID` from this daemon's server-info or its `server-id` file;
   existing route helpers require that variable. Build a throwaway repo inside `$E2E/tmp`, seed
   enough short completed turns with `emit 3 coalesced agent stream updates` for overflow, and open
   its agent route through the app's supported workspace open intent. Preserve the public routing
   helper; no startup-routing modifications.

   ```bash
   ANDROID_SERIAL=emulator-5580 ANDROID_ADB_SERVER_PORT=5047 ADB_SERVER_SOCKET=tcp:localhost:5047 \
   PASEO_STABLE_SCROLL_DAEMON_PORT=6793 PASEO_STABLE_SCROLL_METRO_PORT=8093 \
   PASEO_STABLE_SCROLL_APP_ID=sh.paseo.debug \
   PASEO_STABLE_SCROLL_ARTIFACTS="$E2E/evidence" \
     node --import tsx packages/app/e2e/mobile/stable-scroll/android.mjs
   ```

   Discover selectors interactively once, then save deterministic Agent Device commands. Use
   `snapshot --raw --json`, stable IDs, `wait/get/is/find`, fill, press and swipe; don't rely on
   uiautomator global-idle waits during generation. Existing `agent-chat-scroll`, `user-message`,
   `assistant-message`, `scroll-to-bottom-button`, `message-input-root`, and `floating-header` IDs
   are available. New selectors, if necessary, identify a row by stable message ID, not copied
   response prose. The root `test:e2e:mobile` script unconditionally prepares the iOS runner and
   runs a directory, so it is not the targeted Android invocation on this Linux host.

9. **Capture evidence and clean up.** During A1–A10 record Agent Device bounds at ≤500 ms intervals,
   visible text/row growth, and a screenrecord (split runs below Android's duration limit). Screenshots
   at phase boundaries plus intermediate video catch transient movement that sampled geometry may
   miss. Compare fixed visible glyph/paragraph bounds, including offsets inside a tall assistant row;
   its outer top alone is insufficient if native rendering internally moves text. Keep keyboard,
   scrollbar fade, and growing suffix out of any static screenshot crop; a growing region cannot
   be asserted pixel-identical. Existing composer-keyboard image helpers provide the crop approach.

   Copy evidence to `artifacts/stable-scroll/android/`: APK SHA/revision, versions, resolved SDK
   packages, Gradle args/output, named scope memory samples, emulator args/config/RSS, logcat,
   Metro/daemon logs, screenshots/video, snapshot JSON, raw drift/growth samples, and per-step result.
   Record verified settings separately from recommendations below, including peaks and wall time.

   In `finally`, run fixture cleanup to remove project/agents, close owned Agent Device session/
   daemon under its isolated state, remove reverse mappings, `adb -P 5047 -s emulator-5580 emu kill`,
   stop only recorded Metro/daemon process groups/named scopes, then stop the ADB server on 5047.
   Do not kill shared 5037, any other emulator/JVM, or 6767. Preserve evidence; remove owned AVD,
   homes and generated Android files after acceptance. Keep downloaded SDK/Gradle caches only for
   repairs until accepted, then remove `$E2E` if not intentionally retained. All cleanup paths must
   be checked as inside this worktree.

### 4.4 Proposed resource envelope and tradeoffs

These are **not yet verified successful settings**. Record actual results before moving them into
DOC2. Abort/pause on insufficient available memory; no swap means oversubscription can kill other
work. A cgroup limit confines failure to the owned build/emulator.

| ID  | Proposed setting                                                                        | Purpose and tradeoff                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Gradle `-Xmx4g`, `MaxMetaspaceSize=1g`                                                  | Matches app config's Expo defaults; lower heap risks GC/OOM, higher heaps leave less native/emulator room. CLI `-Dorg.gradle.jvmargs` overrides generated properties.                                                                                                                                    |
| R2  | `--no-daemon --max-workers=2 -Dorg.gradle.parallel=false`, JVM `ActiveProcessorCount=4` | Stops persistent build JVM memory after use; bounds project workers on a 32-CPU host. Slower cold builds. `--no-daemon` may still create a single-use JVM, which exits after completion.                                                                                                                 |
| R3  | Kotlin in-process with `-Pkotlin.compiler.execution.strategy=in-process`                | No separate retained Kotlin JVM. All Kotlin shares R1 heap. If proven insufficient, switch this owned build to daemon strategy and use local `gradle.properties` setting `kotlin.daemon.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=512m`; record the separate JVM peak. Never stop another project's daemon. |
| R4  | One ABI `-PreactNativeArchitectures=x86_64`; debug APK                                  | Avoid four native builds and release Hermes bundling. Not a phone ARM64 or release-optimization result. A requested phone APK still uses existing `npm run build:apk:arm64`; no reason to run universal here.                                                                                            |
| R5  | CMake/Ninja compile pool 2, link pool 1 through §4.3 init script; max 2 Gradle workers  | C++ jobs can dominate RSS. Inspect generated pool assignments and actual process peaks. CMake env var alone doesn't cap direct Ninja. Sequential linker pool limits each Ninja invocation; two Gradle workers can still run separate native projects.                                                    |
| R6  | Build scope `MemoryMax=14G`, swap 0                                                     | Bound total Java, workers and native children. A hit kills this build, not permission to raise blindly. Lower worker/pool counts first; debug wrapper rebuild pays startup time.                                                                                                                         |
| R7  | AVD API35 Google APIs x86_64, 3072 MiB RAM, 512 MiB guest heap, 4 vCPU, KVM required    | Enough for debug RN without a large guest. Expected host RSS may exceed 3 GiB; measure. If guest LMK kills the app, use 4096 after checking host budget. Do not reduce to 1 GiB for a misleading flaky run.                                                                                              |
| R8  | Headless/no-audio/no-boot-animation; no cameras; software GPU                           | Less host device contention; software rasterization is CPU-heavy and not smoothness evidence. Try host GPU only after explicitly verifying this host's driver/display path.                                                                                                                              |
| R9  | `-no-snapshot`, 6G data partition, named emulator `MemoryMax=6G`                        | No stale snapshot or multi-GiB RAM snapshot files; slower cold boot. Preserve state during repairs, remove at final cleanup.                                                                                                                                                                             |
| R10 | Metro `--max-workers 2`; local Gradle/npm/ADB state                                     | Bounds bundler workers and prevents shared cache/ADB ownership mistakes. No repeated `--clear` during one journey. Cold local Gradle cache costs downloads/disk.                                                                                                                                         |
| R11 | Serialize browser → Electron → Android build → emulator/Metro/daemon → instrumentation  | Never overlap Gradle with emulator/browser. Native test APKs prebuilt before boot where possible; final connected task uses 1 worker and mostly installs/runs. Shared other-project builds remain untouched; wait for ≥16 GiB available for build, ≥8 GiB for emulator stack.                            |

Verified settings table (to fill during E3): R-ID, exact effective args, tool version, pass/fail,
build cgroup peak, emulator peak RSS, Metro/daemon RSS, wall time, log/evidence link. Empty during
design; estimates above are not measurements.

## 5. E2E journey

E2E is required for this initial feature addition, including repairs. Future pushes/deployments
require no E2E rerun. Existing unit tests remain required. Do not add contrary AGENTS.md rules.

### Desktop: J1–J10

Use the existing mock provider through a real isolated daemon/network. It supplies deterministic
streamed assistant text, reasoning/tool changes, and termination; no mocked scroll transport or
provider credentials. Seed completed history cheaply, then start a fresh one-minute/bursty turn for
each sampling scenario so earlier steps cannot exhaust a stream. Assert daemon still running and
rendered text/content height advances during every stability window.

1. **J1:** Open an overflowing chat while streaming. Observe authoritative initial readiness,
   landing and hiding of Scroll to bottom. After at most 60 eligible frames, baseline its offset,
   the first visible paragraph/message identity and y; no delayed re-follow. Reload variant too.
2. **J2:** From that end position, leave all input idle for ≥5 s while rendered height grows ≥300 px.
   Sample each RAF. Assert offset drift and fixed visible text drift ≤1 px. The button appears when
   the end moves below, without a scroll event being necessary.
3. **J3:** Wheel up ≥300 px during streaming; select a visible completed message/paragraph and record
   offset and y for ≥5 s of more growth. It stays visible at the same y. No unexplained frame jumps.
4. **J4:** During a fresh turn, use wheel, scrollbar drag, PageUp, and End as separate variants.
   Assert the gesture moves the reader; after each ends, establish a new baseline. Reaching the end
   never reattaches. Nested tool-scroll and editable-question keys keep their own input ownership.
5. **J5:** Tap Scroll to bottom midstream. Assert one end landing, then stationary text with growth;
   button returns. Separately use the existing paginated-not-live-tail path and its error/retry case.
6. **J6:** Idle Send/Enter, running Send with both steer/interrupt settings, and Queue track Send now:
   assert the existing end destination is reachable. Re-baseline after landing; further output never
   moves it. Also verify automatic queued dispatch/remote messages don't create scroll intent.
7. **J7:** Complete a short turn, a reply longer than one viewport, and a turn viewed scrolled up.
   Record two seconds before/after final reveal and footer/live-history handoff. Repeat cancellation
   and the mock synthetic-turn-failure path. Anchored text does not jump; completion never follows.
8. **J8:** Leave a retained chat scrolled up, then repeat leaving exactly at the end. Stream while it
   is hidden; return through another workspace/tab. Assert the first returned frames preserve the
   old reading position (not a new tail position). Fresh route/reload is a separate one-shot landing.
9. **J9:** Fresh empty chat, submit a short prompt, then grow output through underfill to overflow.
   Top-visible content stays at the top, with no bottom-alignment-induced movement.
10. **J10:** Grow composer, open/close keyboard where applicable, resize window, open/close a
    disclosure, prepend older history, and pass a virtualized seam. Respect legitimate geometry/
    disclosure corrections; then assert stable generation against the new baseline. Preserve
    existing first-painted-frame disclosure bounds and paragraph-retention tests.

E1 covers all variants on desktop web plus selected compact web paths. E2 runs J1–J6 basic variants
and J8 in actual Linux Electron, with CDP geometry/screenshot/video evidence and the real desktop
bridge. Parameterize fresh isolated agents instead of reusing an expired minute-long turn.

### Real Android: A1–A10

Use §4.3's isolated AVD, debug app, Metro bundle and disposable daemon. Every assertion measures
native bounds/screenshots; browser-only compact width is not evidence.

1. **A1:** Connect to the disposable daemon and open the seeded overflowing chat while generation
   runs. Confirm working native composer, correct workspace/agent, no launcher/redbox. Entry lands
   once at end; record app PID and bundle/revision.
2. **A2:** Open a fresh empty chat. Send a short prompt, sample the fixed prompt glyph/paragraph y
   during initial short output and through overflow. Top alignment stays fixed; offset zero alone
   does not count as evidence.
3. **A3:** In a long chat at the end, capture bounds and video for ≥5 s and ≥300 logical px of new
   rendered content. Same visible text stays within 2 device px; Scroll to bottom appears.
4. **A4:** Swipe down to read older content while generation continues. Select a visible fixed text
   anchor and sample it. More output arrives below without pulling the text along.
5. **A5:** Swipe/fling back to the end; wait for momentum to end. More output arrives without
   following. Prove the swipe moved content first, so a broken/blocked native scroller cannot pass.
6. **A6:** Tap Scroll to bottom. It reaches the current end, hides the button, and releases ownership.
   Further growth is stationary and restores the button. Repeat on a fresh turn if needed.
7. **A7:** Send idle prompt and send during generation; check the one-shot destination then fixed
   viewport under new output. Test with keyboard closed and docked keyboard visible, baselining
   only after its movement settles. Do not mistake keyboard translation for stream drift.
8. **A8:** Observe completion and cancellation in end/scrolled-up positions. Capture first native
   frames around footer/final-reveal handoff; no automatic jump to the latest answer.
9. **A9:** Background/foreground, and switch another workspace/tab and return while streaming:
   retained position stays. Then force-stop only the disposable app and relaunch/deep-link:
   this fresh entry lands once. Distinguish resume of a retained panel from a new route request.
10. **A10:** Show more/less on a long user message (bottom-edge hold), summary disclosure (top-edge
    hold), keyboard open/close, and older-history prepend while a reply streams. Trigger remains
    anchored for disclosures, history keeps the visible row, and settled viewport never follows.

Evidence per step: raw snapshot bounds and density conversion (`adb shell wm density`), visible
anchor identity and clipped-visible intersection, rendered growth, timestamps, screenshots and
screenrecord, plus device/daemon statuses. A failed step collects logs and last native snapshot and
reports failure; no conditional skips, timeout-based restarts, or claims based solely on app launch.

Platform report: Linux Electron and Android are mandatory; browser wide/compact are supplemental.
iOS and desktop macOS/Windows are not exercised on this host; report that limit explicitly.
