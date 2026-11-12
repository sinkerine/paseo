import { beforeEach, expect, test } from "vitest";
import { btwWindowKey, useBtwWindowStore } from "./window-store";

beforeEach(() => useBtwWindowStore.setState({ byThread: {} }));
test("discovery opens once and chip toggles both ways without updates reopening a hidden thread", () => {
  const key = btwWindowKey("host", "agent", "thread");
  const store = useBtwWindowStore.getState();
  store.discover(key);
  expect(useBtwWindowStore.getState().byThread[key]).toBe("open");
  store.toggle(key);
  store.discover(key);
  expect(useBtwWindowStore.getState().byThread[key]).toBe("minimized");
  store.toggle(key);
  expect(useBtwWindowStore.getState().byThread[key]).toBe("open");
  store.setMode(key, "minimized");
  store.discover(key);
  expect(useBtwWindowStore.getState().byThread[key]).toBe("minimized");
});
test("visibility is scoped to host, owner and thread with collision-free keys", () => {
  const keys = [
    btwWindowKey("a", "b", "c"),
    btwWindowKey("a", "b", "d"),
    btwWindowKey("a", "d", "c"),
    btwWindowKey("d", "b", "c"),
    btwWindowKey("a:b", "", "c"),
  ];
  const store = useBtwWindowStore.getState();
  for (const key of keys) store.discover(key);
  store.toggle(keys[0]);
  expect(keys.map((key) => useBtwWindowStore.getState().byThread[key])).toEqual([
    "minimized",
    "open",
    "open",
    "open",
    "open",
  ]);
});
