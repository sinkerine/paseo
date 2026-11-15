import React, { act, useState, useCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
// Exercise the raw RN-web event boundary shared by both production input wrappers.
// eslint-disable-next-line no-restricted-imports
import { TextInput } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { SendShortcut } from "@/hooks/use-settings";
import {
  handleComposerEnterKey,
  resolveComposerSubmitOnEnter,
  type WebTextInputKeyPressEvent,
} from "./enter-key";

interface HarnessProps {
  initialText: string;
  sendShortcut: SendShortcut;
  canSubmit: boolean;
  compact: boolean;
  onChangeText(text: string): void;
  onSend(): void;
}
function Harness(props: HarnessProps) {
  const [value, setValue] = useState(props.initialText);
  const { onChangeText: recordTextChange } = props;
  const onChangeText = useCallback(
    (text: string) => {
      setValue(text);
      recordTextChange(text);
    },
    [recordTextChange],
  );
  const onKeyPress = useCallback(
    (event: WebTextInputKeyPressEvent) =>
      handleComposerEnterKey(event, {
        submitOnEnter: resolveComposerSubmitOnEnter(props.compact),
        sendShortcut: props.sendShortcut,
        isAgentRunning: false,
        onQueue: undefined,
        canSubmit: props.canSubmit,
        onDefaultSend: props.onSend,
        onAlternateSend: props.onSend,
      }),
    [props.compact, props.sendShortcut, props.canSubmit, props.onSend],
  );
  return <TextInput multiline value={value} onChangeText={onChangeText} onKeyPress={onKeyPress} />;
}
const mounted: { root: Root; container: HTMLDivElement }[] = [];
function mount(overrides: Partial<HarnessProps> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSend = vi.fn();
  const onChangeText = vi.fn();
  act(() =>
    root.render(
      <Harness
        initialText="first second"
        sendShortcut="enter"
        canSubmit
        compact={false}
        onSend={onSend}
        onChangeText={onChangeText}
        {...overrides}
      />,
    ),
  );
  mounted.push({ root, container });
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("Missing real RN-web textarea");
  textarea.focus();
  return { textarea, onSend, onChangeText };
}
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});
describe("handleComposerEnterKey with RN-web TextInput", () => {
  for (const sendShortcut of ["enter", "mod-enter"] as const) {
    for (const modifier of ["Control", "Meta"]) {
      it(`${sendShortcut}: Shift ${modifier} inserts at caret, publishes text and preserves undo`, async () => {
        const { textarea, onChangeText, onSend } = mount({ sendShortcut });
        textarea.setSelectionRange(5, 5);
        await userEvent.keyboard(`{Shift>}{${modifier}>}{Enter}{/${modifier}}{/Shift}`);
        expect(textarea.value).toBe("first\n second");
        expect(onChangeText).toHaveBeenLastCalledWith("first\n second");
        expect(textarea.selectionStart).toBe(6);
        expect(textarea.selectionEnd).toBe(6);
        expect(onSend).not.toHaveBeenCalled();
        act(() => {
          document.execCommand("undo");
        });
        expect(textarea.value).toBe("first second");
        expect(onChangeText).toHaveBeenLastCalledWith("first second");
      });
      it(`${sendShortcut}: Shift ${modifier} replaces selection even with Send disabled`, async () => {
        const { textarea, onChangeText, onSend } = mount({ sendShortcut, canSubmit: false });
        textarea.setSelectionRange(5, 7);
        await userEvent.keyboard(`{Shift>}{${modifier}>}{Enter}{/${modifier}}{/Shift}`);
        expect(textarea.value).toBe("first\necond");
        expect(onChangeText).toHaveBeenLastCalledWith("first\necond");
        expect(textarea.selectionStart).toBe(6);
        expect(textarea.selectionEnd).toBe(6);
        expect(onSend).not.toHaveBeenCalled();
      });
    }
    it(`${sendShortcut}: inserts on an empty disabled-send draft`, async () => {
      const { textarea, onChangeText, onSend } = mount({
        initialText: "",
        canSubmit: false,
        sendShortcut,
      });
      await userEvent.keyboard("{Shift>}{Control>}{Enter}{/Control}{/Shift}");
      expect(textarea.value).toBe("\n");
      expect(onChangeText).toHaveBeenLastCalledWith("\n");
      expect(onSend).not.toHaveBeenCalled();
    });
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      for (const modifiers of [
        {},
        { shiftKey: true },
        { ctrlKey: true },
        { metaKey: true },
        { shiftKey: true, ctrlKey: true },
        { shiftKey: true, metaKey: true },
      ]) {
        it(`${sendShortcut}: ignores composing Enter ${JSON.stringify({ composition, modifiers })}`, () => {
          const { textarea, onSend, onChangeText } = mount({ sendShortcut });
          const event = new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
            ...composition,
            ...modifiers,
          });
          act(() => {
            textarea.dispatchEvent(event);
          });
          expect(textarea.value).toBe("first second");
          expect(event.defaultPrevented).toBe(false);
          expect(onSend).not.toHaveBeenCalled();
          expect(onChangeText).not.toHaveBeenCalled();
        });
      }
    }
  }
  for (const modifier of ["Control", "Meta"]) {
    it(`${modifier} Enter sends once without adding a newline`, async () => {
      const { textarea, onSend, onChangeText } = mount({ sendShortcut: "mod-enter" });
      await userEvent.keyboard(`{${modifier}>}{Enter}{/${modifier}}`);
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onChangeText).not.toHaveBeenCalled();
      expect(textarea.value).toBe("first second");
    });
  }
  it("never sends while submission is disabled", async () => {
    const { textarea, onSend, onChangeText } = mount({
      canSubmit: false,
      sendShortcut: "mod-enter",
    });
    await userEvent.keyboard("{Control>}{Enter}{/Control}{Meta>}{Enter}{/Meta}");
    expect(textarea.value).toBe("first second");
    expect(onSend).not.toHaveBeenCalled();
    expect(onChangeText).not.toHaveBeenCalled();
  });
  it("keeps compact modifier chords on the browser editing path", async () => {
    const { textarea, onSend, onChangeText } = mount({ compact: true });
    await userEvent.keyboard("{Control>}{Enter}{/Control}{Shift>}{Meta>}{Enter}{/Meta}{/Shift}");
    expect(textarea.value).toBe("first second");
    expect(onSend).not.toHaveBeenCalled();
    expect(onChangeText).not.toHaveBeenCalled();
  });
});
