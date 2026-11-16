/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { PaneFocusProvider, createPaneFocusContextValue } from "@/panels/pane-context";
import {
  collectAllTabs,
  findPaneContainingTab,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { useProviderSubagentStore } from "@/subagents/provider-store";
import { BtwPill } from "./pill";
import { selectBtwTab } from "./tab";

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
afterEach(cleanup);
function mount() {
  return render(
    <PaneFocusProvider
      value={createPaneFocusContextValue({ isWorkspaceFocused: true, isPaneFocused: false })}
    >
      <BtwPill serverId="host" workspaceId="workspace" agentId="parent" />
    </PaneFocusProvider>,
  );
}
test("hidden -> open beside and visible -> close leave conversation running", () => {
  mount();
  const chip = screen.getByTestId("btw-chip");
  const initialTabs = collectAllTabs(
    useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
  ).map(({ tabId, target }) => ({ tabId, target }));
  expect(chip.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(chip);
  expect(selectBtwTab(useWorkspaceLayoutStore.getState(), workspaceKey, "parent")).toMatchObject({
    tabId: "btw_parent",
    visible: true,
  });
  expect(chip.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(chip);
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
  mount();
  expect(screen.getByTestId("btw-chip").getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(screen.getByTestId("btw-chip"));
  expect(selectBtwTab(useWorkspaceLayoutStore.getState(), workspaceKey, "parent")?.visible).toBe(
    true,
  );
  expect(useWorkspaceLayoutStore.getState().sidePaneIdByWorkspace[workspaceKey]).toBeFalsy();
});
test("absent extension has no chip; compact toggles the workspace sheet", () => {
  useWorkspaceLayoutStore.getState().setLayoutMode("compact");
  mount();
  fireEvent.click(screen.getByTestId("btw-chip"));
  expect(useWorkspaceLayoutStore.getState().sheetsByWorkspace[workspaceKey]).toHaveLength(1);
  fireEvent.click(screen.getByTestId("btw-chip"));
  expect(useWorkspaceLayoutStore.getState().sheetsByWorkspace[workspaceKey] ?? []).toHaveLength(0);
  act(() => useProviderSubagentStore.getState().replaceList("host", "parent", []));
  expect(screen.queryByTestId("btw-chip")).toBeNull();
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
  mount();
  expect(screen.getByTestId("btw-chip").getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(screen.getByTestId("btw-chip"));
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
  mount();
  expect(screen.getByTestId("btw-chip").getAttribute("aria-expanded")).toBe("true");
  act(() => store.hideExplorerSidebar(workspaceKey));
  expect(screen.getByTestId("btw-chip").getAttribute("aria-expanded")).toBe("false");
  act(() => store.showExplorerSidebar(workspaceKey));
  expect(screen.getByTestId("btw-chip").getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByTestId("btw-chip"));
  expect(selectBtwTab(useWorkspaceLayoutStore.getState(), workspaceKey, "parent")).toBeNull();
});
