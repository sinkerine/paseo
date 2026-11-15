import { z } from "zod";

export const BTW_SELECTION_TARGET_ATTRIBUTE = "data-btw-thread";
export const BTW_SELECTION_INSERT_EVENT = "paseo:btw-insert";
export const BtwSelectionInsertDetailSchema = z.object({ text: z.string().min(1) });

export interface BtwSelectionEventPort {
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly detail?: unknown;
  preventDefault(): void;
  stopPropagation(): void;
}
export interface BtwSelectionElementPort {
  setAttribute(qualifiedName: string, value: string): void;
  removeAttribute(qualifiedName: string): void;
  addEventListener(type: string, listener: (event: BtwSelectionEventPort) => void): void;
  removeEventListener(type: string, listener: (event: BtwSelectionEventPort) => void): void;
}

export function attachBtwSelectionTarget(
  element: BtwSelectionElementPort,
  onInsert: (text: string) => boolean,
): () => void {
  function insert(event: BtwSelectionEventPort) {
    if (!event.cancelable || event.defaultPrevented) return;
    const parsed = BtwSelectionInsertDetailSchema.safeParse(event.detail);
    if (!parsed.success || !onInsert(parsed.data.text)) return;
    event.preventDefault();
    event.stopPropagation();
  }
  element.setAttribute(BTW_SELECTION_TARGET_ATTRIBUTE, "");
  element.addEventListener(BTW_SELECTION_INSERT_EVENT, insert);
  return () => {
    element.removeEventListener(BTW_SELECTION_INSERT_EVENT, insert);
    element.removeAttribute(BTW_SELECTION_TARGET_ATTRIBUTE);
  };
}
