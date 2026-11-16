import { useEffect } from "react";
import { getDesktopHost, type DesktopBrowserNewTabRequestEvent } from "@/desktop/host";
import {
  collectAllTabs,
  collectAllPanes,
  useWorkspaceLayoutStore,
  getFocusedBrowserId,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import { AMBIENT_PLACEMENT, FOCUSED_PANE_PLACEMENT } from "@/stores/workspace-layout-actions";
import { getIsElectron } from "@/constants/platform";
import { useStableEvent } from "@/hooks/use-stable-event";

export type BrowserNewTabRequest = DesktopBrowserNewTabRequestEvent;

function isAllowedBrowserNewTabUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.href === "about:blank"
    );
  } catch {
    return false;
  }
}

function readDesktopBrowserNewTabRequest(payload: unknown): BrowserNewTabRequest | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const candidate = payload as Partial<BrowserNewTabRequest>;
  if (typeof candidate.sourceBrowserId !== "string" || !candidate.sourceBrowserId.trim()) {
    return null;
  }
  if (typeof candidate.url !== "string" || !isAllowedBrowserNewTabUrl(candidate.url)) {
    return null;
  }
  return {
    sourceBrowserId: candidate.sourceBrowserId,
    url: candidate.url,
    ...(candidate.background === true ? { background: true } : {}),
  };
}

function workspaceContainsBrowser(input: {
  workspaceLayout: WorkspaceLayout | null | undefined;
  browserId: string;
}): boolean {
  if (!input.workspaceLayout) {
    return false;
  }
  return collectAllTabs(input.workspaceLayout.root).some((tab) => {
    return tab.target.kind === "browser" && tab.target.browserId === input.browserId;
  });
}

export function resolveBrowserNewTabRequest(input: {
  payload: unknown;
  workspaceLayout: WorkspaceLayout | null | undefined;
}): BrowserNewTabRequest | null {
  const request = readDesktopBrowserNewTabRequest(input.payload);
  if (!request) {
    return null;
  }
  if (
    !workspaceContainsBrowser({
      workspaceLayout: input.workspaceLayout,
      browserId: request.sourceBrowserId,
    })
  ) {
    return null;
  }
  return request;
}

export function shouldFocusBrowserNewTabRequest(input: {
  request: BrowserNewTabRequest;
  workspaceLayout: WorkspaceLayout | null | undefined;
  isRouteFocused: boolean;
}): boolean {
  return (
    !input.request.background &&
    input.isRouteFocused &&
    getFocusedBrowserId(input.workspaceLayout ?? null) === input.request.sourceBrowserId
  );
}

export function openBrowserNewTabRequest(input: {
  request: BrowserNewTabRequest;
  workspaceKey: string;
  isRouteFocused: boolean;
  createBrowser: (url: string) => string;
}): void {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[input.workspaceKey];
  const focus = shouldFocusBrowserNewTabRequest({
    request: input.request,
    workspaceLayout: layout,
    isRouteFocused: input.isRouteFocused,
  });
  const sourceTab =
    layout &&
    collectAllTabs(layout.root).find(
      (tab) =>
        tab.target.kind === "browser" && tab.target.browserId === input.request.sourceBrowserId,
    );
  const sourcePane =
    sourceTab &&
    layout &&
    collectAllPanes(layout.root).find((pane) => pane.tabIds.includes(sourceTab.tabId));
  const fallbackPlacement = focus ? FOCUSED_PANE_PLACEMENT : AMBIENT_PLACEMENT;
  useWorkspaceLayoutStore.getState().openTab({
    workspaceKey: input.workspaceKey,
    target: { kind: "browser", browserId: input.createBrowser(input.request.url) },
    intent: focus ? "reveal" : "background",
    placement: sourcePane ? { mode: "prefer", paneId: sourcePane.id } : fallbackPlacement,
  });
}

export function useDesktopBrowserNewTabRequests(input: {
  enabled: boolean;
  workspaceKey: string | null;
  openUrl: (request: BrowserNewTabRequest) => void;
}): void {
  const handleNewTabRequest = useStableEvent((payload: unknown) => {
    const request = resolveBrowserNewTabRequest({
      payload,
      workspaceLayout: input.workspaceKey
        ? useWorkspaceLayoutStore.getState().layoutByWorkspace[input.workspaceKey]
        : null,
    });
    if (!request) {
      return;
    }
    input.openUrl(request);
  });

  useEffect(() => {
    if (!input.enabled || !getIsElectron()) {
      return;
    }
    const unsubscribe = getDesktopHost()?.events?.on?.(
      "browser-new-tab-request",
      handleNewTabRequest,
    );
    if (typeof unsubscribe === "function") {
      return unsubscribe;
    }
    return () => {
      void unsubscribe?.then((dispose) => dispose());
    };
  }, [handleNewTabRequest, input.enabled]);
}
