import {
  collectAllTabs,
  findPaneContainingTab,
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
  type WorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { openWorkspaceTargetAtLocation } from "@/workspace-tabs/open-beside";

export function btwTabTarget(agentId: string): { kind: "btw"; agentId: string } {
  return { kind: "btw", agentId };
}
export function selectBtwTab(
  state: Pick<
    WorkspaceLayoutStore,
    "layoutMode" | "layoutByWorkspace" | "sheetsByWorkspace" | "explorerSidebarPaneIdByWorkspace"
  >,
  workspaceKey: string,
  agentId: string,
): { tabId: string; visible: boolean } | null {
  const sheet = state.sheetsByWorkspace[workspaceKey]?.find(
    (item) => item.tab.target.kind === "btw" && item.tab.target.agentId === agentId,
  );
  if (sheet) return { tabId: sheet.tab.tabId, visible: true };
  const layout = state.layoutByWorkspace[workspaceKey];
  if (!layout) return null;
  const tab = collectAllTabs(layout.root).find(
    (item) => item.target.kind === "btw" && item.target.agentId === agentId,
  );
  if (!tab) return null;
  const pane = findPaneContainingTab(layout.root, tab.tabId);
  const shown =
    state.layoutMode === "split-panes" ||
    pane?.id === layout.focusedPaneId ||
    (state.layoutMode === "single-pane" &&
      pane?.id === selectExplorerSidebarPaneId(state, workspaceKey));
  return {
    tabId: tab.tabId,
    visible: !!pane && pane.hidden !== true && pane.focusedTabId === tab.tabId && shown,
  };
}
export function toggleBtwTab(input: { workspaceKey: string | null; agentId: string }): void {
  if (!input.workspaceKey) return;
  const store = useWorkspaceLayoutStore.getState();
  const tab = selectBtwTab(store, input.workspaceKey, input.agentId);
  if (tab?.visible) store.closeTab(input.workspaceKey, tab.tabId);
  else
    openWorkspaceTargetAtLocation({
      ...input,
      target: btwTabTarget(input.agentId),
      location: "side",
    });
}
