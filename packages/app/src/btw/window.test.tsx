/** @vitest-environment jsdom */
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BtwWindow } from "./window";
import { providerSubagentKey, useProviderSubagentStore } from "@/subagents/provider-store";
import { btwWindowKey, useBtwWindowStore } from "./window-store";

const fixture = vi.hoisted(
  (): {
    send: ReturnType<typeof vi.fn<(command: unknown) => Promise<void>>>;
    thread: ProviderSubagentDescriptorPayload;
  } => ({
    send: vi.fn<(command: unknown) => Promise<void>>(),
    thread: {
      id: "btw:thread",
      parentAgentId: "owner",
      provider: "pi",
      presentation: "side_conversation",
      title: "Question",
      description: null,
      status: "running",
      hasTimeline: false,
      subtitle: "Read-only · pinned turn 1",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      toolCallId: null,
    },
  }),
);
vi.mock("lucide-react-native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("lucide-react-native")>()),
  Minus: () => null,
}));
vi.mock("./select", () => ({ useBtwThread: () => fixture.thread }));
vi.mock("./send", () => ({ useSendBtwCommand: () => fixture.send }));
vi.mock("@/agent-stream/view", () => ({ AgentStreamView: () => <div>Thread timeline</div> }));
vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => false,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./floating-card", () => ({
  BtwFloatingCard: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? <div>{children}</div> : null,
}));
vi.mock("./sheet", () => ({ BtwSheet: () => null }));

beforeEach(() => {
  fixture.send.mockReset();
  fixture.thread = {
    ...fixture.thread,
    status: "running",
    description: null,
    updatedAt: "2026-01-01",
  };
  useBtwWindowStore.setState({ byThread: {} });
  useProviderSubagentStore.setState({ timelines: new Map() });
});
afterEach(cleanup);
function mount() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const content = () => (
    <QueryClientProvider client={client}>
      <BtwWindow serverId="host" agentId="owner" isPaneFocused />
    </QueryClientProvider>
  );
  const view = render(content());
  return { ...view, refresh: () => view.rerender(content()) };
}

test("dispatch failure preserves the draft, displays recovery and never resends on show/hide", async () => {
  fixture.send.mockRejectedValueOnce(new Error("Host disconnected"));
  const view = mount();
  const input = await screen.findByTestId("btw-composer");
  fireEvent.change(input, { target: { value: "Question 日本語" } });
  fireEvent.click(screen.getByTestId("btw-send"));
  await waitFor(() =>
    expect(screen.getByTestId("btw-action-feedback").textContent).toContain("Host disconnected"),
  );
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("Expected multiline composer");
  expect(input.value).toBe("Question 日本語");
  fireEvent.click(screen.getByTestId("btw-minimize"));
  expect(screen.queryByTestId("btw-window")).toBeNull();
  act(() => useBtwWindowStore.getState().toggle(btwWindowKey("host", "owner", "btw:thread")));
  expect(fixture.send).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("btw-action-feedback").textContent).toContain("Host disconnected");
  fixture.send.mockResolvedValueOnce();
  fireEvent.click(screen.getByTestId("btw-send"));
  await waitFor(() =>
    expect(screen.getByTestId("btw-action-feedback").textContent).toContain("btw.accepted"),
  );
  expect(fixture.send.mock.calls.at(-1)?.[0]).toEqual({ kind: "ask", text: "Question 日本語" });
  view.unmount();
});

test("pending action prevents duplicates and every control dispatches its one command", async () => {
  let finish: () => void = () => undefined;
  fixture.send.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const view = mount();
  await screen.findByTestId("btw-stop");
  fireEvent.click(screen.getByTestId("btw-stop"));
  fireEvent.click(screen.getByTestId("btw-stop"));
  fireEvent.click(screen.getByTestId("btw-inject"));
  await waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(1));
  await act(async () => finish());
  fixture.send.mockResolvedValue();
  fixture.thread = { ...fixture.thread, status: "completed", updatedAt: "2026-01-02" };
  seedConversation();
  view.refresh();
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
    await waitFor(() => expect(fixture.send.mock.calls.at(-1)?.[0]).toEqual({ kind }));
  }
  expect(fixture.send.mock.calls.map(([command]) => command)).toEqual([
    { kind: "abort" },
    { kind: "inject" },
    { kind: "summarize" },
    { kind: "new" },
    { kind: "clear" },
  ]);
});

test("late Pi command rejection recovers the accepted question locally without resending", async () => {
  fixture.send.mockResolvedValue();
  const view = mount();
  fireEvent.change(await screen.findByTestId("btw-composer"), {
    target: { value: "Recover this question" },
  });
  fireEvent.click(screen.getByTestId("btw-send"));
  await waitFor(() =>
    expect(screen.getByTestId("btw-action-feedback").textContent).toContain("btw.accepted"),
  );
  fixture.thread = {
    ...fixture.thread,
    status: "failed",
    description: "Pi RPC disconnected",
    updatedAt: "2026-01-02",
  };
  view.refresh();
  await waitFor(() => {
    const input = screen.getByTestId("btw-composer");
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("Expected multiline composer");
    expect(input.value).toBe("Recover this question");
  });
  expect(screen.getByTestId("btw-provider-error").textContent).toContain("Pi RPC disconnected");
  expect(fixture.send).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTestId("btw-send"));
  await waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(2));
  fixture.thread = {
    ...fixture.thread,
    status: "running",
    description: null,
    updatedAt: "2026-01-03",
  };
  view.refresh();
  await waitFor(() => expect(screen.queryByTestId("btw-provider-error")).toBeNull());
  expect(fixture.send.mock.calls.at(-1)?.[0]).toEqual({
    kind: "ask",
    text: "Recover this question",
  });
});

function seedConversation() {
  useProviderSubagentStore.setState({
    timelines: new Map([
      [
        providerSubagentKey("host", "owner", "btw:thread"),
        {
          tail: [
            {
              kind: "user_message",
              id: "question",
              text: "A real question",
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
test("explicit delivery is disabled for an empty thread and during generation", async () => {
  fixture.thread = { ...fixture.thread, status: "completed" };
  const view = mount();
  const disabled = () => {
    expect(screen.getByTestId("btw-inject").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("btw-summarize").getAttribute("aria-disabled")).toBe("true");
  };
  await screen.findByTestId("btw-inject");
  disabled();
  fireEvent.click(screen.getByTestId("btw-inject"));
  fireEvent.click(screen.getByTestId("btw-summarize"));
  expect(fixture.send).not.toHaveBeenCalled();
  act(seedConversation);
  expect(screen.getByTestId("btw-inject").getAttribute("aria-disabled")).not.toBe("true");
  fixture.thread = { ...fixture.thread, status: "running", updatedAt: "2026-01-02" };
  view.refresh();
  disabled();
  fireEvent.click(screen.getByTestId("btw-inject"));
  fireEvent.click(screen.getByTestId("btw-summarize"));
  expect(fixture.send).not.toHaveBeenCalled();
});

test("pane focus and fullscreen hide the window without changing the thread visibility preference", async () => {
  const client = new QueryClient();
  const content = (focused: boolean, fullscreen = false) => (
    <QueryClientProvider client={client}>
      <BtwWindow
        serverId="host"
        agentId="owner"
        isPaneFocused={focused}
        isComposerFullscreen={fullscreen}
      />
    </QueryClientProvider>
  );
  const view = render(content(false));
  expect(screen.queryByTestId("btw-window")).toBeNull();
  expect(useBtwWindowStore.getState().byThread[btwWindowKey("host", "owner", "btw:thread")]).toBe(
    "open",
  );
  view.rerender(content(true, true));
  expect(screen.queryByTestId("btw-window")).toBeNull();
  expect(fixture.send).not.toHaveBeenCalled();
});
