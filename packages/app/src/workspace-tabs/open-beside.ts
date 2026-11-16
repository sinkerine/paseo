import { revealWorkspaceTab } from "./navigation";
import type { OpenInSidePanePreferences } from "@/hooks/use-settings";
import {
  collectAllTabs,
  collectAllPanes,
  DEFAULT_PANE_ID,
  findPaneById,
  findPaneContainingTab,
  selectSheetTab,
  useWorkspaceLayoutStore,
  type WorkspaceTabPlacement,
} from "@/stores/workspace-layout-store";
import { getPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { workspaceTabTargetsEqual } from "@/workspace-tabs/identity";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

export type OpenInSidePaneSource = keyof OpenInSidePanePreferences;
export type WorkspaceTargetOpenLocation = "main" | "side";

interface OpenWorkspaceTargetInput {
  workspaceKey: string | null;
  target: WorkspaceTabTarget;
  parentTabId?: string | null;
}

export interface OpenPreferredWorkspaceTargetInput extends OpenWorkspaceTargetInput {
  source: OpenInSidePaneSource;
  preferences: OpenInSidePanePreferences;
}

interface OpenWorkspaceTargetAtLocationInput extends OpenWorkspaceTargetInput {
  location: WorkspaceTargetOpenLocation;
}

interface OpenPreferredWorkspacePreviewInput extends OpenPreferredWorkspaceTargetInput {
  serverId: string;
  workspaceId: string;
  explorerSidebarPaneId: string | null;
  lastMainPaneId: string | null;
}

/** A side pane exists only where the workspace renders split panes. */
function canOpenBeside(): boolean {
  return useWorkspaceLayoutStore.getState().layoutMode === "split-panes";
}

function resolveMainPane(input: {
  workspaceKey: string;
  explorerSidebarPaneId: string | null;
  lastMainPaneId: string | null;
}) {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[input.workspaceKey];
  if (!layout) return null;
  const panes = collectAllPanes(layout.root);
  return (
    panes.find(
      (pane) =>
        pane.id === input.lastMainPaneId &&
        pane.id !== input.explorerSidebarPaneId &&
        pane.hidden !== true,
    ) ??
    panes.find((pane) => pane.id === DEFAULT_PANE_ID && pane.hidden !== true) ??
    panes.find((pane) => pane.id !== input.explorerSidebarPaneId && pane.hidden !== true) ??
    null
  );
}

function canReplacePreview(input: {
  serverId: string;
  workspaceId: string;
  tabId: string;
  currentTarget: WorkspaceTabTarget;
  nextTarget: WorkspaceTabTarget;
}): boolean {
  if (input.nextTarget.kind === "working_diff") {
    return input.currentTarget.kind === "working_diff";
  }
  return (
    input.nextTarget.kind === "file" &&
    input.currentTarget.kind === "file" &&
    !getPanelInstanceAttributes({
      serverId: input.serverId,
      workspaceId: input.workspaceId,
      tabId: input.tabId,
    }).modified
  );
}

/** Opens an implicit target according to its source-specific desktop preference. */
export function openPreferredWorkspaceTarget(
  input: OpenPreferredWorkspaceTargetInput,
): string | null {
  return openWorkspaceTargetAtLocation({
    workspaceKey: input.workspaceKey,
    target: input.target,
    location: input.preferences[input.source] ? "side" : "main",
    parentTabId: input.parentTabId,
  });
}

/** Opens an implicit target at the user's preferred main or side location. */
export function openWorkspaceTargetAtLocation(
  input: OpenWorkspaceTargetAtLocationInput,
): string | null {
  if (!input.workspaceKey) return null;
  const store = useWorkspaceLayoutStore.getState();
  const layout = store.layoutByWorkspace[input.workspaceKey];
  const targetAlreadyExists = Boolean(
    layout &&
    collectAllTabs(layout.root).some((tab) => workspaceTabTargetsEqual(tab.target, input.target)),
  );
  const shouldOpenBeside = canOpenBeside() && input.location === "side";
  let placement: WorkspaceTabPlacement | undefined;
  if (shouldOpenBeside && !targetAlreadyExists) {
    const paneId = store.ensureSidePane(input.workspaceKey);
    placement = paneId ? { mode: "prefer", paneId } : undefined;
  } else if (!shouldOpenBeside && layout && input.parentTabId) {
    // A target opened from a tab belongs in that tab's pane, whichever pane has focus.
    const parentPane = findPaneContainingTab(layout.root, input.parentTabId);
    placement = parentPane ? { mode: "prefer", paneId: parentPane.id } : undefined;
  }
  return revealWorkspaceTab(
    input.workspaceKey,
    store.openTab({
      workspaceKey: input.workspaceKey,
      target: input.target,
      intent: "reveal",
      placement,
      parentTabId: input.parentTabId ?? undefined,
    }),
  );
}

/**
 * Shows supporting content without moving workspace focus. Existing tabs stay where the user
 * placed them; a focused pane keeps its current selection. Compact uses the sheet policy and
 * single-pane layouts keep a new tab in the background.
 */
export function showWorkspaceTargetBeside(input: {
  workspaceKey: string | null;
  target: WorkspaceTabTarget;
}): string | null {
  const workspaceKey = input.workspaceKey;
  if (!workspaceKey) return null;
  const store = useWorkspaceLayoutStore.getState();
  const layout = store.layoutByWorkspace[workspaceKey];
  const existing =
    layout &&
    collectAllTabs(layout.root).find((tab) => workspaceTabTargetsEqual(tab.target, input.target));
  if (existing) {
    const pane = findPaneContainingTab(layout.root, existing.tabId);
    if (store.layoutMode === "split-panes" && pane && pane.id !== layout.focusedPaneId) {
      store.selectTabInPane(workspaceKey, pane.id, existing.tabId, { focus: false });
    }
    return existing.tabId;
  }
  if (store.layoutMode === "compact") {
    return store.openTab({ workspaceKey, target: input.target, intent: "reveal" });
  }
  const paneId =
    store.layoutMode === "split-panes"
      ? store.ensureSidePane(workspaceKey, { focus: false })
      : null;
  const tabId = store.openTab({
    workspaceKey,
    target: input.target,
    intent: "background",
    placement: paneId ? { mode: "prefer", paneId } : undefined,
  });
  const next = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  const pane = tabId && next ? findPaneContainingTab(next.root, tabId) : null;
  if (store.layoutMode === "split-panes" && pane && pane.id !== next.focusedPaneId && tabId) {
    store.selectTabInPane(workspaceKey, pane.id, tabId, { focus: false });
  }
  return tabId;
}

/** Opens a tree selection while reusing an unmodified preview in its destination pane. */
export function openPreferredWorkspacePreview(
  input: OpenPreferredWorkspacePreviewInput,
): string | null {
  if (!input.workspaceKey) return null;
  const store = useWorkspaceLayoutStore.getState();
  const layout = store.layoutByWorkspace[input.workspaceKey];
  if (!layout) return null;
  const existing = collectAllTabs(layout.root).some((tab) =>
    workspaceTabTargetsEqual(tab.target, input.target),
  );
  // The sheet is already a single replaceable slot, so it needs no preview tab.
  if (
    existing ||
    selectSheetTab(store, { workspaceKey: input.workspaceKey, target: input.target }) !== null
  ) {
    return openPreferredWorkspaceTarget(input);
  }

  const mainPane = resolveMainPane({
    workspaceKey: input.workspaceKey,
    explorerSidebarPaneId: input.explorerSidebarPaneId,
    lastMainPaneId: input.lastMainPaneId,
  });
  const destinationPaneId =
    canOpenBeside() && input.preferences[input.source]
      ? store.ensureSidePane(input.workspaceKey)
      : mainPane?.id;
  if (!destinationPaneId) return null;
  const nextLayout = useWorkspaceLayoutStore.getState().layoutByWorkspace[input.workspaceKey];
  const destinationPane = nextLayout ? findPaneById(nextLayout.root, destinationPaneId) : null;
  const activeTab = nextLayout
    ? collectAllTabs(nextLayout.root).find((tab) => tab.tabId === destinationPane?.focusedTabId)
    : null;
  if (
    activeTab &&
    canReplacePreview({
      serverId: input.serverId,
      workspaceId: input.workspaceId,
      tabId: activeTab.tabId,
      currentTarget: activeTab.target,
      nextTarget: input.target,
    })
  ) {
    return revealWorkspaceTab(
      input.workspaceKey,
      store.replaceTab(input.workspaceKey, activeTab.tabId, input.target),
    );
  }
  return revealWorkspaceTab(
    input.workspaceKey,
    store.openTab({
      workspaceKey: input.workspaceKey,
      target: input.target,
      intent: "reveal",
      placement: { mode: "pane", paneId: destinationPaneId },
      parentTabId: input.parentTabId ?? activeTab?.tabId ?? undefined,
    }),
  );
}

/**
 * Explicit Open to Side: creates the side pane and places the target there. Without split panes
 * the target opens like any other.
 */
export function openWorkspaceTargetBeside(input: OpenWorkspaceTargetInput): string | null {
  if (!input.workspaceKey) return null;
  if (!canOpenBeside()) {
    return openWorkspaceTargetAtLocation({ ...input, location: "main" });
  }
  const store = useWorkspaceLayoutStore.getState();
  const paneId = store.ensureSidePane(input.workspaceKey);
  return revealWorkspaceTab(
    input.workspaceKey,
    store.openTab({
      workspaceKey: input.workspaceKey,
      target: input.target,
      intent: "reveal",
      placement: paneId ? { mode: "pane", paneId } : undefined,
      parentTabId: input.parentTabId ?? undefined,
    }),
  );
}
