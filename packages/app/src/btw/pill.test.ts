import { beforeEach, expect, test } from "vitest";
import {
  collectAllTabs,
  findPaneContainingTab,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { useProviderSubagentStore } from "@/subagents/provider-store";
import { selectBtwTab, toggleBtwTab } from "./tab";

const workspaceKey = "host:workspace";
beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutMode: "split-panes",
    layoutByWorkspace: {},
    sheetsByWorkspace: {},
    sidePaneIdByWorkspace: {},
    focusRequest: null,
  });
  useWorkspaceLayoutStore
    .getState()
    .openTab({ workspaceKey, target: { kind: "agent", agentId: "parent" }, intent: "reveal" });
  useProviderSubagentStore.getState().replaceList("host", "parent", [
    {
      id: "thread",
      parentAgentId: "parent",
      provider: "pi",
      presentation: "side_conversation",
      title: "Question",
      description: null,
      status: "running",
      hasTimeline: false,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      toolCallId: null,
    },
  ]);
});
function toggle() {
  toggleBtwTab({ workspaceKey, agentId: "parent" });
}
function expanded() {
  return selectBtwTab(useWorkspaceLayoutStore.getState(), workspaceKey, "parent")?.visible === true;
}
test("hidden -> open beside and visible -> close leave conversation running", () => {
  const initialTabs = collectAllTabs(
    useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
  ).map(({ tabId, target }) => ({ tabId, target }));
  expect(expanded()).toBe(false);
  toggle();
  expect(selectBtwTab(useWorkspaceLayoutStore.getState(), workspaceKey, "parent")).toMatchObject({
    tabId: "btw_parent",
    visible: true,
  });
  expect(expanded()).toBe(true);
  toggle();
  expect(selectBtwTab(useWorkspaceLayoutStore.getState(), workspaceKey, "parent")).toBeNull();
  expect(
    collectAllTabs(useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root).map(
      ({ tabId, target }) => ({ tabId, target }),
    ),
  ).toEqual(initialTabs);
  expect([...useProviderSubagentStore.getState().descriptors.values()][0].status).toBe("running");
});
test("present-but-unselected -> reveal keeps the tab where the user placed it", () => {
  const store = useWorkspaceLayoutStore.getState();
  store.openTab({ workspaceKey, target: { kind: "btw", agentId: "parent" }, intent: "background" });
  expect(expanded()).toBe(false);
  toggle();
  expect(selectBtwTab(useWorkspaceLayoutStore.getState(), workspaceKey, "parent")?.visible).toBe(
    true,
  );
  expect(useWorkspaceLayoutStore.getState().sidePaneIdByWorkspace[workspaceKey]).toBeFalsy();
});
test("absent extension has no chip; compact toggles the workspace sheet", () => {
  useWorkspaceLayoutStore.getState().setLayoutMode("compact");
  toggle();
  expect(useWorkspaceLayoutStore.getState().sheetsByWorkspace[workspaceKey]).toHaveLength(1);
  toggle();
  expect(useWorkspaceLayoutStore.getState().sheetsByWorkspace[workspaceKey] ?? []).toHaveLength(0);
  useProviderSubagentStore.getState().replaceList("host", "parent", []);
  expect([...useProviderSubagentStore.getState().descriptors.values()]).toEqual([]);
});

test("single-pane chip reveals a retained ordinary split rather than closing it", () => {
  const store = useWorkspaceLayoutStore.getState();
  const main = store.layoutByWorkspace[workspaceKey].focusedPaneId;
  const side = store.ensureSidePane(workspaceKey, { focus: false });
  if (!side) throw new Error("Expected side pane");
  store.openTab({
    workspaceKey,
    target: { kind: "btw", agentId: "parent" },
    intent: "background",
    placement: { mode: "pane", paneId: side },
  });
  store.selectTabInPane(workspaceKey, side, "btw_parent", { focus: false });
  store.setLayoutMode("single-pane");
  expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].focusedPaneId).toBe(
    main,
  );
  expect(expanded()).toBe(false);
  toggle();
  expect(selectBtwTab(useWorkspaceLayoutStore.getState(), workspaceKey, "parent")).toEqual({
    tabId: "btw_parent",
    visible: true,
  });
  expect(
    findPaneContainingTab(
      useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
      "btw_parent",
    )?.id,
  ).toBe(side);
});

test("single-pane chip recognizes the visible Explorer beside the focused main pane", () => {
  const store = useWorkspaceLayoutStore.getState();
  store.setLayoutMode("single-pane");
  const explorer = store.showExplorerSidebar(workspaceKey);
  if (!explorer) throw new Error("Expected Explorer pane");
  store.openTab({
    workspaceKey,
    target: { kind: "btw", agentId: "parent" },
    intent: "reveal",
    placement: { mode: "pane", paneId: explorer },
  });
  expect(expanded()).toBe(true);
  store.hideExplorerSidebar(workspaceKey);
  expect(expanded()).toBe(false);
  store.showExplorerSidebar(workspaceKey);
  expect(expanded()).toBe(true);
  toggle();
  expect(selectBtwTab(useWorkspaceLayoutStore.getState(), workspaceKey, "parent")).toBeNull();
});
