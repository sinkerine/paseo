import { describe, expect, it } from "vitest";
import type { WorkspaceLayout } from "@/stores/workspace-layout-store";
import {
  createDefaultLayout,
  useWorkspaceLayoutStore,
  collectAllTabs,
  collectAllPanes,
} from "@/stores/workspace-layout-store";
import { FOCUSED_PANE_PLACEMENT, openTabInLayoutFocused } from "@/stores/workspace-layout-actions";
import {
  shouldFocusBrowserNewTabRequest,
  openBrowserNewTabRequest,
  resolveBrowserNewTabRequest,
  type BrowserNewTabRequest,
} from ".";

function createLayoutWithBrowser(browserId: string): WorkspaceLayout {
  return openTabInLayoutFocused({
    layout: createDefaultLayout(),
    target: { kind: "browser", browserId },
    now: 1,
    placement: FOCUSED_PANE_PLACEMENT,
    explorerSidebarPaneId: null,
  })!.layout;
}

describe("browser new-tab requests", () => {
  it("accepts desktop requests from browser tabs in the current workspace", () => {
    const request = resolveBrowserNewTabRequest({
      payload: {
        sourceBrowserId: "browser-1",
        url: "https://example.com/target",
      },
      workspaceLayout: createLayoutWithBrowser("browser-1"),
    });

    expect(request).toEqual<BrowserNewTabRequest>({
      sourceBrowserId: "browser-1",
      url: "https://example.com/target",
    });
  });

  it("ignores desktop requests from another workspace", () => {
    const request = resolveBrowserNewTabRequest({
      payload: {
        sourceBrowserId: "browser-from-other-workspace",
        url: "https://example.com/target",
      },
      workspaceLayout: createLayoutWithBrowser("browser-1"),
    });

    expect(request).toBeNull();
  });

  it("rejects unsupported desktop request URLs", () => {
    const request = resolveBrowserNewTabRequest({
      payload: {
        sourceBrowserId: "browser-1",
        url: "file:///etc/passwd",
      },
      workspaceLayout: createLayoutWithBrowser("browser-1"),
    });

    expect(request).toBeNull();
  });
});

it.each([
  [false, true, "browser-1", true],
  [true, true, "browser-1", false],
  [false, false, "browser-1", false],
  [false, true, "other-browser", false],
])(
  "focus ownership background=%s route=%s source=%s",
  (background, isRouteFocused, sourceBrowserId, expected) => {
    expect(
      shouldFocusBrowserNewTabRequest({
        request: { sourceBrowserId, url: "https://example.com", background },
        workspaceLayout: createLayoutWithBrowser("browser-1"),
        isRouteFocused,
      }),
    ).toBe(expected);
  },
);
it("retains background intent in validated renderer requests", () => {
  expect(
    resolveBrowserNewTabRequest({
      payload: { sourceBrowserId: "browser-1", url: "https://example.com", background: true },
      workspaceLayout: createLayoutWithBrowser("browser-1"),
    }),
  ).toEqual({ sourceBrowserId: "browser-1", url: "https://example.com", background: true });
});

it("reads focus and source placement after synchronous unfocus before the next render", () => {
  const key = "server:browser-event-race";
  const store = useWorkspaceLayoutStore;
  store.getState().openTab({
    workspaceKey: key,
    target: { kind: "browser", browserId: "source" },
    intent: "reveal",
  });
  const staleLayout = store.getState().layoutByWorkspace[key];
  expect(staleLayout.focusedPaneId).toBe("main");
  const token = store.getState().unfocusPane(key)!;
  const parked = store.getState().focusRestorationByWorkspace[key];
  openBrowserNewTabRequest({
    request: { sourceBrowserId: "source", url: "https://example.com/queued" },
    workspaceKey: key,
    isRouteFocused: true,
    createBrowser: () => "queued",
  });
  const layout = store.getState().layoutByWorkspace[key];
  expect(layout.focusedPaneId).toBeNull();
  expect(store.getState().focusRestorationByWorkspace[key]).toBe(parked);
  const queued = collectAllTabs(layout.root).find(
    (tab) => tab.target.kind === "browser" && tab.target.browserId === "queued",
  )!;
  const pane = collectAllPanes(layout.root).find((candidate) =>
    candidate.tabIds.includes(queued.tabId),
  )!;
  expect(pane.focusedTabId).toBe("browser_source");
  store.getState().restorePaneFocus(key, token);
  expect(store.getState().layoutByWorkspace[key].focusedPaneId).toBe("main");
  store.getState().purgeWorkspace(key);
});

it("places a queued request in the source browser's current pane after a synchronous move", () => {
  const key = "server:browser-pane-race";
  const store = useWorkspaceLayoutStore;
  store.getState().openTab({
    workspaceKey: key,
    target: { kind: "browser", browserId: "source" },
    intent: "reveal",
  });
  const side = store.getState().splitPaneEmpty(key, { targetPaneId: "main", position: "right" })!;
  store.getState().moveTabToPane(key, "browser_source", side);
  openBrowserNewTabRequest({
    request: { sourceBrowserId: "source", url: "https://example.com/moved", background: true },
    workspaceKey: key,
    isRouteFocused: true,
    createBrowser: () => "moved",
  });
  const layout = store.getState().layoutByWorkspace[key];
  const sourcePane = collectAllPanes(layout.root).find((pane) => pane.id === side)!;
  expect(sourcePane.tabIds).toContain("browser_moved");
  expect(sourcePane.focusedTabId).toBe("browser_source");
  store.getState().purgeWorkspace(key);
});
