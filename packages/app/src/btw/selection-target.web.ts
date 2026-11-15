import { useEffect, useRef } from "react";
import { attachBtwSelectionTarget, type BtwSelectionElementPort } from "./selection-contract";
import type { BtwSelectionTargetInput, BtwComposerInputRef } from "./selection-target";

export function useBtwSelectionTarget({ target, onInsert }: BtwSelectionTargetInput): void {
  const onInsertRef = useRef(onInsert);
  onInsertRef.current = onInsert;
  useEffect(() => {
    const node = target?.current;
    if (!(node instanceof HTMLElement)) return;
    return attachBtwSelectionTarget(node as unknown as BtwSelectionElementPort, (text) =>
      onInsertRef.current(text),
    );
  }, [target]);
}

export function focusBtwComposerInput(input: BtwComposerInputRef | null): void {
  input?.focus();
  if (!(input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement)) return;
  const node = input;
  function focusAtEnd() {
    if (!node.isConnected) return;
    node.focus();
    const end = node.value.length;
    node.setSelectionRange(end, end);
  }
  focusAtEnd();
  // Pane activation schedules main-composer autofocus on the next frame.
  // Follow it once; sheet overlay activation can also move focus on mount.
  window.requestAnimationFrame(() => window.requestAnimationFrame(focusAtEnd));
}
