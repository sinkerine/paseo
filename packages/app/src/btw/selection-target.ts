import type { ComponentRef, RefObject } from "react";
import type { View } from "react-native";
import type { SheetAwareTextInput } from "@/components/ui/text-input/sheet-aware";

export type BtwComposerInputRef = ComponentRef<typeof SheetAwareTextInput>;

export interface BtwSelectionTargetInput {
  target: RefObject<View | null> | undefined;
  onInsert(text: string): boolean;
}

export function useBtwSelectionTarget(_input: BtwSelectionTargetInput): void {}

export function focusBtwComposerInput(input: BtwComposerInputRef | null): void {
  input?.focus();
}
