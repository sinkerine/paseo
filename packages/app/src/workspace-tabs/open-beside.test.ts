import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { DEFAULT_APP_SETTINGS } from "@/hooks/use-settings";
import { setPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import {
  collectAllPanes,
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import {
  openPreferredWorkspacePreview,
  openPreferredWorkspaceTarget,
  openWorkspaceTargetBeside,
  showWorkspaceTargetBeside,
} from "@/workspace-tabs/open-beside";

const WORKSPACE_KEY = "server-1:workspace-1";

beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutMode: "split-panes",
    sheetsByWorkspace: {},
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
  });
});

describe("openPreferredWorkspacePreview", () => {
  it("opens a compact file preview in the sheet instead of replacing the active file tab", () => {
    const store = useWorkspaceLayoutStore.getState();
    const fileTabId = store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "file", path: "src/open.ts" },
      intent: "reveal",
    });
    store.setLayoutMode("compact");

    const tabId = openPreferredWorkspacePreview({
      workspaceKey: WORKSPACE_KEY,
      serverId: "server-1",
      workspaceId: "workspace-1",
      explorerSidebarPaneId: "explorer",
      lastMainPaneId: "main",
      target: { kind: "file", path: "src/preview.ts" },
      source: "explorerFiles",
      preferences: DEFAULT_APP_SETTINGS.openInSidePane,
    });

    const state = useWorkspaceLayoutStore.getState();
    expect(state.sheetsByWorkspace[WORKSPACE_KEY]?.at(-1)?.tab).toMatchObject({
      tabId,
      target: { kind: "file", path: "src/preview.ts" },
    });
    const root = state.layoutByWorkspace[WORKSPACE_KEY].root;
    expect(findPaneById(root, "main")?.tabIds).toEqual([fileTabId]);
    expect(collectAllTabs(root).find((tab) => tab.tabId === fileTabId)?.target).toEqual({
      kind: "file",
      path: "src/open.ts",
    });
  });
});

describe("previews under a sheet with unsaved work", () => {
  const sheetTarget = { kind: "file" as const, path: "src/draft.ts" };
  let sheetTabId: string | null = null;

  afterEach(() => {
    if (sheetTabId) {
      setPanelInstanceAttributes(
        { serverId: "server-1", workspaceId: "workspace-1", tabId: sheetTabId },
        { modified: false },
      );
    }
    sheetTabId = null;
  });

  function previewFile(path: string): string | null {
    return openPreferredWorkspacePreview({
      workspaceKey: WORKSPACE_KEY,
      serverId: "server-1",
      workspaceId: "workspace-1",
      explorerSidebarPaneId: "explorer",
      lastMainPaneId: "main",
      target: { kind: "file", path },
      source: "explorerFiles",
      preferences: DEFAULT_APP_SETTINGS.openInSidePane,
    });
  }

  it("stacks link previews over the sheet instead of dropping its unsaved work", () => {
    const store = useWorkspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "terminal", terminalId: "term-1" },
      intent: "reveal",
    });
    store.setLayoutMode("compact");
    sheetTabId = store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: sheetTarget,
      intent: "reveal",
    });
    setPanelInstanceAttributes(
      { serverId: "server-1", workspaceId: "workspace-1", tabId: sheetTabId ?? "" },
      { modified: true },
    );

    previewFile("src/first.ts");
    previewFile("src/second.ts");

    const state = useWorkspaceLayoutStore.getState();
    expect(state.sheetsByWorkspace[WORKSPACE_KEY]?.map((sheet) => sheet.tab.target)).toEqual([
      sheetTarget,
      { kind: "file", path: "src/first.ts" },
      { kind: "file", path: "src/second.ts" },
    ]);
    const root = state.layoutByWorkspace[WORKSPACE_KEY].root;
    expect(findPaneById(root, "main")?.tabIds).toHaveLength(1);
  });
});

describe("opening beside", () => {
  const sidePreference = { ...DEFAULT_APP_SETTINGS.openInSidePane, subagents: true };

  function openSubagentWithSidePreference(): string | null {
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "file", path: "src/open.ts" },
      intent: "reveal",
    });
    return openPreferredWorkspaceTarget({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "file", path: "src/subagent.ts" },
      source: "subagents",
      preferences: sidePreference,
    });
  }

  function paneIdHolding(tabId: string | null): string | undefined {
    const root = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY].root;
    return collectAllPanes(root).find((pane) => pane.tabIds.includes(tabId ?? ""))?.id;
  }

  it("follows the side preference where the workspace renders split panes", () => {
    useWorkspaceLayoutStore.getState().setLayoutMode("split-panes");

    const tabId = openSubagentWithSidePreference();

    const sidePaneId = useWorkspaceLayoutStore.getState().sidePaneIdByWorkspace[WORKSPACE_KEY];
    expect(sidePaneId).toEqual(expect.any(String));
    expect(paneIdHolding(tabId)).toBe(sidePaneId);
  });

  it("keeps a single-pane workspace in one pane despite the side preference", () => {
    useWorkspaceLayoutStore.getState().setLayoutMode("single-pane");

    const preferredTabId = openSubagentWithSidePreference();
    const besideTabId = openWorkspaceTargetBeside({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "file", path: "src/beside.ts" },
    });

    expect(useWorkspaceLayoutStore.getState().sidePaneIdByWorkspace[WORKSPACE_KEY]).toBeFalsy();
    expect(paneIdHolding(preferredTabId)).toBe("main");
    expect(paneIdHolding(besideTabId)).toBe("main");
  });
});

describe("showWorkspaceTargetBeside", () => {
  const target = { kind: "btw", agentId: "parent" } as const;
  function setup() {
    const store = useWorkspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "agent", agentId: "parent" },
      intent: "reveal",
    });
    useWorkspaceLayoutStore.setState({ focusRequest: null });
    return store;
  }
  function show() {
    return showWorkspaceTargetBeside({ workspaceKey: WORKSPACE_KEY, target });
  }
  function paneFor(tabId: string | null) {
    const root = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY].root;
    return collectAllPanes(root).find((pane) => pane.tabIds.includes(tabId ?? ""));
  }
  it("new side pane without focus", () => {
    setup();
    const focused =
      useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY].focusedPaneId;
    const tabId = show();
    const state = useWorkspaceLayoutStore.getState();
    expect(paneFor(tabId)?.id).toBe(state.sidePaneIdByWorkspace[WORKSPACE_KEY]);
    expect(paneFor(tabId)?.focusedTabId).toBe(tabId);
    expect(state.layoutByWorkspace[WORKSPACE_KEY].focusedPaneId).toBe(focused);
    expect(state.focusRequest).toBeNull();
  });
  it("reuses side pane and selects without focus", () => {
    const store = setup();
    const side = store.ensureSidePane(WORKSPACE_KEY, { focus: false });
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "file", path: "other.md" },
      intent: "background",
      placement: { mode: "prefer", paneId: side ?? "" },
    });
    useWorkspaceLayoutStore.setState({ focusRequest: null });
    const id = show();
    expect(paneFor(id)?.id).toBe(side);
    expect(paneFor(id)?.focusedTabId).toBe(id);
    expect(useWorkspaceLayoutStore.getState().focusRequest).toBeNull();
  });
  it("leaves an existing tab in its pane", () => {
    const store = setup();
    const id = store.openTab({ workspaceKey: WORKSPACE_KEY, target, intent: "background" });
    const pane = paneFor(id)?.id;
    show();
    expect(paneFor(id)?.id).toBe(pane);
    expect(
      collectAllPanes(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY].root),
    ).toHaveLength(1);
  });
  it("does not select over the focused pane", () => {
    const store = setup();
    const id = store.openTab({ workspaceKey: WORKSPACE_KEY, target, intent: "background" });
    const pane = paneFor(id);
    const focused = pane?.focusedTabId;
    show();
    expect(paneFor(id)?.focusedTabId).toBe(focused);
    expect(useWorkspaceLayoutStore.getState().focusRequest).toBeNull();
  });
  it("compact reveals the sheet and keeps an existing pane tab", () => {
    const store = setup();
    store.setLayoutMode("compact");
    const id = show();
    expect(
      useWorkspaceLayoutStore.getState().sheetsByWorkspace[WORKSPACE_KEY]?.at(-1)?.tab.tabId,
    ).toBe(id);
    store.closeTab(WORKSPACE_KEY, id ?? "");
    store.setLayoutMode("split-panes");
    const paneTab = show();
    const pane = paneFor(paneTab)?.id;
    store.setLayoutMode("compact");
    show();
    expect(paneFor(paneTab)?.id).toBe(pane);
    expect(useWorkspaceLayoutStore.getState().sheetsByWorkspace[WORKSPACE_KEY] ?? []).toHaveLength(
      0,
    );
  });
  it("single-pane opens in the background in the main pane", () => {
    const store = setup();
    store.setLayoutMode("single-pane");
    const before = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    const selected = findPaneById(before.root, before.focusedPaneId)?.focusedTabId;
    const id = show();
    const state = useWorkspaceLayoutStore.getState();
    expect(paneFor(id)?.id).toBe("main");
    expect(paneFor(id)?.focusedTabId).toBe(selected);
    expect(state.focusRequest).toBeNull();
  });
  it("ignores a missing workspace", () => {
    expect(showWorkspaceTargetBeside({ workspaceKey: null, target })).toBeNull();
  });
});
