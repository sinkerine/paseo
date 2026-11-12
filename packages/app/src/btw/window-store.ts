import { create } from "zustand";

export function btwWindowKey(serverId: string, agentId: string, threadId: string): string {
  return JSON.stringify([serverId, agentId, threadId]);
}
interface BtwWindowState {
  byThread: Record<string, "open" | "minimized">;
  discover(key: string): void;
  setMode(key: string, mode: "open" | "minimized"): void;
  toggle(key: string): void;
}
export const useBtwWindowStore = create<BtwWindowState>((set) => ({
  byThread: {},
  discover: (key) =>
    set((state) =>
      state.byThread[key]
        ? state
        : {
            byThread: { ...state.byThread, [key]: "open" },
          },
    ),
  setMode: (key, mode) => set((state) => ({ byThread: { ...state.byThread, [key]: mode } })),
  toggle: (key) =>
    set((state) => ({
      byThread: {
        ...state.byThread,
        [key]: state.byThread[key] === "open" ? "minimized" : "open",
      },
    })),
}));
