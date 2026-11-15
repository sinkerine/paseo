import { expect, test } from "vitest";
import {
  attachBtwSelectionTarget,
  BTW_SELECTION_INSERT_EVENT,
  BTW_SELECTION_TARGET_ATTRIBUTE,
  type BtwSelectionElementPort,
  type BtwSelectionEventPort,
} from "./selection-contract";

class SelectionElement implements BtwSelectionElementPort {
  attributes = new Map<string, string>();
  listeners = new Map<string, Set<(event: BtwSelectionEventPort) => void>>();
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  addEventListener(type: string, listener: (event: BtwSelectionEventPort) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: BtwSelectionEventPort) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(detail: unknown, defaultPrevented = false, cancelable = true) {
    const event = {
      detail,
      cancelable,
      defaultPrevented,
      stopped: false,
      preventDefault() {
        if (this.cancelable) this.defaultPrevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
    };
    for (const listener of this.listeners.get(BTW_SELECTION_INSERT_EVENT) ?? []) listener(event);
    return event;
  }
}

test("sets data-btw-thread on attach and removes attribute and listener on cleanup", () => {
  const element = new SelectionElement();
  const snippets: string[] = [];
  const detach = attachBtwSelectionTarget(element, (text) => {
    snippets.push(text);
    return true;
  });
  expect(BTW_SELECTION_TARGET_ATTRIBUTE).toBe("data-btw-thread");
  expect(BTW_SELECTION_INSERT_EVENT).toBe("paseo:btw-insert");
  expect(element.attributes.get(BTW_SELECTION_TARGET_ATTRIBUTE)).toBe("");
  expect(element.dispatch({ text: "> quote\n\n" })).toMatchObject({
    defaultPrevented: true,
    stopped: true,
  });
  expect(snippets).toEqual(["> quote\n\n"]);
  detach();
  expect(element.attributes.size).toBe(0);
  expect(element.listeners.get(BTW_SELECTION_INSERT_EVENT)?.size).toBe(0);
  expect(element.dispatch({ text: "late" }).defaultPrevented).toBe(false);
  expect(snippets).toEqual(["> quote\n\n"]);
});
test("ignores defaultPrevented events and malformed detail payloads", () => {
  const element = new SelectionElement();
  const snippets: string[] = [];
  attachBtwSelectionTarget(element, (text) => {
    snippets.push(text);
    return true;
  });
  for (const detail of [null, undefined, {}, { text: "" }, { text: 42 }]) {
    expect(element.dispatch(detail)).toMatchObject({ defaultPrevented: false, stopped: false });
  }
  expect(element.dispatch({ text: "claimed" }, true).stopped).toBe(false);
  expect(snippets).toEqual([]);
});
test("leaves event unprevented when onInsert refuses during admission", () => {
  const element = new SelectionElement();
  let admitting = true;
  const snippets: string[] = [];
  attachBtwSelectionTarget(element, (text) => {
    if (admitting) return false;
    snippets.push(text);
    return true;
  });
  expect(element.dispatch({ text: "quote" })).toMatchObject({
    defaultPrevented: false,
    stopped: false,
  });
  expect(snippets).toEqual([]);
  admitting = false;
  expect(element.dispatch({ text: "quote" })).toMatchObject({
    defaultPrevented: true,
    stopped: true,
  });
  expect(snippets).toEqual(["quote"]);
});
test("replaces listener cleanly across target remounts", () => {
  const element = new SelectionElement();
  const snippets: string[] = [];
  const detach = attachBtwSelectionTarget(element, (text) => {
    snippets.push("old:" + text);
    return true;
  });
  detach();
  const detachNew = attachBtwSelectionTarget(element, (text) => {
    snippets.push("new:" + text);
    return true;
  });
  element.dispatch({ text: "quote" });
  expect(snippets).toEqual(["new:quote"]);
  detachNew();
  expect(element.attributes.size).toBe(0);
});
test("isolates sibling pane elements", () => {
  const a = new SelectionElement();
  const b = new SelectionElement();
  const snippets: string[] = [];
  attachBtwSelectionTarget(a, (text) => {
    snippets.push("a:" + text);
    return true;
  });
  attachBtwSelectionTarget(b, (text) => {
    snippets.push("b:" + text);
    return true;
  });
  a.dispatch({ text: "quote" });
  expect(snippets).toEqual(["a:quote"]);
  b.dispatch({ text: "other" });
  expect(snippets).toEqual(["a:quote", "b:other"]);
});

test("rejects noncancelable inserts before changing the draft", () => {
  const element = new SelectionElement();
  const snippets: string[] = [];
  attachBtwSelectionTarget(element, (text) => {
    snippets.push(text);
    return true;
  });
  expect(element.dispatch({ text: "cannot acknowledge" }, false, false)).toMatchObject({
    cancelable: false,
    defaultPrevented: false,
    stopped: false,
  });
  expect(snippets).toEqual([]);
});
