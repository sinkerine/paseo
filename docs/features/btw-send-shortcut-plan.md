# BTW composer follows the Send shortcut — plan

Status: **finalized autonomously by the design agent (2026-11-14); human input/approval not required** (see D11).
Branch: `btw-extension-command-send-shift-newline`, worktree `/home/sinkerine/.paseo/worktrees/28vpgp2p/macho-lionfish`,
base `refs/remotes/origin/main` at `2e9d69649f39770d3ced777900d6be8bcfba269e`. Workspace `wks_f71629c5e4be693f`.

User request: "in the btw extension, Command should send a message, and Shift+Command should insert a line
break. See if the shortcut can be configured. Also, discuss … which layer we should fix this in: the paseo side or
the extension side." The user accepted the recommendation to make BTW inherit Paseo's existing **Settings →
General → Sending → Send shortcut** preference ("do this"). With `⌘+Enter` (`Ctrl+Enter` off macOS) selected,
`⌘+Enter` sends and `⇧+⌘+Enter` inserts a line break.

## Design findings that shape the plan

1. **BTW has no key handling.** `packages/app/src/btw/window-content.tsx:182` renders a multiline
   `SheetAwareTextInput` with no `onKeyPress`. Only the `btw-send` button calls `ask`. `SheetAwareTextInput`
   (`components/ui/text-input/sheet-aware.tsx`) forwards to RN `TextInput`, or to `BottomSheetTextInput` on native
   inside a sheet.
2. **The main composer decides keys on web only.** `handleDesktopKeyPressImpl`
   (`composer/input/input.tsx:471`) runs only when `isWeb`. Enter only submits when `isWeb && !isCompact`
   (`input.tsx:1842`), and the decision comes from `resolveMessageInputEnterAction` (`composer/input/state.ts:167`).
3. **Shift+Mod+Enter inserts nothing today, in either composer.** The resolver returns `null` for any Shift chord,
   leaving the browser default. I probed Playwright 1.58.2 Chromium (rev 1208) in `nix develop`
   (`artifacts/btw-send-shortcut/design/chromium-enter-defaults.{mjs,txt}`). A `<textarea>` gains `\n` on
   `Enter` and `Shift+Enter` only. `Meta+Enter`, `Control+Enter`, `Shift+Meta+Enter` and `Shift+Control+Enter`
   leave the value unchanged. RN-web's `TextInput.handleKeyDown` adds nothing for a Shift chord
   (`node_modules/react-native-web/dist/exports/TextInput/index.js:281`). The investigation's claim that
   "⇧+⌘+Enter inserts a line break" in the main composer was therefore wrong: that chord does nothing there either.
   This plan makes the line break explicit (D4, D5).
4. **Nothing global claims these chords.** The BTW textarea resolves to focus scope `editable`
   (`keyboard/focus-scope.ts`). No binding uses Mod+Enter or Shift+Mod+Enter. The only Enter binding,
   `message-input-dictation-confirm-enter`, acts only while dictation records. The BTW floating card and sheet
   register only `Escape` (`btw/floating-card.tsx`, `btw/sheet.tsx`). `packages/desktop/src` has no Enter/Return
   menu accelerators (`rg -n accelerator packages/desktop/src | rg -i 'enter|return'` → empty).
5. **The producer passes multi-line questions through.** Pi 1.4.0 `_tryExecuteExtensionCommand`
   (`dist/core/agent-session.js:1698`) passes everything after the first space, newlines included, as `args`.
   `pi-btw` `commands.ts:457` asks with those `args`. The capability check (Test and verification §2) confirms this
   end to end through the real daemon.
6. **Precedent for inserting text.** `composer/pasted-text.web.ts:58` uses
   `ownerDocument.execCommand("insertText", …)`. It keeps the textarea's undo history and emits the normal `input`
   event, so both controlled (BTW) and uncontrolled (`EditingTextInput`) inputs publish the new text.

## Goal and acceptance criteria

Goal: on web and Electron at desktop widths, BTW's composer answers Enter, Mod+Enter and Shift+Mod+Enter exactly
as the agent composer does, under the existing Send shortcut preference. Shift+Mod+Enter inserts a line break in
both composers. Keyboard sends go through BTW's existing `ask` dispatch, so live BTW commands, the
non-interrupting out-of-band path and parent isolation stay unchanged. No new preference, no protocol change, no
`pi-btw` change.

"Mod" means Meta (⌘) or Control. As today, the resolver accepts either key on every OS. A "BTW request" is a
`stub.requests` entry whose serialized messages contain `<btw>`. A "parent request" is one that does not
(`e2e/browser/pi-btw-window.spec.ts` `mainRequests`). "Sends" means: exactly one new BTW request, the
`btw-composer` value becomes `""`, and the question text appears in the BTW transcript (`agent-chat-scroll` inside
`btw-window`). "Does not send" means no new BTW request and an unchanged draft apart from any stated line break.

Entry paths:

- **W** is the wide web BTW floating card (1440×900). It is reached by asking `/btw …` from the real main composer
  of a Pi agent running real Pi 1.4.0 and the real `pi-btw` package against the deterministic HTTP model stub.
- **C** is the compact web BTW sheet (390×844), reached the same way.
- **M** is the agent composer of a mock-provider agent (`settings-toggle-tab-regression.spec.ts`).
- The preference is always changed through the real Settings → General → Sending `Send shortcut` select, toggled
  in place with `Control+Comma` (`Meta+Comma` on macOS).

| ID       | Criterion                                                                                                                                                                                                                                                                                                                                                     | Paths | Evidence                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------- |
| **AC1**  | With Send shortcut `Enter` (the default), `Enter` sends the BTW draft. `Shift+Enter` inserts `\n` at the caret and does not send. `Control+Enter` and `Meta+Enter` each send.                                                                                                                                                                                 | W     | E2E-B1 steps J3–J4                             |
| **AC2**  | With Send shortcut `Ctrl+Enter`/`⌘+Enter`, `Enter` inserts `\n` and does not send. `Control+Enter` and `Meta+Enter` each send. `Shift+Control+Enter` and `Shift+Meta+Enter` each insert exactly one `\n` at the caret and do not send. A draft built this way is sent intact: the BTW request's user text and the transcript row contain every line in order. | W     | E2E-B1 steps J5–J7                             |
| **AC3**  | A Send shortcut change takes effect in an existing BTW thread without reload, in both directions: `Enter` → `Ctrl/⌘+Enter` → `Enter`. After switching back, `Enter` sends again and `Shift+Mod+Enter` still inserts a line break.                                                                                                                             | W     | E2E-B1 steps J5, J8                            |
| **AC4**  | `Shift+Mod+Enter` inserts its line break in both preference modes, including on an empty draft while Send is disabled. It replaces a non-empty selection, leaves the caret after the inserted `\n`, publishes the new text through `onChangeText`, and one undo restores the previous text.                                                                   | W     | E2E-B1 steps J3, J8; U2 (caret/selection/undo) |
| **AC5**  | Keyboard sends follow the Send button's enabled state exactly. A blank or whitespace-only draft never sends from the keyboard. Two consecutive `Control+Enter` presses on one draft produce exactly one BTW request.                                                                                                                                          | W     | E2E-B1 step J9                                 |
| **AC6**  | A keyboard send while the daemon transport is down shows the existing connection error in `btw-action-feedback` and keeps the draft. After the transport is restored, the same shortcut sends that draft exactly once.                                                                                                                                        | W     | E2E-B1 step J10                                |
| **AC7**  | While a parent turn is held running and the main composer holds an unsent draft, a BTW keyboard send dispatches only the `/btw` command. The parent stays `running` with `stub.pending("parent") === 1` and no new parent request. The main composer value is unchanged, the main timeline user-message count is unchanged, and the BTW answer arrives.       | W     | E2E-B1 step J11                                |
| **AC8**  | In the compact BTW sheet, keys keep the compact agent composer's behaviour in both preference modes: `Enter` inserts `\n`, `Control+Enter` and `Meta+Enter` do not send, and the Send button sends.                                                                                                                                                           | C     | E2E-B2                                         |
| **AC9**  | An `Enter` keydown that arrives during IME composition (`isComposing` or `keyCode 229`) neither sends nor inserts a line break, with or without Shift/Mod, in both modes.                                                                                                                                                                                     | W     | U2 (real RN-web `TextInput` + real handler)    |
| **AC10** | In the agent composer, `Shift+Control+Enter` and `Shift+Meta+Enter` insert exactly one `\n` at the caret and do not send, in both preference modes. Existing behaviour stays as it is: `Enter`/`Shift+Enter`/`Control+Enter`/`Meta+Enter` per mode, autocomplete and recall key precedence, and running-agent modifier Enter for Steer/Interrupt/Queue.       | M     | E2E-M1; existing tests in that file            |
| **AC11** | Existing BTW journeys still pass unmodified: button send, Stop, Inject, Summarize, New, Clear, minimize/restore, backdrop dismissal, retry, refresh/restart restore and absent-extension fallback.                                                                                                                                                            | W, C  | Existing `pi-btw-window.spec.ts` tests; U3     |

AC9 uses a browser unit test because Playwright cannot produce a composing `Enter` keydown. U2 mounts the real RN-web
`TextInput` and the real `handleComposerEnterKey`, which is the code BTW and the agent composer run. It dispatches
the keydown shape the browser emits during composition. This is the strongest available evidence; it is not
helper-only.

### State and concurrency transitions

| ID  | Transition                                                                                   | Covered by         |
| --- | -------------------------------------------------------------------------------------------- | ------------------ |
| S1  | Preference changed while a BTW thread exists (stale cached setting), both directions         | AC3 / J5, J8       |
| S2  | Rapid repeated keyboard send before re-render (double submit)                                | AC5 / J9           |
| S3  | Keyboard send while a send is pending: input not editable, Send disabled, no second dispatch | AC5 / J9           |
| S4  | Dispatch failure, then keyboard retry after reconnect                                        | AC6 / J10          |
| S5  | Keyboard send while the parent turn runs (non-interrupting out-of-band command)              | AC7 / J11          |
| S6  | Blank draft, then typed draft (gating follows the draft)                                     | AC5 / J9; AC4 / J3 |
| S7  | IME composition, then committed text                                                         | AC9 / U2           |
| S8  | Layout switch between card and sheet: `compact` is read per render, nothing is cached        | AC1 (W) + AC8 (C)  |

### Decisions

- **D1 — Layer: Paseo app.** Ruling: fix this in `packages/app` — the app owns key interpretation, newline
  insertion, the Send preference and dispatch. `pi-btw` only receives the submitted `/btw <text>` command. An
  extension-side setting would need a configuration bridge back to the app just to choose send vs newline — cost if
  wrong: none for the producer; a later extension-owned preference would still have to drive this same app handler.
- **D2 — Inherit the existing preference.** Ruling: BTW reads `useAppSettings().settings.sendShortcut` (`enter` |
  `mod-enter`); no new setting, no Settings UI change, no storage migration — user-approved — cost if wrong: a
  separate BTW preference later adds one field and one select.
- **D3 — One shared Enter-key path.** Ruling: extract `handleComposerEnterKey` and have both composers call it,
  so BTW cannot drift from the agent composer — cost if wrong: small refactor of `handleDesktopKeyPressImpl`
  guarded by AC10.
- **D4 — Explicit line break.** Ruling: `Shift+Mod+Enter` resolves to a new `"line-break"` action. The handler
  prevents the default and inserts `\n` with `execCommand("insertText")` (finding 6). That preserves undo and emits
  `input` for both input styles. Chromium has no default for this chord (finding 3) — cost if wrong: an engine
  without `execCommand` returns `false` and inserts nothing, which is today's behaviour.
- **D5 — The agent composer gets the same line break.** Ruling: the change lives in the shared resolver, so the
  agent composer also gains `Shift+Mod+Enter` → line break in both modes. The user approved BTW inheriting the agent
  composer's behaviour, which was described as including this line break; today that chord is a no-op there
  (finding 3) — cost if wrong: a chord that did nothing now types `\n` in the agent composer; reverting is one
  resolver branch.
- **D6 — Platform scope.** Ruling: key handling runs only when `isWeb`, and Enter submission only at
  non-compact widths. Both come from one `resolveComposerSubmitOnEnter(isCompact)` used by both composers.
  - The compact web sheet keeps native textarea behaviour, matching the compact agent composer (AC8).
  - iOS and Android are untouched: `onKeyPress` is `undefined` on native, as in the agent composer.
  - `docs/keyboard-shortcuts.md` already says native has no configurable send keys; this plan promises none.
  - Cost if wrong: compact or native users keep using the Send button, as today.
- **D7 — Gating equals the Send button.** Ruling: `canSubmit = !pending && draft.trim() !== ""`, the same
  expression the `btw-send` button uses (the button reads the shared value). Double submits stay blocked by the
  existing `admitting` ref in `btw/window.tsx` `dispatch` — cost if wrong: none beyond parity with the button.
- **D8 — BTW has no queue.** Ruling: BTW passes `isAgentRunning: false, onQueue: undefined`, so Mod+Enter in
  `Enter` mode is a plain ask; `"alternate-send"` never occurs for BTW and both callbacks are `ask` — cost if
  wrong: none; BTW commands are already non-interrupting.
- **D9 — Non-goals.** No send-key tooltip or hint on the BTW Send button, no native hardware-keyboard support for
  BTW, no change to plain `Shift+Enter` (still the browser default) — cost if wrong: separate follow-ups.
- **D10 — Platform coverage.** Ruling: Chromium Playwright with real Pi and `pi-btw` is the acceptance
  environment.
  - Real Electron is a disclosed gap. Its renderer runs the same web bundle, no `.electron.*` module is on this
    path, and the desktop main process has no Enter/Return accelerators (finding 4).
  - macOS and Windows desktops are disclosed gaps. `Meta+Enter` on Linux Chromium exercises the `metaKey` branch,
    but not macOS key-equivalent routing.
  - iOS and Android are not tested; no native code changes.
  - Cost if wrong: an Electron- or macOS-specific interception would surface only in manual use; delivery may add
    a real-Electron smoke.
- **D11 — Human input gate.** Ruling: no human input or approval required. The user chose the layer (D1) and the
  inheritance (D2). The only new judgement calls are D4–D5: they make the user's stated expectation true, are
  additive on a chord that does nothing today, and are easy to revert. Nothing is destructive, external,
  security-sensitive or new-preference — cost if wrong: the user asks to drop D5, a one-branch change.

### Documentation

- **DOC1** — `docs/keyboard-shortcuts.md`, rewrite the "Composer send-key customization" paragraph in place, no
  appended section. It must state three things:
  - The agent composer and BTW share `handleComposerEnterKey` and the Send shortcut preference.
  - `Shift+Mod+Enter` inserts its line break explicitly, because Chromium textareas have no default for that chord.
  - Compact web and native keep their existing Return path.

  Evidence: reviewer reads the diff; `npm run format:check`.

## Design

### Data flow

```
keydown (web textarea) ─▶ RN-web TextInput.onKeyPress(event)
   ├─ agent composer: handleDesktopKeyPressImpl ─ IME? ─ onKeyPressCallback (autocomplete/recall) ─┐
   └─ BTW: BtwWindowContent.handleComposerKeyPress ───────────────────────────────────────────────┤
                                                                                                    ▼
                         handleComposerEnterKey(event, ctx)
                           IME composing → false
                           key !== "Enter" → false
                           resolveMessageInputEnterAction(ctx + shift/meta/ctrl)
                             null            → false (browser default: Enter/Shift+Enter newline)
                             "line-break"    → preventDefault; insertComposerLineBreak(event.target)
                             send, !canSubmit → false (no preventDefault; unchanged)
                             "default-send"  → preventDefault; onDefaultSend()
                             "alternate-send"→ preventDefault; onAlternateSend()
BTW onDefaultSend = ask → onCommand({kind:"ask", text: draft}) → BtwThreadWindow.dispatch (admitting guard)
  → useSendBtwCommand → client.sendAgentMessage(agentId, "/btw <text>", {messageId:""})   (unchanged)
```

### `packages/app/src/composer/input/state.ts` (modify)

```ts
export type MessageInputEnterAction = "alternate-send" | "default-send" | "line-break";
export function resolveMessageInputEnterAction(
  ctx: MessageInputEnterContext, // unchanged interface
): MessageInputEnterAction | null;
```

Order:

1. If `!submitOnEnter`, return `null`.
2. `hasModifier = metaKey || ctrlKey`. If `shiftKey`, return `hasModifier ? "line-break" : null`.
3. With `mod-enter`, return `hasModifier ? "default-send" : null`.
4. Otherwise, return `"alternate-send"` when `hasModifier && isAgentRunning && onQueue`, else `"default-send"`.

Only rule 2 changes; every other result stays identical.

### `packages/app/src/composer/input/enter-key.ts` (new, cross-platform)

```ts
import type { NativeSyntheticEvent, TextInputKeyPressEventData } from "react-native";
import type { SendShortcut } from "@/hooks/use-settings";
import type { MessageInputEnterContext } from "./state";

/** Moved verbatim from input.tsx; input.tsx imports it from here. */
export type WebTextInputKeyPressEvent = NativeSyntheticEvent<
  TextInputKeyPressEventData & {
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    isComposing?: boolean;
    keyCode?: number;
  }
>;

/** Enter submits only on web at non-compact widths; compact web and native keep Return editing. */
export function resolveComposerSubmitOnEnter(isCompact: boolean): boolean; // isWeb && !isCompact

export interface ComposerEnterKeyContext {
  submitOnEnter: boolean;
  sendShortcut: SendShortcut;
  isAgentRunning: boolean;
  onQueue: MessageInputEnterContext["onQueue"];
  /** False while submission is disabled, loading, or the input is disabled. */
  canSubmit: boolean;
  onDefaultSend: () => void;
  onAlternateSend: () => void;
}

/** Applies the shared Send shortcut to a web key press. Returns true when it consumed the press. */
export function handleComposerEnterKey(
  event: WebTextInputKeyPressEvent,
  ctx: ComposerEnterKeyContext,
): boolean;
```

`handleComposerEnterKey` does these checks in order:

1. Use `isImeComposingKeyboardEvent(event.nativeEvent)` from `@/utils/keyboard-ime`; if composing, return `false`.
2. If `event.nativeEvent.key` isn't `"Enter"`, return `false`.
3. On `"line-break"`, the line break runs before the `canSubmit` check, so it works with Send disabled:
   `event.preventDefault()`, then `return insertComposerLineBreak(event.target)`.
4. For a send action with `!canSubmit`, return `false` without `preventDefault`. This keeps today's behaviour,
   where Enter on a blank draft types a newline.

### `packages/app/src/composer/input/line-break.ts` / `line-break.web.ts` (new)

Same signature in both files, following the `pasted-text.ts` / `pasted-text.web.ts` split:

```ts
/** Inserts "\n" at the selection of a focused web textarea, keeping undo history. Returns false when nothing was inserted. */
export function insertComposerLineBreak(target: unknown): boolean;
```

- Base file: returns `false`. Native never reaches the handler.
- Web file: if `target` is not an `HTMLTextAreaElement`, return `false`. Otherwise return
  `target.ownerDocument.execCommand("insertText", false, "\n")`. A read-only or disabled textarea yields `false`
  and no change.

### `packages/app/src/composer/input/input.tsx` (modify)

- Delete the local `WebTextInputKeyPressEvent` and import it from `./enter-key`.
- `handleDesktopKeyPressImpl` keeps its IME check and its `onKeyPressCallback` step unchanged. Then it calls
  `handleComposerEnterKey(event, { submitOnEnter, sendShortcut, isAgentRunning, onQueue, canSubmit:
!(isSubmitDisabled || isSubmitLoading || disabled), onDefaultSend: handleDefaultSendAction, onAlternateSend:
handleAlternateSendAction })`.
- `shouldSubmitOnEnter = resolveComposerSubmitOnEnter(isCompact)`.
- `DesktopKeyPressContext` keeps its fields.

### `packages/app/src/btw/window-content.tsx` (modify)

- Add `const { settings } = useAppSettings();` from `@/hooks/use-settings`.
- Add `const canAsk = !pending && draft.trim() !== "";`. The `btw-send` button's `disabled` becomes `!canAsk` (D7).
- Add `handleComposerKeyPress = useCallback((event: WebTextInputKeyPressEvent) => { handleComposerEnterKey(event, {
submitOnEnter: resolveComposerSubmitOnEnter(compact), sendShortcut: settings.sendShortcut, isAgentRunning:
false, onQueue: undefined, canSubmit: canAsk, onDefaultSend: ask, onAlternateSend: ask }); }, [compact,
settings.sendShortcut, canAsk, ask])`, with a one-line comment that BTW has no queue (D8).
- `SheetAwareTextInput` gets `onKeyPress={isWeb ? handleComposerKeyPress : undefined}`, with `isWeb` from
  `@/constants/platform`.
- `BtwContentProps`, `BtwThreadWindow`, `send.ts` and `draft.ts` stay unchanged.

### Conventions

- `docs/coding-standards.md`: no casts beyond narrowing `unknown` with `instanceof`, and no duplicate local types.
  Stale cross-package declarations mean `npm run build:client` or `npm run build:server`, never a local shim.
- AGENTS.md platform gating: `.web.ts` split for the DOM call, `isWeb` imported from `@/constants/platform`.
- Do not use `useUnistyles()`. Add no feature flag. Change no protocol and no `pi-btw`.

## Tasks

### Wave 1

**T1 — BTW and agent composer share the Send shortcut and Shift+Mod+Enter line break** (single task, no split).

- Goal: every AC, D and DOC1 above.
- Owns (exact):
  - `packages/app/src/composer/input/state.ts`
  - `packages/app/src/composer/input/state.test.ts`
  - `packages/app/src/composer/input/enter-key.ts` (new)
  - `packages/app/src/composer/input/line-break.ts` (new)
  - `packages/app/src/composer/input/line-break.web.ts` (new)
  - `packages/app/src/composer/input/enter-key.browser.test.tsx` (new, U2)
  - `packages/app/src/composer/input/input.tsx`
  - `packages/app/src/btw/window-content.tsx`
  - `packages/app/src/btw/window.test.tsx` (only if `useAppSettings` needs provider/storage setup; no new mocks of
    the handler)
  - `packages/app/e2e/browser/pi-btw-window.spec.ts` (E2E-B1, E2E-B2)
  - `packages/app/e2e/support/helpers/pi-btw.ts` (BTW composer key and request-count helpers)
  - `packages/app/e2e/support/helpers/settings.ts`: move `pressSettingsToggleShortcut` and `selectSendingOption`
    from the regression spec into exported `toggleSettingsWithShortcut(page)` and
    `selectSendingOption(page, setting, option)`.
  - `packages/app/e2e/browser/settings-toggle-tab-regression.spec.ts` (E2E-M1; import the moved helpers)
  - `docs/keyboard-shortcuts.md` (DOC1)
  - Evidence under ignored `artifacts/btw-send-shortcut/`.
- Consumes:
  - `useAppSettings`/`SendShortcut` (`@/hooks/use-settings`)
  - `isImeComposingKeyboardEvent` (`@/utils/keyboard-ime`)
  - `isWeb`
  - The existing BTW Playwright harness: `btwBrowserTest`, `launchBtwAgent`, `askBtwFromRunningMainComposer`,
    `installDaemonWebSocketGate`, `connectDaemonClient`
- Produces: the `state.ts`, `enter-key.ts` and `line-break*.ts` signatures above, and the `canAsk` wiring.
- Dependencies: none. External: `PASEO_PI_BTW_PACKAGE=/home/sinkerine/dev/pi-btw` at
  `7ea4f106f9b9414a0fdc550efc8165fa33d5ab8f` (clean, on `origin/main`), read-only; no producer task.
- Order inside T1:
  1. Capability check (§2 below).
  2. Write AC tests first and record their baseline failures.
  3. Implement.
  4. Run targeted tests, then the E2E specs, then root gates.
- Unit test command (done when green):
  `flock --close /home/sinkerine/dev/paseo/.git/worktrees/macho-lionfish/e2e-feature-build.lock sh -c 'npm exec --workspace=@getpaseo/app -- vitest run src/composer/input/state.test.ts src/btw --project=unit --maxWorkers=1 --bail=1 && nix develop -c npm exec --workspace=@getpaseo/app -- vitest run src/composer/input/enter-key.browser.test.tsx src/composer/input/text-input.web.browser.test.tsx --project=browser --bail=1'`
- Review: consolidated after implementation; no early focused review. The interfaces are small and internal to
  `packages/app`.

## Test and verification

### 1. Environment and prerequisites

- **Host.** kazuki: 60 GiB RAM (about 22 GiB available at design time), 32 cores. Node v24.21.0, npm 11.19.0.
  Playwright 1.58.2 with cached Chromium revision 1208.
- **Shell.** Run browser commands inside `nix develop -c …`. Bare Chromium fails with
  `libglib-2.0.so.0: cannot open shared object file`. Do not set `PLAYWRIGHT_BROWSERS_PATH` and install nothing.
- **Pi environment** for the BTW spec:
  - `PASEO_PI_BINARY=/nix/store/l8niyvnm0wbpmk1faq8lxw96nf6d5hqr-pi-coding-agent-1.4.0/bin/pi`; `--version` must
    print `1.4.0`, which `createBtwRuntime` asserts.
  - `PASEO_PI_BTW_PACKAGE=/home/sinkerine/dev/pi-btw`. `createBtwRuntime` records `git rev-parse HEAD`, which must
    equal `7ea4f106f9b9414a0fdc550efc8165fa33d5ab8f`. The Nix-store pi-btw copy is not a Git checkout, so it cannot
    serve here.
  - `createBtwRuntime` unsets inherited `PI_*` itself.
- **Generated inputs.** `packages/{protocol,client,server,highlight,relay}/dist` exist. No protocol, server or
  dependency change is planned. Before the first Playwright run, run `npm run build:server` once under the lock, so
  the harness daemon matches HEAD; it rewrites only ignored `dist/`. Rebuild only if a cross-package type error
  appears, never patching around it. Root `npm run typecheck` runs workspace hooks. No `package.json` change means
  no `bash scripts/update-nix.sh --check`.
- **Isolation.**
  - The app Playwright harness owns Metro on a free port, per-worker daemon homes and ports, throwaway workspaces and
    cleanup. The BTW runtime owns a temporary Pi agent directory and the HTTP stub.
  - Never touch the main daemon on port 6767 or `~/.paseo`.
  - Write evidence only under `artifacts/btw-send-shortcut/`, using
    `--output /home/sinkerine/.paseo/worktrees/28vpgp2p/macho-lionfish/artifacts/btw-send-shortcut/<check>`.
- **Resource ordering.** One heavy command at a time under the build lock
  `/home/sinkerine/dev/paseo/.git/worktrees/macho-lionfish/e2e-feature-build.lock`: vitest browser, each
  Playwright spec, `build:server` and root typecheck. Acquire the lock once and never nest it. Browser vitest and
  Playwright both launch Chromium, so never run them concurrently.
- **Files the checks rewrite.** `npm run format:files -- <paths>` rewrites the given files. `build:server` rewrites
  `dist/`. Playwright writes only to `--output`. Nothing else rewrites tracked files.

### 2. Executable capability check (before implementation)

Run on the unchanged baseline, write the new tests first, and save logs to
`artifacts/btw-send-shortcut/capability/`.

1. **Chromium defaults.** Run `nix develop -c node artifacts/btw-send-shortcut/design/chromium-enter-defaults.mjs`.
   Expect the recorded table, where only Enter and Shift+Enter add `\n`. This proves the line break must be
   explicit.
2. **BTW real path (hardest), W.**
   - Discover the tests:
     `nix develop -c npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/pi-btw-window.spec.ts --list`.
     Zero matching tests is a failure.
   - Run the new E2E-B1 test alone with `-g "Send shortcut"` and `--workers=1` on baseline.
   - Readiness: `btw-window` is visible with `aria-label` `btw:<threadId>`. `recordedBtwStates` shows the thread
     `completed`. The control send through the `btw-send` button produces exactly one new BTW request.
   - Representative action: `Enter` (default mode), then `Control+Enter`.
   - Observation, read immediately after each press with `expect.poll` (default 10 s): the `btw-composer` value
     (`toHaveValue`) and the BTW request count from `stub.requests`.
   - Expected baseline failure: J3 (`Enter` sends) fails, with the request count unchanged and the draft holding
     `\n`. Neither key sends, and `Shift+Control+Enter` leaves the value unchanged.
   - Also prove the multi-line pass-through (finding 5): send a two-line draft with the button, and assert that the
     BTW request's last user content contains both lines in order and the transcript row shows both.
   - If the harness cannot reach readiness, that is a capability blocker, not a baseline failure.
3. **Agent composer, M.** Run the updated
   `settings-toggle-tab-regression.spec.ts -g "send shortcut selection persists"` on baseline. The expected failure
   is at the new `Shift+Control+Enter` assertion, with the value unchanged. Existing steps up to that point pass.
4. Record in `verification.md`:
   - the build/environment identities: HEAD, `pi --version`, pi-btw SHA, Playwright/Chromium revision, Metro and
     daemon ports
   - the exact commands
   - the readiness observed
   - the failure signatures

### 3. Targeted tests

| ID  | What                                                                                                                                                                                                                                                                                                                                                                                                                                | Command                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | Resolver: Shift+Meta/Ctrl+Enter → `"line-break"` in both modes. `submitOnEnter:false` → `null`. Shift alone → `null`. All other existing cases are unchanged. Update the two existing "returns null for Shift+Cmd+Enter" cases.                                                                                                                                                                                                     | `npm exec --workspace=@getpaseo/app -- vitest run src/composer/input/state.test.ts --project=unit --maxWorkers=1 --bail=1`                                                                                                            |
| U2  | Browser test with a real RN-web controlled `TextInput` and the real `handleComposerEnterKey`, driven by `userEvent.keyboard` from `vitest/browser`. Asserts caret insertion and selection replacement through `onChangeText`. One `document.execCommand("undo")` restores the text. Line break works with `canSubmit:false`. No line break and no send when composing (AC9). Mod+Enter sends in `mod-enter` mode without a newline. | `nix develop -c npm exec --workspace=@getpaseo/app -- vitest run src/composer/input/enter-key.browser.test.tsx --project=browser --bail=1`                                                                                            |
| U3  | Existing BTW unit tests (window state, draft, send, select, pill, window rendering) stay green.                                                                                                                                                                                                                                                                                                                                     | `npm exec --workspace=@getpaseo/app -- vitest run src/btw --project=unit --maxWorkers=1 --bail=1`                                                                                                                                     |
| U4  | Existing `EditingTextInput` browser behaviour (IME, replaceText), because `input.tsx` changed.                                                                                                                                                                                                                                                                                                                                      | `nix develop -c npm exec --workspace=@getpaseo/app -- vitest run src/composer/input/text-input.web.browser.test.tsx --project=browser --bail=1`                                                                                       |
| E1  | BTW Playwright: new E2E-B1 (W) and E2E-B2 (C) plus all existing tests in the file (AC11).                                                                                                                                                                                                                                                                                                                                           | `nix develop -c env PASEO_PI_BINARY=… PASEO_PI_BTW_PACKAGE=/home/sinkerine/dev/pi-btw npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/pi-btw-window.spec.ts --workers=1 --output <abs>/artifacts/btw-send-shortcut/e2e-btw` |
| E2  | Agent composer Playwright: E2E-M1 plus the file's existing tests (AC10 regressions).                                                                                                                                                                                                                                                                                                                                                | `nix develop -c npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/settings-toggle-tab-regression.spec.ts --workers=1 --output <abs>/artifacts/btw-send-shortcut/e2e-settings`                                                 |

Before running, discover each runner with `vitest list <file> --project=<unit|browser>` or Playwright `--list`.
Zero selected tests is a failure. `pi-btw-window.real.spec.ts` is live-provider and out of scope: the change is
keyboard-only, and the deterministic spec drives the same real Pi and `pi-btw`.

### 4. Repository gates

- `npm run format:files -- <every changed file>`, then `npm run format:check`.
- `npm run lint`.
- `npm run typecheck`, the root command over every workspace. It is the **consumer check**: the changed interfaces
  are consumed by `packages/app` (`input.tsx`, `btw/window-content.tsx`), and the desktop package bundles the app
  renderer. E2 is the real-counterpart check for the agent composer consuming the shared handler.
- `git diff --check`.

Never run a full suite. Do not invoke the host e2e-feature verifier helper from workers.

### 5. Platform matrix (D10)

| Platform              | Tested             | Notes                                                                                    |
| --------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| Web (Chromium, Linux) | Yes: E1, E2, U2    | Wide card and compact sheet; Meta and Control chords                                     |
| Desktop Linux         | No (disclosed)     | Same renderer bundle, no `.electron.*` module on this path, no Enter/Return accelerators |
| Desktop macOS/Windows | No (disclosed)     | macOS key-equivalent routing not exercised                                               |
| iOS / Android         | No; code unchanged | `onKeyPress` is `undefined` on native; BTW keeps Return newline plus Send button         |

### 6. Repair ownership and protected boundaries

- The T1 worker owns the files listed under T1.
- Protected and never edited: `btw/send.ts`, `btw/draft.ts`, `btw/window.tsx` dispatch, `packages/server`,
  `packages/protocol`, `~/dev/pi-btw`, existing assertions in both specs, the 6767 daemon and `~/.paseo`.
- Existing tests may be extended, not weakened.
- A failure whose cause is outside the owned files goes to the orchestrator as `NEEDS_CONTEXT`. One example is the
  producer truncating multi-line arguments.

## E2E journey

**E2E-B1 — wide BTW follows the Send shortcut** (new test in `pi-btw-window.spec.ts`, viewport 1440×900,
`btwBrowserTest(false)`)

| Step | Action                                                                                                                                                                                                                             | Expected                                                                                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J1   | `launchBtwAgent`. Send `PARENT_A` with the main composer button and wait for the finish.                                                                                                                                           | `PARENT_A_FINISHED` is visible and the agent is idle.                                                                                                                                                                                       |
| J2   | Send `/btw first question` from the main composer with the button.                                                                                                                                                                 | `btw-window` is visible with a thread `aria-label`, the answer `BTW_REPLY CONTEXT_A` arrives, and the thread status is `completed`.                                                                                                         |
| J3   | Focus `btw-composer` while empty. Press `Shift+Control+Enter`, then type `AFTER_B one`.                                                                                                                                            | Value is `"\nAFTER_B one"`, with no BTW request while empty. `btw-send` was disabled before typing.                                                                                                                                         |
| J4   | Mode `Enter` (default). Clear and fill `AFTER_B enter`, then press `Enter`. Fill `AFTER_B line`, press `Shift+Enter`, type `two`. Clear, fill `AFTER_B ctrl`, press `Control+Enter`. Fill `AFTER_B meta`, press `Meta+Enter`.      | `Enter` sends once. `Shift+Enter` gives `"AFTER_B line\ntwo"` with no request. `Control+Enter` and `Meta+Enter` each send once. Each sent question appears in the BTW transcript.                                                           |
| J5   | Toggle Settings (`Control+Comma`), select `Send shortcut` → `Ctrl+Enter` (`⌘+Enter` on macOS), and toggle back. If the window was minimized, reopen it with `btw-chip` and record which happened.                                  | Selector shows `Send shortcut: Ctrl+Enter`. The same thread `aria-label` is shown and no page reload happened.                                                                                                                              |
| J6   | Fill `AFTER_B first`. Press `Enter`, type `AFTER_B second`. Press `Shift+Control+Enter`, type `third`. Press `Shift+Meta+Enter`, type `fourth`.                                                                                    | Value is `"AFTER_B first\nAFTER_B second\nthird\nfourth"` and no BTW request was made.                                                                                                                                                      |
| J7   | Press `Control+Enter`. Then fill `AFTER_B meta2` and press `Meta+Enter`.                                                                                                                                                           | Each sends once. The first request's last user content contains all four lines in order, and the transcript row shows them.                                                                                                                 |
| J8   | Toggle Settings and select `Enter`, then toggle back. Fill `AFTER_B again`, press `Shift+Meta+Enter`, then type `back`. Press `Enter`.                                                                                             | Before `Enter`, value is `"AFTER_B again\nback"` and no BTW request was made. `Enter` sends it once, and the transcript row shows both lines. Selection replacement and undo are proven in U2.                                              |
| J9   | Fill `"   "` and press `Control+Enter`. Then fill `AFTER_B double` and press `Control+Enter` twice in succession.                                                                                                                  | The blank draft makes no request. The double press makes exactly one new BTW request, and the composer ends empty.                                                                                                                          |
| J10  | `transport.drop()`, then `waitForBlockedConnection()`. Fill `AFTER_B offline` and press `Control+Enter`. Then `transport.restore()` and wait for the `agent.provider_subagents.list.response` resync. Press `Control+Enter` again. | Feedback matches `/connect\|socket\|offline/i` and the draft is still `AFTER_B offline`, with no request. After restore, exactly one new BTW request, and the composer is empty.                                                            |
| J11  | Send `HOLD_PARENT` with the main composer button and wait for `stub.pending("parent") === 1`. Fill the main composer with `MAIN_DRAFT_UNTOUCHED`. Fill `btw-composer` with `AFTER_B during parent` and press `Control+Enter`.      | One BTW request and the BTW answer arrives. `stub.pending("parent") === 1`, no new parent request, and the agent status is `running`. The main composer value is still `MAIN_DRAFT_UNTOUCHED` and the main user-message count is unchanged. |
| J12  | `stub.release("parent")` and wait for the finish. Attach the JSON evidence: per-step request counts, composer values, thread id and producer revision. Screenshot `btw-wide-send-shortcut`.                                        | The parent finishes. In `finally`, release the stubs, close the client and `closeAgent`.                                                                                                                                                    |

**E2E-B2 — compact BTW sheet keeps compact editing** (new test, viewport 390×844)

| Step | Action                                                                                                                                                                            | Expected                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| K1   | Same as J1–J2 at compact size. Wait for `waitForSettledPosition(window)`.                                                                                                         | The BTW sheet is visible and the thread is completed.                                                          |
| K2   | Mode `Enter`. Fill `AFTER_B compact`, press `Enter`, then `Control+Enter`, then `Meta+Enter`.                                                                                     | Value is `"AFTER_B compact\n"`, from `Enter` only. No BTW request.                                             |
| K3   | Seed `@paseo:app-settings` with `{sendShortcut:"mod-enter"}` through `addInitScript` before launch, or select it in Settings if the compact layout shows the selector. Repeat K2. | The same result as K2.                                                                                         |
| K4   | Click `btw-send`.                                                                                                                                                                 | Exactly one BTW request and the composer is empty. Screenshot `btw-compact-send-shortcut` and close the agent. |

K3 may run as a second iteration of the same test with the seeded preference; choose whichever keeps one spec
file coherent.

**E2E-M1 — agent composer line break** (extend `send shortcut selection persists and controls the composer`
in `settings-toggle-tab-regression.spec.ts`)

| Step | Action                                                                                                         | Expected                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| M1   | In the `Ctrl/⌘+Enter` step, after `Shift+Enter`, press `Shift+Control+Enter`, then `Shift+Meta+Enter`.         | Value is `"First line\n\n\n\n"` and nothing was sent. The existing `Control+Enter` and `Meta+Enter` sends still pass. |
| M2   | In the restored-`Enter` step, fill `Shift mod edits` and press `Shift+Control+Enter`, then `Shift+Meta+Enter`. | Value is `"Shift mod edits\n\n"` and nothing was sent. The existing `Enter` send still passes.                        |
| M3   | The file's other tests, including running-agent modifier send for Steer/Interrupt/Queue, run unmodified.       | All pass.                                                                                                             |

**Evidence and cleanup.**

- Playwright keeps its list-reporter output, attachments, screenshots and traces-on-failure under
  `artifacts/btw-send-shortcut/e2e-*`. `createBtwRuntime` writes runtime evidence, including the pi-btw revision,
  to the project output dir.
- The harness tears down Metro, daemons, Pi runtimes, stubs and temporary workspaces. Its leak fixture fails a test
  that leaves a project record.
- After the run, `git status --porcelain` lists only owned files. Leave nothing running. If a step failed, keep the
  evidence and do not reset state before recording it.
