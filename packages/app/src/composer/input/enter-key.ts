import type { NativeSyntheticEvent, TextInputKeyPressEventData } from "react-native";
import type { SendShortcut } from "@/hooks/use-settings";
import { isWeb } from "@/constants/platform";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { resolveMessageInputEnterAction, type MessageInputEnterContext } from "./state";
import { insertComposerLineBreak } from "./line-break";

export type WebTextInputKeyPressEvent = NativeSyntheticEvent<
  TextInputKeyPressEventData & {
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    // Web-only: present on DOM KeyboardEvent during IME composition (CJK input).
    isComposing?: boolean;
    keyCode?: number;
  }
>;

/** Enter submits only on web at non-compact widths; compact web and native keep Return editing. */
export function resolveComposerSubmitOnEnter(isCompact: boolean): boolean {
  return isWeb && !isCompact;
}

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
): boolean {
  if (isImeComposingKeyboardEvent(event.nativeEvent)) return false;
  if (event.nativeEvent.key !== "Enter") return false;
  const action = resolveMessageInputEnterAction({
    submitOnEnter: ctx.submitOnEnter,
    sendShortcut: ctx.sendShortcut,
    shiftKey: event.nativeEvent.shiftKey ?? false,
    metaKey: event.nativeEvent.metaKey ?? false,
    ctrlKey: event.nativeEvent.ctrlKey ?? false,
    isAgentRunning: ctx.isAgentRunning,
    onQueue: ctx.onQueue,
  });
  if (action === null) return false;
  if (action === "line-break") {
    event.preventDefault();
    return insertComposerLineBreak(event.target);
  }
  if (!ctx.canSubmit) return false;
  event.preventDefault();
  if (action === "alternate-send") ctx.onAlternateSend();
  else ctx.onDefaultSend();
  return true;
}
