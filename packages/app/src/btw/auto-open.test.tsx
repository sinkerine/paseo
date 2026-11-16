/** @vitest-environment jsdom */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useProviderSubagentStore } from "@/subagents/provider-store";
import { BtwAutoOpen } from "./auto-open";
import { btwTestConnection } from "./test-connection";

const workspaceKey = "host:workspace";
function thread(id: string): ProviderSubagentDescriptorPayload {
  return {
    id,
    parentAgentId: "parent",
    provider: "pi",
    presentation: "side_conversation",
    title: "Question",
    description: null,
    status: "completed",
    hasTimeline: false,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    toolCallId: null,
  };
}
function connect(rows: ProviderSubagentDescriptorPayload[] = []) {
  const client = new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "btw-unit" });
  const list = vi.spyOn(client, "listProviderSubagents").mockResolvedValue({
    requestId: "list",
    parentAgentId: "parent",
    subagents: rows,
    error: null,
  });
  useSessionStore.getState().initializeSession("host", client);
  useSessionStore.getState().updateSessionClient("host", client);
  return { client, list };
}
function hasTab() {
  return collectAllTabs(
    useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
  ).some((tab) => tab.target.kind === "btw");
}
function update(id: string | null) {
  act(() =>
    useProviderSubagentStore.getState().replaceList("host", "parent", id ? [thread(id)] : []),
  );
}
beforeEach(() => {
  useSessionStore.setState({ sessions: {} });
  useProviderSubagentStore.setState({
    descriptors: new Map(),
    timelines: new Map(),
    trackedParents: new Set(),
  });
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
  useWorkspaceLayoutStore.setState({ focusRequest: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount() {
  return render(<BtwAutoOpen serverId="host" workspaceId="workspace" agentId="parent" />);
}

test("existing thread at baseline does not open", async () => {
  const { list } = connect([thread("existing")]);
  mount();
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  await act(async () => {});
  expect(hasTab()).toBe(false);
});
test("new thread after baseline opens once without focus", async () => {
  const { list } = connect();
  mount();
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  await act(async () => {});
  update("new");
  await waitFor(() => expect(hasTab()).toBe(true));
  expect(useWorkspaceLayoutStore.getState().focusRequest).toBeNull();
  act(() => useWorkspaceLayoutStore.getState().closeTab(workspaceKey, "btw_parent"));
  update("new");
  expect(hasTab()).toBe(false);
});
test("same id after removal does not reopen", async () => {
  const { list } = connect([thread("existing")]);
  mount();
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  await act(async () => {});
  update(null);
  update("existing");
  expect(hasTab()).toBe(false);
});
test.each(["transport", "reported"] as const)(
  "failed %s list establishes no baseline on the same client reconnect",
  async (failure) => {
    const connection = btwTestConnection();
    const { client } = connection;
    const list = vi.spyOn(client, "listProviderSubagents");
    if (failure === "transport") list.mockRejectedValueOnce(new Error("offline"));
    else
      list.mockResolvedValueOnce({
        requestId: "failed",
        parentAgentId: "parent",
        subagents: [],
        error: "offline",
      });
    useSessionStore.getState().initializeSession("host", client);
    const view = mount();
    try {
      await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      list.mockResolvedValue({
        requestId: "list",
        parentAgentId: "parent",
        subagents: [thread("arrived-before-list")],
        error: null,
      });
      await act(async () => connection.connect());
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      expect(hasTab()).toBe(false);
      update("next");
      await waitFor(() => expect(hasTab()).toBe(true));
      expect(useWorkspaceLayoutStore.getState().focusRequest).toBeNull();
      act(() => useWorkspaceLayoutStore.getState().closeTab(workspaceKey, "btw_parent"));
      list.mockResolvedValue({
        requestId: "list",
        parentAgentId: "parent",
        subagents: [thread("next")],
        error: null,
      });
      act(() => connection.disconnect());
      await act(async () => connection.connect());
      expect(hasTab()).toBe(false);
      view.unmount();
      act(() => connection.disconnect());
      await connection.connect();
      expect(list).toHaveBeenCalledTimes(3);
    } finally {
      view.unmount();
      client.close();
    }
  },
);
test("reconnect keeps the baseline on the same client", async () => {
  const connection = btwTestConnection();
  const { client } = connection;
  const list = vi.spyOn(client, "listProviderSubagents").mockResolvedValue({
    requestId: "list",
    parentAgentId: "parent",
    subagents: [thread("old")],
    error: null,
  });
  await connection.connect();
  useSessionStore.getState().initializeSession("host", client);
  const view = mount();
  try {
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await act(async () => {});
    list.mockResolvedValue({
      requestId: "list",
      parentAgentId: "parent",
      subagents: [thread("new-on-reconnect")],
      error: null,
    });
    act(() => connection.disconnect());
    await act(async () => connection.connect());
    await waitFor(() => expect(hasTab()).toBe(true));
    expect(useWorkspaceLayoutStore.getState().focusRequest).toBeNull();
  } finally {
    view.unmount();
    client.close();
  }
});
