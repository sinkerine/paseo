/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PaneProvider, type PaneContextValue } from "@/panels/pane-context";
import { providerSubagentKey, useProviderSubagentStore } from "@/subagents/provider-store";
import { btwConversationKey, useBtwConversationStore } from "./conversation-store";
import { btwPanelRegistration } from "./panel";
import { btwTestConnection } from "./test-connection";

const transport = vi.hoisted(() => ({ send: vi.fn<(command: unknown) => Promise<void>>() }));
vi.mock("./send", async (original) => ({
  ...(await original<typeof import("./send")>()),
  useSendBtwCommand: () => transport.send,
}));
vi.mock("@/agent-stream/view", async () => {
  const { useCallback } = await import("react");
  return {
    AgentStreamView: ({
      streamItems,
      historyPagination,
    }: {
      streamItems: Array<{ id: string }>;
      historyPagination: {
        hasOlder: boolean;
        isLoadingOlder: boolean;
        onLoadOlder(): Promise<unknown>;
      };
    }) => {
      const loadOlder = useCallback(() => {
        void historyPagination.onLoadOlder().catch(() => {});
      }, [historyPagination]);
      return (
        <div>
          <span data-testid="stream-rows">{streamItems.map((item) => item.id).join(",")}</span>
          <span data-testid="older-pending">{String(historyPagination.isLoadingOlder)}</span>
          {historyPagination.hasOlder ? (
            <button type="button" data-testid="load-older" onClick={loadOlder}>
              Older
            </button>
          ) : null}
        </div>
      );
    },
  };
});
const BtwPanel = btwPanelRegistration.component;
const key = btwConversationKey("host", "parent");
const initialThread = {
  id: "thread",
  parentAgentId: "parent",
  provider: "pi",
  presentation: "side_conversation",
  title: "Question",
  description: null,
  status: "running",
  hasTimeline: false,
  subtitle: "Read-only - pinned turn 1",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  toolCallId: null,
} as const;
beforeEach(() => {
  transport.send.mockReset().mockResolvedValue();
  useSessionStore.setState({ sessions: {} });
  useBtwConversationStore.setState({ byParent: {} });
  useProviderSubagentStore.setState({ descriptors: new Map(), timelines: new Map() });
  useProviderSubagentStore.getState().replaceList("host", "parent", [{ ...initialThread }]);
});
afterEach(cleanup);
const noop = () => {};
const paneContext: PaneContextValue = {
  serverId: "host",
  workspaceId: "workspace",
  host: "main",
  tabId: "btw_parent",
  target: { kind: "btw", agentId: "parent" },
  openTab: noop,
  openPreferredTarget: noop,
  closeCurrentTab: noop,
  retargetCurrentTab: noop,
  setCurrentTabState: noop,
  openFileInWorkspace: noop,
  openImportSheet: noop,
};
function mount() {
  const query = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <PaneProvider value={paneContext}>
        <BtwPanel />
      </PaneProvider>
    </QueryClientProvider>,
  );
}
function input() {
  const element = screen.getByTestId("btw-composer");
  if (!(element instanceof HTMLTextAreaElement)) throw new Error("Expected multiline composer");
  return element;
}
function draft(text = "draft line 1\nASCII line 2") {
  fireEvent.change(input(), { target: { value: text } });
}
function seedConversation() {
  useProviderSubagentStore.setState({
    timelines: new Map([
      [
        providerSubagentKey("host", "parent", "thread"),
        {
          tail: [
            {
              kind: "user_message",
              id: "question",
              text: "Question",
              timestamp: new Date("2026-01-01"),
              timelineCursor: { epoch: "epoch", seq: 1 },
            },
          ],
          head: [],
          epoch: "epoch",
          lastSeq: 1,
          hasOlder: false,
          cursor: undefined,
          needsRefresh: false,
        },
      ],
    ]),
  });
}
test("fresh history clears a disconnected read error without resending", async () => {
  const thread = { ...initialThread, hasTimeline: true };
  useProviderSubagentStore.getState().replaceList("host", "parent", [thread]);
  const client = new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "btw-panel-unit" });
  vi.spyOn(client, "listProviderSubagents").mockResolvedValue({
    requestId: "list",
    parentAgentId: "parent",
    subagents: [thread],
    error: null,
  });
  vi.spyOn(client, "fetchProviderSubagentTimeline").mockRejectedValue(
    new Error("Transport not connected"),
  );
  useSessionStore.getState().initializeSession("host", client);
  mount();
  draft();
  await waitFor(() =>
    expect(screen.getByTestId("btw-action-feedback").textContent).toContain(
      "Transport not connected",
    ),
  );
  act(() => seedConversation());
  await waitFor(() =>
    expect(screen.getByTestId("btw-action-feedback").textContent).not.toContain(
      "Transport not connected",
    ),
  );
  expect(input().value).toBe("draft line 1\nASCII line 2");
  expect(transport.send).not.toHaveBeenCalled();
});

test("pending dispatch survives remount without a second send", async () => {
  let finish = () => {};
  transport.send.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const first = mount();
  draft();
  fireEvent.click(screen.getByTestId("btw-send"));
  await waitFor(() => expect(transport.send).toHaveBeenCalledTimes(1));
  first.unmount();
  mount();
  fireEvent.click(screen.getByTestId("btw-send"));
  fireEvent.click(screen.getByTestId("btw-stop"));
  expect(transport.send).toHaveBeenCalledTimes(1);
  expect(useBtwConversationStore.getState().byParent[key].pending).toBe(true);
  await act(async () => finish());
  await waitFor(() => expect(input().value).toBe(""));
});
test("dispatch failure preserves the draft and error across remount and never resends", async () => {
  transport.send.mockRejectedValueOnce(new Error("Host disconnected"));
  const first = mount();
  draft();
  fireEvent.click(screen.getByTestId("btw-send"));
  await waitFor(() =>
    expect(screen.getByTestId("btw-action-feedback").textContent).toContain("Host disconnected"),
  );
  first.unmount();
  mount();
  expect(input().value).toBe("draft line 1\nASCII line 2");
  expect(screen.getByTestId("btw-action-feedback").textContent).toContain("Host disconnected");
  expect(transport.send).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTestId("btw-send"));
  await waitFor(() => expect(input().value).toBe(""));
  expect(transport.send).toHaveBeenCalledTimes(2);
});
test("late Pi command rejection recovers the accepted question locally without resending", async () => {
  mount();
  draft("Recover this question");
  fireEvent.click(screen.getByTestId("btw-send"));
  await waitFor(() => expect(input().value).toBe(""));
  act(() =>
    useProviderSubagentStore.getState().replaceList("host", "parent", [
      {
        ...initialThread,
        status: "failed",
        description: "Pi RPC disconnected",
        updatedAt: "2099-01-02",
      },
    ]),
  );
  await waitFor(() => expect(input().value).toBe("Recover this question"));
  expect(screen.getByTestId("btw-provider-error").textContent).toContain("Pi RPC disconnected");
  expect(transport.send).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTestId("btw-send"));
  await waitFor(() => expect(transport.send).toHaveBeenCalledTimes(2));
  act(() =>
    useProviderSubagentStore
      .getState()
      .replaceList("host", "parent", [
        { ...initialThread, status: "running", updatedAt: "2099-01-03" },
      ]),
  );
  await waitFor(() => expect(input().value).toBe(""));
  expect(screen.queryByTestId("btw-provider-error")).toBeNull();
});
test("pending action prevents duplicates and every control dispatches its one command", async () => {
  let finish = () => {};
  transport.send.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  mount();
  fireEvent.click(screen.getByTestId("btw-stop"));
  fireEvent.click(screen.getByTestId("btw-stop"));
  expect(transport.send).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  act(() => {
    seedConversation();
    useProviderSubagentStore
      .getState()
      .replaceList("host", "parent", [{ ...initialThread, status: "completed" }]);
  });
  for (const [id, kind] of [
    ["btw-inject", "inject"],
    ["btw-summarize", "summarize"],
    ["btw-new", "new"],
    ["btw-clear", "clear"],
  ]) {
    await waitFor(() =>
      expect(screen.getByTestId(id).getAttribute("aria-disabled")).not.toBe("true"),
    );
    fireEvent.click(screen.getByTestId(id));
    await waitFor(() => expect(transport.send.mock.calls.at(-1)?.[0]).toEqual({ kind }));
  }
  expect(transport.send.mock.calls.map(([command]) => command)).toEqual([
    { kind: "abort" },
    { kind: "inject" },
    { kind: "summarize" },
    { kind: "new" },
    { kind: "clear" },
  ]);
});
test("explicit delivery is disabled for an empty thread and during generation", () => {
  mount();
  for (const id of ["btw-inject", "btw-summarize"]) {
    expect(screen.getByTestId(id).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByTestId(id));
  }
  expect(transport.send).not.toHaveBeenCalled();
});
test("empty tab asks a new thread", async () => {
  useProviderSubagentStore.getState().replaceList("host", "parent", []);
  const first = mount();
  expect(screen.getByTestId("btw-empty")).toBeTruthy();
  expect(screen.getByTestId("btw-panel").getAttribute("aria-label")).toBe("");
  for (const id of ["btw-stop", "btw-new", "btw-clear", "btw-inject", "btw-summarize"])
    expect(screen.queryByTestId(id)).toBeNull();
  draft("AFTER_CLEAR");
  first.unmount();
  mount();
  expect(input().value).toBe("AFTER_CLEAR");
  fireEvent.click(screen.getByTestId("btw-send"));
  await waitFor(() =>
    expect(transport.send).toHaveBeenCalledWith({ kind: "ask", text: "AFTER_CLEAR" }),
  );
});

test("an unsent multiline ASCII draft survives panel remount without sending", () => {
  const first = mount();
  draft();
  first.unmount();
  mount();
  expect(input().value).toBe("draft line 1\nASCII line 2");
  expect(transport.send).not.toHaveBeenCalled();
});

test.each([
  [false, "transport"],
  [true, "transport"],
  [false, "reported"],
  [true, "reported"],
] as const)(
  "standalone panel retries an initial %s descriptor read on same-client reconnect (%s)",
  async (hasDescriptor, failure) => {
    const connection = btwTestConnection();
    const { client } = connection;
    const rows = hasDescriptor ? [{ ...initialThread }] : [];
    useProviderSubagentStore.getState().replaceList("host", "parent", rows);
    const list = vi.spyOn(client, "listProviderSubagents");
    if (failure === "transport") list.mockRejectedValueOnce(new Error("Transport not connected"));
    else
      list.mockResolvedValueOnce({
        requestId: "failed",
        parentAgentId: "parent",
        subagents: [],
        error: "Transport not connected",
      });
    useSessionStore.getState().initializeSession("host", client);
    const view = mount();
    try {
      draft();
      await waitFor(() =>
        expect(screen.getByTestId("btw-action-feedback").textContent).toContain(
          "Transport not connected",
        ),
      );
      list.mockResolvedValue({
        requestId: "list",
        parentAgentId: "parent",
        subagents: rows,
        error: null,
      });
      await act(async () => connection.connect());
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(screen.getByTestId("btw-action-feedback").textContent).not.toContain(
          "Transport not connected",
        ),
      );
      expect(input().value).toBe("draft line 1\nASCII line 2");
      expect(transport.send).not.toHaveBeenCalled();
      act(() =>
        useBtwConversationStore.setState((state) => ({
          byParent: {
            ...state.byParent,
            [key]: { ...state.byParent[key], error: "Stored command error" },
          },
        })),
      );
      act(() => connection.disconnect());
      await act(async () => connection.connect());
      expect(screen.getByTestId("btw-action-feedback").textContent).toBe("Stored command error");
      expect(input().value).toBe("draft line 1\nASCII line 2");
      expect(transport.send).not.toHaveBeenCalled();
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

test("composer identity, focus and selection survive empty, first thread, New and Clear", () => {
  useProviderSubagentStore.getState().replaceList("host", "parent", []);
  mount();
  draft("Keep this draft");
  const composer = input();
  composer.focus();
  composer.setSelectionRange(2, 6);
  for (const rows of [[{ ...initialThread }], [{ ...initialThread, id: "new-thread" }], []]) {
    act(() => useProviderSubagentStore.getState().replaceList("host", "parent", rows));
    expect(input()).toBe(composer);
    expect(document.activeElement).toBe(composer);
    expect([composer.selectionStart, composer.selectionEnd]).toEqual([2, 6]);
    expect(composer.value).toBe("Keep this draft");
  }
  expect(transport.send).not.toHaveBeenCalled();
});

test.each([false, true])(
  "thread replacement retires old pagination and history error (already failed: %s)",
  async (alreadyFailed) => {
    const client = new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "btw-history-unit" });
    vi.spyOn(client, "listProviderSubagents").mockResolvedValue({
      requestId: "list",
      parentAgentId: "parent",
      subagents: [{ ...initialThread }],
      error: null,
    });
    let reject = (_error: Error) => {};
    const read = vi.spyOn(client, "fetchProviderSubagentTimeline").mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    useSessionStore.getState().initializeSession("host", client);
    seedConversation();
    useProviderSubagentStore.setState((state) => {
      const timelines = new Map(state.timelines);
      const oldKey = providerSubagentKey("host", "parent", "thread");
      const old = timelines.get(oldKey)!;
      timelines.set(oldKey, {
        ...old,
        hasOlder: true,
        cursor: { epoch: "epoch", startSeq: 1, endSeq: 1 },
      });
      return { timelines };
    });
    const view = mount();
    try {
      await act(async () => {});
      draft("Preserved draft");
      const composer = input();
      fireEvent.click(screen.getByTestId("load-older"));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      if (alreadyFailed) {
        await act(async () => reject(new Error("Old history failed")));
        await waitFor(() =>
          expect(screen.getByTestId("btw-action-feedback").textContent).toContain(
            "Old history failed",
          ),
        );
      } else {
        await waitFor(() => expect(screen.getByTestId("older-pending").textContent).toBe("true"));
      }
      act(() => {
        const store = useProviderSubagentStore.getState();
        const old = store.timelines.get(providerSubagentKey("host", "parent", "thread"))!;
        store.replaceList("host", "parent", [{ ...initialThread, id: "new-thread" }]);
        useProviderSubagentStore.setState((state) => ({
          timelines: new Map(state.timelines).set(
            providerSubagentKey("host", "parent", "new-thread"),
            { ...old, hasOlder: false, tail: [{ ...old.tail[0], id: "new-question" }] },
          ),
        }));
      });
      await waitFor(() => expect(screen.getByTestId("older-pending").textContent).toBe("false"));
      if (!alreadyFailed) await act(async () => reject(new Error("Old history failed")));
      expect(screen.getByTestId("btw-action-feedback").textContent).not.toContain(
        "Old history failed",
      );
      expect(screen.getByTestId("stream-rows").textContent).toBe("new-question");
      expect(screen.queryByTestId("load-older")).toBeNull();
      expect(input()).toBe(composer);
      expect(input().value).toBe("Preserved draft");
      act(() => useProviderSubagentStore.getState().replaceList("host", "parent", []));
      expect(screen.queryByTestId("stream-rows")).toBeNull();
      expect(screen.getByTestId("btw-action-feedback").textContent).not.toContain(
        "Old history failed",
      );
      expect(input()).toBe(composer);
    } finally {
      view.unmount();
      client.close();
    }
  },
);
