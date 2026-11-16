import { afterEach, expect, test } from "vitest";
import { providerSubagentKey, useProviderSubagentStore } from "@/subagents/provider-store";
import { btwConversationKey, useBtwConversationStore } from "./conversation-store";
import { observeBtwPanelReads } from "./panel-reads";
import { btwTestConnection } from "./test-connection";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const descriptor = {
  id: "thread",
  parentAgentId: "parent",
  provider: "pi",
  presentation: "side_conversation",
  status: "running",
  hasTimeline: false,
  title: "Question",
  description: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  toolCallId: null,
} as const;
afterEach(() => {
  useProviderSubagentStore.setState({
    descriptors: new Map(),
    timelines: new Map(),
    trackedParents: new Set(),
  });
  useBtwConversationStore.setState({ byParent: {} });
});

test.each([
  [false, "transport"],
  [true, "transport"],
  [false, "reported"],
  [true, "reported"],
] as const)(
  "standalone read retries with descriptor=%s after %s failure; empty/non-timeline success clears only read errors",
  async (hasDescriptor, failure) => {
    const rows = hasDescriptor ? [descriptor] : [];
    const connection = btwTestConnection(rows);
    connection.setRead(async (parentAgentId) => {
      if (failure === "transport") throw new Error("Transport not connected");
      return {
        requestId: "failed",
        parentAgentId,
        subagents: [],
        error: "Transport not connected",
      };
    });
    const conversationKey = btwConversationKey("host", "parent");
    const conversation = useBtwConversationStore.getState();
    conversation.edit(conversationKey, "draft line 1\nASCII line 2");
    await conversation.dispatch({
      key: conversationKey,
      command: { kind: "abort" },
      after: null,
      send: async () => {
        throw new Error("Stored command error");
      },
    });
    let historyError: string | null = null;
    let timelineReads = 0;
    const client = {
      ...connection.client,
      async fetchProviderSubagentTimeline() {
        timelineReads++;
        throw new Error("Unexpected history read");
      },
    };
    const detach = observeBtwPanelReads({
      client,
      serverId: "host",
      agentId: "parent",
      threadId: hasDescriptor ? "thread" : null,
      hasTimeline: false,
      reportError: (error) => {
        historyError = error;
      },
    });
    await settle();
    expect(historyError).toBe("Transport not connected");
    connection.setRead(async (parentAgentId) => ({
      requestId: "list",
      parentAgentId,
      subagents: rows,
      error: null,
    }));
    connection.status({ status: "connected" });
    await settle();
    expect(historyError).toBeNull();
    expect(useBtwConversationStore.getState().byParent[conversationKey]).toMatchObject({
      draft: { text: "draft line 1\nASCII line 2" },
      error: "Stored command error",
    });
    connection.status({ status: "disconnected" });
    connection.status({ status: "connected" });
    await settle();
    expect(connection.calls).toHaveLength(3);
    expect(timelineReads).toBe(0);
    detach();
    connection.status({ status: "disconnected" });
    connection.status({ status: "connected" });
    await settle();
    expect(connection.calls).toHaveLength(3);
    expect(connection.listeners.size).toBe(0);
  },
);

test("fresh timeline retires a read error without sending; retired reads cannot leak into a replacement thread", async () => {
  const connection = btwTestConnection([{ ...descriptor, hasTimeline: true }]);
  const errors: Array<string | null> = [];
  let reject = (_error: Error) => {};
  const client = {
    ...connection.client,
    fetchProviderSubagentTimeline: () =>
      new Promise<never>((_resolve, fail) => {
        reject = fail;
      }),
  };
  const detach = observeBtwPanelReads({
    client,
    serverId: "host",
    agentId: "parent",
    threadId: "thread",
    hasTimeline: true,
    reportError: (error) => errors.push(error),
  });
  await settle();
  reject(new Error("History disconnected"));
  await settle();
  expect(errors.at(-1)).toBe("History disconnected");
  useProviderSubagentStore.setState({
    timelines: new Map([
      [
        providerSubagentKey("host", "parent", "thread"),
        {
          tail: [],
          head: [],
          epoch: "epoch",
          lastSeq: 0,
          hasOlder: false,
          cursor: undefined,
          needsRefresh: false,
        },
      ],
    ]),
  });
  expect(errors.at(-1)).toBeNull();
  detach();
  errors.length = 0;
  const stop = observeBtwPanelReads({
    client,
    serverId: "host",
    agentId: "parent",
    threadId: "thread",
    hasTimeline: true,
    reportError: (error) => errors.push(error),
  });
  stop();
  reject(new Error("Old history failed"));
  await settle();
  expect(errors).toEqual([null]);
});

type TimelinePayload = Parameters<
  ReturnType<typeof useProviderSubagentStore.getState>["replaceTimeline"]
>[1];
function recoveredHistory(): TimelinePayload {
  return {
    requestId: "history",
    parentAgentId: "parent",
    subagentId: "thread",
    provider: "pi",
    epoch: "epoch",
    direction: "tail",
    projection: "projected",
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
    startCursor: { epoch: "epoch", seq: 1 },
    endCursor: { epoch: "epoch", seq: 1 },
    hasOlder: false,
    hasNewer: false,
    error: null,
    rows: [
      {
        seq: 1,
        seqStart: 1,
        seqEnd: 1,
        sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "assistant_message", messageId: "answer", text: "Recovered history" },
      },
    ],
  };
}

test("same-client reconnect refetches failed history when the descriptor and status have not changed", async () => {
  const connection = btwTestConnection([{ ...descriptor, hasTimeline: true }]);
  let reads = 0;
  let historyError: string | null = null;
  const client = {
    ...connection.client,
    async fetchProviderSubagentTimeline() {
      reads++;
      if (reads === 1) throw new Error("Transport not connected");
      return recoveredHistory();
    },
  };
  const detach = observeBtwPanelReads({
    client,
    serverId: "host",
    agentId: "parent",
    threadId: "thread",
    hasTimeline: true,
    reportError: (error) => {
      historyError = error;
    },
  });
  await settle();
  expect(historyError).toBe("Transport not connected");
  expect(reads).toBe(1);
  connection.status({ status: "disconnected" });
  connection.status({ status: "connected" });
  await settle();
  expect(reads).toBe(2);
  expect(historyError).toBeNull();
  const timeline = useProviderSubagentStore
    .getState()
    .timelines.get(providerSubagentKey("host", "parent", "thread"));
  expect([...(timeline?.tail ?? []), ...(timeline?.head ?? [])]).toEqual([
    expect.objectContaining({ kind: "assistant_message", text: "Recovered history" }),
  ]);
  detach();
  connection.status({ status: "disconnected" });
  connection.status({ status: "connected" });
  await settle();
  expect(reads).toBe(2);
});

test("a late read error from the previous connection cannot replace freshly recovered history", async () => {
  const connection = btwTestConnection([{ ...descriptor, hasTimeline: true }]);
  let reads = 0;
  let reject = (_error: Error) => {};
  const errors: Array<string | null> = [];
  const client = {
    ...connection.client,
    fetchProviderSubagentTimeline() {
      reads++;
      if (reads === 1)
        return new Promise<TimelinePayload>((_resolve, fail) => {
          reject = fail;
        });
      return Promise.resolve(recoveredHistory());
    },
  };
  const detach = observeBtwPanelReads({
    client,
    serverId: "host",
    agentId: "parent",
    threadId: "thread",
    hasTimeline: true,
    reportError: (error) => errors.push(error),
  });
  await settle();
  connection.status({ status: "disconnected" });
  connection.status({ status: "connected" });
  await settle();
  expect(reads).toBe(2);
  expect(errors.at(-1)).toBeNull();
  reject(new Error("Old connection history failed"));
  await settle();
  expect(errors).toEqual([null, null]);
  detach();
});
