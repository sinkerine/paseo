import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import {
  createWorkspaceLayoutStore,
  collectAllTabs,
  collectAllPanes,
  selectWorkspaceEntryReady,
  selectExplorerSidebarPaneId,
} from "./workspace-layout-store";
import { deriveWorkspacePaneState } from "../screens/workspace/workspace-pane-state";
import { selectVisibleAgentIds } from "../screens/workspace/visible-agent-ids";

Object.assign(globalThis, { indexedDB, IDBKeyRange });

it("skips unchanged reconciliations and immediately saves real layout changes", async () => {
  const values = new Map<string, string>();
  let writes = 0;
  const storage: StateStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      writes += 1;
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
  const store = createWorkspaceLayoutStore(undefined, storage);
  await store.persist.rehydrate();
  const workspaceKey = "server:workspace";
  const openAgent = (agentId: string) =>
    store.getState().openTab({
      workspaceKey,
      target: { kind: "agent", agentId },
      intent: "reveal",
    });
  openAgent("agent-1");
  const layout = store.getState().layoutByWorkspace[workspaceKey];
  const writesBefore = writes;
  expect(writesBefore).toBe(1);
  for (let index = 0; index < 50; index += 1) {
    store.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
      knownTerminalIds: [],
      standaloneTerminalIds: [],
    });
  }
  expect(store.getState().layoutByWorkspace[workspaceKey]).toBe(layout);
  expect(writes).toBe(writesBefore);

  openAgent("agent-2");
  expect(writes).toBe(writesBefore + 1);
  const restored = createWorkspaceLayoutStore(undefined, storage);
  await restored.persist.rehydrate();
  expect(restored.getState().layoutByWorkspace[workspaceKey]).toEqual(
    store.getState().layoutByWorkspace[workspaceKey],
  );
});

it("keeps the saved layout when the shell publishes its layout mode before hydration", async () => {
  const values = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
  const workspaceKey = "server:workspace";
  const saved = createWorkspaceLayoutStore(undefined, storage);
  await saved.persist.rehydrate();
  saved.getState().openTab({
    workspaceKey,
    target: { kind: "file", path: "notes.md" },
    intent: "reveal",
  });

  // A page load: the shell publishes its mode from the first commit, before the read settles.
  const loaded = createWorkspaceLayoutStore(undefined, storage);
  loaded.getState().setLayoutMode("single-pane");
  await new Promise<void>((resolve) => loaded.persist.onFinishHydration(() => resolve()));
  expect(loaded.getState().layoutByWorkspace[workspaceKey]).toEqual(
    saved.getState().layoutByWorkspace[workspaceKey],
  );

  // Leaving the page before any other layout change must not lose the tabs.
  const reloaded = createWorkspaceLayoutStore(undefined, storage);
  await reloaded.persist.rehydrate();
  expect(reloaded.getState().layoutByWorkspace[workspaceKey]).toEqual(
    saved.getState().layoutByWorkspace[workspaceKey],
  );
});

it.each([1, 2])(
  "restores the agent pane after parked focus in storage version %i",
  async (version) => {
    const values = new Map<string, string>();
    const storage: StateStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    };
    const key = "host:workspace";
    const source = createWorkspaceLayoutStore(undefined, storage);
    await source.persist.rehydrate();
    source.getState().setLayoutMode("compact");
    source.getState().openTab({
      workspaceKey: key,
      target: { kind: "agent", agentId: "agent-a" },
      intent: "reveal",
    });
    source.getState().unfocusPane(key);
    expect(source.getState().layoutByWorkspace[key].focusedPaneId).toBeNull();
    const persisted = JSON.parse(values.get("workspace-layout-state")!);
    persisted.version = version;
    values.set("workspace-layout-state", JSON.stringify(persisted));
    const restored = createWorkspaceLayoutStore(undefined, storage);
    restored.getState().setLayoutMode("compact");
    await restored.persist.rehydrate();
    restored.getState().reconcileTabs(key, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-a"],
      autoOpenAgentIds: ["agent-a"],
      knownTerminalIds: [],
      standaloneTerminalIds: [],
    });
    const layout = restored.getState().layoutByWorkspace[key];
    const tabs = collectAllTabs(layout.root);
    const restoredExplorerId = selectExplorerSidebarPaneId(restored.getState(), key);
    const main = deriveWorkspacePaneState({ layout, tabs });
    const visible = selectVisibleAgentIds({
      layout,
      tabs,
      routeFocused: true,
      focusedPaneOnly: true,
      explorerPaneId: restoredExplorerId,
      explorerVisible: false,
    });
    expect(layout.focusedPaneId).toBe("main");
    expect(main.activeTab?.descriptor.target).toEqual({ kind: "agent", agentId: "agent-a" });
    expect(main.tabs.map((t) => t.descriptor.kind)).toEqual(["agent"]);
    expect(visible).toEqual(["agent-a"]);
  },
);

it("merges each window's changed workspace and purges only its own removed key", async () => {
  const values = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const initial = createWorkspaceLayoutStore(undefined, storage);
  await initial.persist.rehydrate();
  for (const key of ["server:A", "server:B"])
    initial.getState().openTab({
      workspaceKey: key,
      target: { kind: "agent", agentId: `${key}-old` },
      intent: "reveal",
    });
  await settle();
  const first = createWorkspaceLayoutStore(undefined, storage);
  const second = createWorkspaceLayoutStore(undefined, storage);
  await first.persist.rehydrate();
  await second.persist.rehydrate();
  first.getState().openTab({
    workspaceKey: "server:A",
    target: { kind: "agent", agentId: "a-latest" },
    intent: "reveal",
  });
  await settle();
  second.getState().openTab({
    workspaceKey: "server:B",
    target: { kind: "agent", agentId: "b-latest" },
    intent: "reveal",
  });
  await settle();
  const restored = createWorkspaceLayoutStore(undefined, storage);
  await restored.persist.rehydrate();
  expect(restored.getState().layoutByWorkspace["server:A"]).toEqual(
    first.getState().layoutByWorkspace["server:A"],
  );
  expect(restored.getState().layoutByWorkspace["server:B"]).toEqual(
    second.getState().layoutByWorkspace["server:B"],
  );
  // Persistence merging must not replace the other window's live snapshot.
  expect(second.getState().layoutByWorkspace["server:A"]).not.toEqual(
    first.getState().layoutByWorkspace["server:A"],
  );
  first.getState().purgeWorkspace("server:A");
  await settle();
  const purged = createWorkspaceLayoutStore(undefined, storage);
  await purged.persist.rehydrate();
  expect(purged.getState().layoutByWorkspace["server:A"]).toBeUndefined();
  expect(purged.getState().layoutByWorkspace["server:B"]).toEqual(
    second.getState().layoutByWorkspace["server:B"],
  );
});

it("uses restored parked focus and derived explorer keys as the hydrated baseline", async () => {
  const values = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const seed = createWorkspaceLayoutStore(undefined, storage);
  await seed.persist.rehydrate();
  seed.getState().openTab({
    workspaceKey: "server:A",
    target: { kind: "agent", agentId: "parked" },
    intent: "reveal",
  });
  seed.getState().unfocusPane("server:A");
  await settle();
  const raw = JSON.parse(values.get("workspace-layout-state")!);
  delete raw.state.explorerPaneIdByWorkspace;
  values.set("workspace-layout-state", JSON.stringify(raw));
  const a = createWorkspaceLayoutStore(undefined, storage),
    b = createWorkspaceLayoutStore(undefined, storage);
  await a.persist.rehydrate();
  await b.persist.rehydrate();
  a.getState().openTab({
    workspaceKey: "server:A",
    target: { kind: "file", path: "latest.md" },
    intent: "reveal",
  });
  await settle();
  b.getState().openTab({
    workspaceKey: "server:B",
    target: { kind: "agent", agentId: "other" },
    intent: "reveal",
  });
  await settle();
  const restored = createWorkspaceLayoutStore(undefined, storage);
  await restored.persist.rehydrate();
  expect(restored.getState().layoutByWorkspace["server:A"]).toEqual(
    a.getState().layoutByWorkspace["server:A"],
  );
  expect(restored.getState().layoutByWorkspace["server:B"]).toEqual(
    b.getState().layoutByWorkspace["server:B"],
  );
});

it("serializes overlapping asynchronous writes on one adapter", async () => {
  const { createWorkspaceLayoutPersistStorage } =
    await import("./workspace-layout-persist-storage");
  let saved: string | null = null;
  let release: () => void = () => {};
  let writes = 0;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter = createWorkspaceLayoutPersistStorage({
    getItem: async () => saved,
    setItem: async (_name, value) => {
      writes++;
      if (writes === 1) await blocked;
      saved = value;
    },
    removeItem: async () => {
      saved = null;
    },
  });
  await adapter.getItem("workspace-layout-state");
  const layout = (await import("./workspace-layout-store")).createDefaultLayout();
  const first = adapter.setItem("workspace-layout-state", {
    version: 2,
    state: { layoutByWorkspace: { A: layout } },
  });
  const second = adapter.setItem("workspace-layout-state", {
    version: 2,
    state: { layoutByWorkspace: { A: layout, B: layout } },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(writes).toBe(1);
  release();
  await first;
  await second;
  expect(writes).toBe(2);
  expect(Object.keys(JSON.parse(saved!).state.layoutByWorkspace)).toEqual(["A", "B"]);
});

it("merges and purges all persisted workspace slices without changing another workspace", async () => {
  const { createWorkspaceLayoutPersistStorage } =
    await import("./workspace-layout-persist-storage");
  const layout = (await import("./workspace-layout-store")).createDefaultLayout();
  const aLayout = { ...layout, focusedPaneId: null };
  const initial = {
    layoutByWorkspace: { A: layout, B: layout },
    pinnedAgentIdsByWorkspace: { A: ["old-a"], B: ["old-b"] },
    splitSizesByWorkspace: { A: { root: [0.5, 0.5] }, B: { root: [0.5, 0.5] } },
    explorerSidebarWidthByWorkspace: { A: 200, B: 200 },
    explorerPaneIdByWorkspace: { A: "explorer-a", B: "explorer-b" },
    sidePaneIdByWorkspace: { A: "side-a", B: "side-b" },
    pullRequestTabAutoOpenedByWorkspace: { A: true as const, B: true as const },
  };
  let raw = JSON.stringify({ version: 2, state: initial });
  const storage: StateStorage = {
    getItem: () => raw,
    setItem: (_key, value) => {
      raw = value;
    },
    removeItem: () => {
      raw = "";
    },
  };
  const a = createWorkspaceLayoutPersistStorage(storage),
    b = createWorkspaceLayoutPersistStorage(storage);
  await a.getItem("workspace-layout-state");
  await b.getItem("workspace-layout-state");
  const changedA = {
    layoutByWorkspace: { A: aLayout, B: layout },
    pinnedAgentIdsByWorkspace: { A: ["new-a"], B: ["old-b"] },
    splitSizesByWorkspace: { A: { root: [0.2, 0.8] }, B: { root: [0.5, 0.5] } },
    explorerSidebarWidthByWorkspace: { A: 280, B: 200 },
    explorerPaneIdByWorkspace: { A: "new-explorer-a", B: "explorer-b" },
    sidePaneIdByWorkspace: { A: "new-side-a", B: "side-b" },
    pullRequestTabAutoOpenedByWorkspace: { B: true as const },
  };
  await a.setItem("workspace-layout-state", { version: 2, state: changedA });
  await b.setItem("workspace-layout-state", {
    version: 2,
    state: { ...initial, explorerSidebarWidthByWorkspace: { A: 200, B: 360 } },
  });
  expect(JSON.parse(raw).state).toEqual({
    ...changedA,
    explorerSidebarWidthByWorkspace: { A: 280, B: 360 },
  });
  await a.setItem("workspace-layout-state", {
    version: 2,
    state: {
      layoutByWorkspace: { B: layout },
      pinnedAgentIdsByWorkspace: { B: ["old-b"] },
      splitSizesByWorkspace: { B: { root: [0.5, 0.5] } },
      explorerSidebarWidthByWorkspace: { B: 200 },
      explorerPaneIdByWorkspace: { B: "explorer-b" },
      sidePaneIdByWorkspace: { B: "side-b" },
      pullRequestTabAutoOpenedByWorkspace: { B: true },
    },
  });
  expect(JSON.parse(raw).state).toEqual({
    layoutByWorkspace: { B: layout },
    pinnedAgentIdsByWorkspace: { B: ["old-b"] },
    splitSizesByWorkspace: { B: { root: [0.5, 0.5] } },
    explorerSidebarWidthByWorkspace: { B: 360 },
    explorerPaneIdByWorkspace: { B: "explorer-b" },
    sidePaneIdByWorkspace: { B: "side-b" },
    pullRequestTabAutoOpenedByWorkspace: { B: true },
  });
});

it("replaces an invalid latest envelope with this window's valid projection", async () => {
  const values = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  const store = createWorkspaceLayoutStore(undefined, storage);
  await store.persist.rehydrate();
  const layout = (await import("./workspace-layout-store")).createDefaultLayout();
  values.set(
    "workspace-layout-state",
    JSON.stringify({
      version: 2,
      state: { layoutByWorkspace: { stale: layout } },
      unexpected: true,
    }),
  );
  store.getState().openTab({
    workspaceKey: "server:own",
    target: { kind: "agent", agentId: "own-agent" },
    intent: "reveal",
  });
  expect(
    Object.keys(JSON.parse(values.get("workspace-layout-state")!).state.layoutByWorkspace),
  ).toEqual(["server:own"]);
});

it("commits a queued projection after an asynchronous write rejects", async () => {
  const { createWorkspaceLayoutPersistStorage } =
    await import("./workspace-layout-persist-storage");
  const layout = (await import("./workspace-layout-store")).createDefaultLayout();
  let raw: string | null = JSON.stringify({ version: 2, state: { layoutByWorkspace: {} } });
  let writes = 0;
  let rejectFirst: (error: Error) => void = () => {};
  const adapter = createWorkspaceLayoutPersistStorage({
    getItem: async () => raw,
    setItem: async (_name, value) => {
      if (++writes === 1)
        await new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        });
      raw = value;
    },
    removeItem: () => {},
  });
  await adapter.getItem("workspace-layout-state");
  const first = adapter.setItem("workspace-layout-state", {
    version: 2,
    state: { layoutByWorkspace: { A: layout } },
  });
  const second = adapter.setItem("workspace-layout-state", {
    version: 2,
    state: { layoutByWorkspace: { A: layout, B: layout } },
  });
  const results = Promise.allSettled([first, second]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  rejectFirst(new Error("write failed"));
  expect((await results).map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
  expect(writes).toBe(2);
  expect(Object.keys(JSON.parse(raw!).state.layoutByWorkspace)).toEqual(["A", "B"]);
});

it("pulls an unseen pinned child before entry reconciliation", async () => {
  const values = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  const first = createWorkspaceLayoutStore(undefined, storage);
  const second = createWorkspaceLayoutStore(undefined, storage);
  await first.persist.rehydrate();
  await second.persist.rehydrate();
  second.getState().openTab({
    workspaceKey: "server:C",
    target: { kind: "agent", agentId: "child" },
    intent: "background",
    pin: true,
  });
  await first.getState().activateWorkspace("server:C");
  expect(first.getState().pinnedAgentIdsByWorkspace["server:C"]).toEqual(new Set(["child"]));
  first.getState().reconcileTabs("server:C", {
    agentsHydrated: true,
    terminalsHydrated: true,
    activeAgentIds: ["root", "child"],
    autoOpenAgentIds: ["root"],
    knownTerminalIds: [],
    standaloneTerminalIds: [],
  });
  expect(
    collectAllTabs(first.getState().layoutByWorkspace["server:C"].root).some(
      (tab) => tab.target.kind === "agent" && tab.target.agentId === "child",
    ),
  ).toBe(true);
});

it("preserves another window's latest layout before an inactive background edit", async () => {
  const values = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  const first = createWorkspaceLayoutStore(undefined, storage);
  const second = createWorkspaceLayoutStore(undefined, storage);
  await first.persist.rehydrate();
  await second.persist.rehydrate();
  first.getState().openTab({
    workspaceKey: "server:A",
    target: { kind: "browser", browserId: "latest-browser" },
    intent: "reveal",
  });
  first.getState().openTab({
    workspaceKey: "server:A",
    target: { kind: "file", path: "latest.md" },
    intent: "reveal",
  });
  first.getState().splitPaneEmpty("server:A", { targetPaneId: "main", position: "right" });
  first.getState().resizeExplorerSidebar("server:A", 321);
  first.getState().openTab({
    workspaceKey: "server:A",
    target: { kind: "agent", agentId: "archived" },
    intent: "background",
    pin: true,
  });
  const latest = JSON.parse(values.get("workspace-layout-state")!).state.layoutByWorkspace[
    "server:A"
  ];
  await second.getState().syncWorkspaceFromStorage("server:A");
  second.getState().openTab({
    workspaceKey: "server:A",
    target: { kind: "agent", agentId: "background" },
    intent: "background",
    pin: true,
  });
  const stored = JSON.parse(values.get("workspace-layout-state")!).state;
  expect(stored.explorerSidebarWidthByWorkspace["server:A"]).toBe(321);
  expect(stored.pinnedAgentIdsByWorkspace["server:A"]).toEqual(["archived", "background"]);
  expect(
    collectAllTabs(stored.layoutByWorkspace["server:A"].root).map((tab) => tab.target),
  ).toEqual(
    expect.arrayContaining([
      { kind: "browser", browserId: "latest-browser" },
      { kind: "file", path: "latest.md" },
    ]),
  );
  expect(stored.layoutByWorkspace["server:A"].focusedPaneId).toBe(latest.focusedPaneId);
  const panes = collectAllPanes(stored.layoutByWorkspace["server:A"].root);
  expect(panes).toHaveLength(collectAllPanes(latest.root).length);
  for (const previous of collectAllPanes(latest.root)) {
    const pane = panes.find((candidate) => candidate.id === previous.id)!;
    expect(pane.focusedTabId).toBe(previous.focusedTabId);
    expect(pane.hidden).toBe(previous.hidden);
    expect(pane.tabIds).toEqual(expect.arrayContaining(previous.tabIds));
  }
});

it("keeps active windows independent and preserves parked focus while syncing another workspace", async () => {
  let raw: string | null = null;
  const storage: StateStorage = {
    getItem: () => raw,
    setItem: (_name, value) => {
      raw = value;
    },
    removeItem: () => {
      raw = null;
    },
  };
  const first = createWorkspaceLayoutStore(undefined, storage);
  await first.persist.rehydrate();
  first.getState().openTab({
    workspaceKey: "server:A",
    target: { kind: "agent", agentId: "local" },
    intent: "reveal",
  });
  await first.getState().activateWorkspace("server:A");
  const token = first.getState().unfocusPane("server:A")!;
  const parkedLayout = first.getState().layoutByWorkspace["server:A"];
  const parked = first.getState().focusRestorationByWorkspace["server:A"];
  const second = createWorkspaceLayoutStore(undefined, storage);
  await second.persist.rehydrate();
  second.getState().openTab({
    workspaceKey: "server:A",
    target: { kind: "browser", browserId: "other-window" },
    intent: "reveal",
  });
  second.getState().openTab({
    workspaceKey: "server:B",
    target: { kind: "agent", agentId: "remote" },
    intent: "background",
    pin: true,
  });
  await first.getState().activateWorkspace("server:A");
  await first.getState().syncWorkspaceFromStorage("server:B");
  expect(first.getState().layoutByWorkspace["server:A"]).toBe(parkedLayout);
  expect(first.getState().focusRestorationByWorkspace["server:A"]).toBe(parked);
  expect(first.getState().pinnedAgentIdsByWorkspace["server:B"]).toEqual(new Set(["remote"]));
  first.getState().restorePaneFocus("server:A", token);
  expect(first.getState().layoutByWorkspace["server:A"].focusedPaneId).toBe("main");
});

it("orders async entry reads behind pending writes and keeps local edits across re-entry", async () => {
  let raw: string | null = null;
  let blockNextRead = false;
  let releaseRead: () => void = () => {};
  let readStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const storage: StateStorage = {
    getItem: async () => {
      const snapshot = raw;
      if (blockNextRead) {
        blockNextRead = false;
        readStarted();
        await blocked;
      }
      return snapshot;
    },
    setItem: async (_name, value) => {
      raw = value;
    },
    removeItem: async () => {
      raw = null;
    },
  };
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const first = createWorkspaceLayoutStore(undefined, storage);
  await first.persist.rehydrate();
  first.getState().openTab({
    workspaceKey: "server:A",
    target: { kind: "agent", agentId: "original" },
    intent: "reveal",
  });
  await settle();
  const second = createWorkspaceLayoutStore(undefined, storage);
  await second.persist.rehydrate();
  second.getState().openTab({
    workspaceKey: "server:C",
    target: { kind: "agent", agentId: "remote-child" },
    intent: "background",
    pin: true,
  });
  await settle();
  blockNextRead = true;
  const entering = first.getState().activateWorkspace("server:C");
  await started;
  first.getState().reconcileTabs("server:C", {
    agentsHydrated: true,
    terminalsHydrated: true,
    activeAgentIds: ["root"],
    autoOpenAgentIds: ["root"],
    knownTerminalIds: [],
    standaloneTerminalIds: [],
  });
  expect(first.getState().layoutByWorkspace["server:C"]).toBeUndefined();
  first.getState().setTabState("server:A", "agent_original", { note: "pending.md" });
  const leaving = first.getState().activateWorkspace("server:A");
  const returning = first.getState().activateWorkspace("server:C");
  releaseRead();
  await Promise.all([entering, leaving, returning]);
  await settle();
  expect(first.getState().activeWorkspaceKey).toBe("server:C");
  expect(first.getState().syncingWorkspaceKeys.size).toBe(0);
  const state = JSON.parse(raw!).state;
  expect(JSON.stringify(state.layoutByWorkspace["server:A"])).toContain("pending.md");
  expect(JSON.stringify(state.layoutByWorkspace["server:C"])).toContain("remote-child");
  expect(JSON.stringify(first.getState().layoutByWorkspace["server:C"])).toContain("remote-child");
});

it("loads durable state before sidebar entry restores an inactive parked pane", async () => {
  let raw: string | null = null;
  const storage: StateStorage = {
    getItem: () => raw,
    setItem: (_key, value) => {
      raw = value;
    },
    removeItem: () => {},
  };
  const first = createWorkspaceLayoutStore(undefined, storage);
  await first.persist.rehydrate();
  first.getState().openTab({
    workspaceKey: "server:A",
    target: { kind: "agent", agentId: "old" },
    intent: "reveal",
  });
  first.getState().unfocusPane("server:A");
  await first.getState().activateWorkspace("server:B");
  const second = createWorkspaceLayoutStore(undefined, storage);
  await second.persist.rehydrate();
  second.getState().openTab({
    workspaceKey: "server:A",
    target: { kind: "browser", browserId: "durable" },
    intent: "reveal",
  });
  second.getState().resizeExplorerSidebar("server:A", 345);
  first.getState().focusWorkspace("server:A");
  await first.getState().activateWorkspace("server:A");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(JSON.stringify(first.getState().layoutByWorkspace["server:A"])).toContain("durable");
  expect(JSON.parse(raw!).state.explorerSidebarWidthByWorkspace["server:A"]).toBe(345);
});

it("retains the exact pending open until async entry finishes and consumes only the latest occurrence", async () => {
  let raw: string | null = null;
  let block = false;
  let started: () => void = () => {};
  let release: () => void = () => {};
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const storage: StateStorage = {
    getItem: async () => {
      const snapshot = raw;
      if (block) {
        block = false;
        started();
        await blocked;
      }
      return snapshot;
    },
    setItem: async (_key, value) => {
      raw = value;
    },
    removeItem: () => {},
  };
  const store = createWorkspaceLayoutStore(undefined, storage);
  await store.persist.rehydrate();
  store.getState().setLayoutMode("single-pane");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const request = {
    workspaceKey: "server:C",
    target: { kind: "agent" as const, agentId: "old" },
    intent: "reveal" as const,
  };
  store.getState().deferOpenTab(request);
  block = true;
  const entering = store.getState().activateWorkspace("server:C");
  await reading;
  expect(store.getState().consumePendingOpen("server:C")).toBeNull();
  expect(store.getState().pendingOpenByWorkspace["server:C"]).toBe(request);
  const latest = { ...request, target: { kind: "agent" as const, agentId: "latest" } };
  store.getState().deferOpenTab(latest);
  release();
  await entering;
  expect(store.getState().pendingOpenByWorkspace["server:C"]).toBe(latest);
  expect(store.getState().consumePendingOpen("server:C")).toBe("agent_latest");
  expect(store.getState().consumePendingOpen("server:C")).toBeNull();
  expect(JSON.stringify(store.getState().layoutByWorkspace["server:C"])).not.toContain(
    '"agentId":"old"',
  );
});

it.each(["leave", "new-target", "new-selection"])(
  "cancels delayed sidebar focus and retains pending-open authority after %s",
  async (action) => {
    let raw: string | null = null;
    let block = false;
    let started: () => void = () => {};
    let release: () => void = () => {};
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const storage: StateStorage = {
      getItem: async () => {
        const snapshot = raw;
        if (block) {
          block = false;
          started();
          await blocked;
        }
        return snapshot;
      },
      setItem: async (_key, value) => {
        raw = value;
      },
      removeItem: () => {},
    };
    const store = createWorkspaceLayoutStore(undefined, storage);
    await store.persist.rehydrate();
    store.getState().openTab({
      workspaceKey: "server:C",
      target: { kind: "agent", agentId: "old" },
      intent: "reveal",
    });
    store.getState().unfocusPane("server:C");
    await store.getState().activateWorkspace("server:B");
    const request = {
      workspaceKey: "server:C",
      target: { kind: "agent" as const, agentId: "pending" },
      intent: "reveal" as const,
    };
    store.getState().deferOpenTab(request);
    block = true;
    store.getState().focusWorkspace("server:C");
    await reading;
    const entering = store.getState().activateWorkspace("server:C");
    if (action === "leave") await store.getState().activateWorkspace(null);
    else if (action === "new-target")
      store.getState().openTab({
        workspaceKey: "server:C",
        target: { kind: "browser", browserId: "human" },
        intent: "reveal",
      });
    else store.getState().selectTabInPane("server:C", "main", "agent_old");
    const authoritativeFocus = store.getState().focusRequest;
    release();
    await entering;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.getState().focusRequest).toBe(authoritativeFocus);
    if (action === "leave") {
      expect(selectWorkspaceEntryReady(store.getState(), "server:C")).toBe(false);
      expect(store.getState().pendingOpenByWorkspace["server:C"]).toBe(request);
      expect(store.getState().layoutByWorkspace["server:C"].focusedPaneId).toBeNull();
    } else if (action === "new-target") {
      expect(store.getState().pendingOpenByWorkspace["server:C"]?.target).toEqual({
        kind: "browser",
        browserId: "human",
      });
      expect(store.getState().consumePendingOpen("server:C")).toBe("browser_human");
      expect(store.getState().consumePendingOpen("server:C")).toBeNull();
      const layout = store.getState().layoutByWorkspace["server:C"];
      expect(
        collectAllPanes(layout.root).find((pane) => pane.id === layout.focusedPaneId)?.focusedTabId,
      ).toBe("browser_human");
    } else {
      expect(store.getState().pendingOpenByWorkspace["server:C"]).toBeUndefined();
      expect(store.getState().consumePendingOpen("server:C")).toBeNull();
    }
    expect(JSON.stringify(store.getState().layoutByWorkspace["server:C"])).not.toContain(
      '"agentId":"pending"',
    );
    expect(store.getState().pendingOpenByWorkspace["server:B"]).toBeUndefined();
  },
);

it("keeps durable state and the pending request through a failed sync and permits an explicit retry", async () => {
  let raw: string | null = null;
  let failRead = false;
  const storage: StateStorage = {
    getItem: async () => {
      if (failRead) throw new Error("storage read failed");
      return raw;
    },
    setItem: async (_key, value) => {
      raw = value;
    },
    removeItem: () => {},
  };
  const store = createWorkspaceLayoutStore(undefined, storage);
  await store.persist.rehydrate();
  store.getState().setLayoutMode("single-pane");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const request = {
    workspaceKey: "server:C",
    target: { kind: "agent" as const, agentId: "pending" },
    intent: "reveal" as const,
  };
  store.getState().deferOpenTab(request);
  const before = raw;
  failRead = true;
  await expect(store.getState().activateWorkspace("server:C")).rejects.toThrow(
    "storage read failed",
  );
  expect(selectWorkspaceEntryReady(store.getState(), "server:C")).toBe(false);
  store.getState().reconcileTabs("server:C", {
    agentsHydrated: true,
    terminalsHydrated: true,
    activeAgentIds: ["root"],
    autoOpenAgentIds: ["root"],
    knownTerminalIds: [],
    standaloneTerminalIds: [],
  });
  expect(store.getState().consumePendingOpen("server:C")).toBeNull();
  expect(raw).toBe(before);
  expect(store.getState().pendingOpenByWorkspace["server:C"]).toBe(request);
  failRead = false;
  await store.getState().activateWorkspace("server:C");
  expect(selectWorkspaceEntryReady(store.getState(), "server:C")).toBe(true);
  expect(store.getState().consumePendingOpen("server:C")).toBe("agent_pending");
  expect(store.getState().consumePendingOpen("server:C")).toBeNull();
  await store.getState().activateWorkspace("server:B");
  await store.getState().activateWorkspace("server:C");
  expect(store.getState().pendingOpenByWorkspace).toEqual({});
});

it("defers hydrated foreground navigation until the inactive workspace is synchronized", async () => {
  const { navigateToWorkspace } = await import("./navigation-active-workspace-store/navigation");
  const values = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: () => {},
  };
  const first = createWorkspaceLayoutStore(undefined, storage);
  await first.persist.rehydrate();
  first.getState().openTab({
    workspaceKey: "server:C",
    target: { kind: "agent", agentId: "old" },
    intent: "reveal",
  });
  await first.getState().activateWorkspace("server:B");
  const second = createWorkspaceLayoutStore(undefined, storage);
  await second.persist.rehydrate();
  second.getState().openTab({
    workspaceKey: "server:C",
    target: { kind: "browser", browserId: "durable" },
    intent: "reveal",
  });
  second.getState().resizeExplorerSidebar("server:C", 355);
  const workspace: import("./session-store").WorkspaceDescriptor = {
    id: "C",
    createdAt: null,
    lastUserMessageAt: null,
    projectId: "project",
    projectDisplayName: "Project",
    projectRootPath: "/tmp/project",
    workspaceDirectory: "/tmp/project",
    projectKind: "directory",
    workspaceKind: "directory",
    name: "C",
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
  const reveals: Array<string | null> = [];
  const routes: string[] = [];
  const requested = {
    serverId: "server",
    workspaceId: "C",
    target: { kind: "agent" as const, agentId: "requested" },
    pin: true,
    placement: { mode: "prefer" as const, paneId: "main" },
  };
  navigateToWorkspace(requested, {
    getSessionWorkspaces: () => new Map([["C", workspace]]),
    isWorkspaceLayoutHydrated: () => first.persist.hasHydrated(),
    openTab: (input) => first.getState().openTab(input),
    deferOpenTab: (input) => first.getState().deferOpenTab(input),
    revealWorkspace: (key) => first.getState().focusWorkspace(key),
    revealTab: (_key, id) => {
      reveals.push(id);
    },
    rememberLastWorkspace: () => {},
    navigateToRoute: (route) => {
      routes.push(route);
    },
  });
  expect(reveals).toEqual([null]);
  expect(routes).toEqual(["/h/server/workspace/C"]);
  const pending = first.getState().pendingOpenByWorkspace["server:C"];
  expect(pending).toEqual({
    workspaceKey: "server:C",
    target: requested.target,
    pin: true,
    intent: "reveal",
    placement: requested.placement,
  });
  await first.getState().activateWorkspace("server:C");
  expect(JSON.stringify(first.getState().layoutByWorkspace["server:C"])).toContain("durable");
  expect(first.getState().pendingOpenByWorkspace["server:C"]).toBe(pending);
  expect(first.getState().consumePendingOpen("server:C")).toBe("agent_requested");
  expect(first.getState().consumePendingOpen("server:C")).toBeNull();
  expect(
    JSON.parse(values.get("workspace-layout-state")!).state.explorerSidebarWidthByWorkspace[
      "server:C"
    ],
  ).toBe(355);
  expect(
    first.getState().openTab({
      workspaceKey: "server:C",
      target: { kind: "file", path: "active.md" },
      intent: "new",
    }),
  ).toBeTypeOf("string");
});

it("keeps a newer complete foreground request through failed synchronization without stale writes", async () => {
  let raw: string | null = null;
  let failRead = false;
  const storage: StateStorage = {
    getItem: async () => {
      if (failRead) throw new Error("read failed");
      return raw;
    },
    setItem: async (_key, value) => {
      raw = value;
    },
    removeItem: () => {},
  };
  const store = createWorkspaceLayoutStore(undefined, storage);
  await store.persist.rehydrate();
  store.getState().setLayoutMode("single-pane");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await store.getState().activateWorkspace("server:B");
  const before = raw;
  failRead = true;
  const old = {
    workspaceKey: "server:C",
    target: { kind: "agent" as const, agentId: "old" },
    intent: "reveal" as const,
  };
  expect(store.getState().openTab(old)).toBeNull();
  await expect(store.getState().syncWorkspaceFromStorage("server:C")).rejects.toThrow(
    "read failed",
  );
  const latest = {
    workspaceKey: "server:C",
    target: { kind: "draft" as const, draftId: "created-draft" },
    intent: "new" as const,
    placement: { mode: "prefer" as const, paneId: "main" },
    state: { submitted: false, text: "keep full request" },
    parentTabId: "agent_parent",
    insertionPosition: { afterTabId: "agent_parent" },
  };
  expect(store.getState().openTab(latest)).toBeNull();
  await expect(store.getState().syncWorkspaceFromStorage("server:C")).rejects.toThrow(
    "read failed",
  );
  expect(store.getState().pendingOpenByWorkspace["server:C"]).toBe(latest);
  expect(store.getState().consumePendingOpen("server:C")).toBeNull();
  expect(raw).toBe(before);
  failRead = false;
  await store.getState().activateWorkspace("server:C");
  const tabId = store.getState().consumePendingOpen("server:C");
  expect(tabId).toBeTypeOf("string");
  const tab = collectAllTabs(store.getState().layoutByWorkspace["server:C"].root).find(
    (candidate) => candidate.tabId === tabId,
  )!;
  expect(tab.target).toEqual(latest.target);
  expect(tab.state).toEqual(latest.state);
  expect(store.getState().consumePendingOpen("server:C")).toBeNull();
  expect(JSON.stringify(store.getState().layoutByWorkspace["server:C"])).not.toContain(
    '"agentId":"old"',
  );
});

it("round-trips a parent-scoped BTW tab and retains it through descriptor absence", async () => {
  const values = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
  const store = createWorkspaceLayoutStore(undefined, storage);
  await store.persist.rehydrate();
  const workspaceKey = "host:workspace";
  store
    .getState()
    .openTab({ workspaceKey, target: { kind: "agent", agentId: "parent" }, intent: "reveal" });
  const tabId = store
    .getState()
    .openTab({ workspaceKey, target: { kind: "btw", agentId: "parent" }, intent: "reveal" });
  const restored = createWorkspaceLayoutStore(undefined, storage);
  await restored.persist.rehydrate();
  expect(collectAllTabs(restored.getState().layoutByWorkspace[workspaceKey].root)).toContainEqual(
    expect.objectContaining({ tabId, target: { kind: "btw", agentId: "parent" } }),
  );
  restored.getState().reconcileTabs(workspaceKey, {
    agentsHydrated: true,
    terminalsHydrated: true,
    activeAgentIds: ["parent"],
    autoOpenAgentIds: [],
    knownTerminalIds: [],
    standaloneTerminalIds: [],
  });
  expect(
    collectAllTabs(restored.getState().layoutByWorkspace[workspaceKey].root).some(
      (tab) => tab.tabId === tabId,
    ),
  ).toBe(true);
});
