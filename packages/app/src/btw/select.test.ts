import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import { useProviderSubagentStore } from "@/subagents/provider-store";
import { expect, test } from "vitest";
import { selectBtwThread, createBtwThreadSelector } from "./select";
test("recognizes only the known presentation and preserves unknown values as ordinary rows", () => {
  const ordinary = { id: "normal", presentation: undefined };
  const future = { id: "future", presentation: "unknown" };
  const btw = { id: "btw:thread", presentation: "side_conversation" };
  expect(selectBtwThread([ordinary, future, btw])).toBe(btw);
  expect(selectBtwThread([ordinary, future])).toBeNull();
});

test("window selection never borrows another host or parent thread and follows clear", () => {
  useProviderSubagentStore.setState({ descriptors: new Map() });
  const descriptor: ProviderSubagentDescriptorPayload = {
    id: "btw:thread",
    parentAgentId: "owner",
    provider: "pi",
    presentation: "side_conversation",
    title: "Question",
    description: null,
    status: "completed",
    createdAt: "now",
    updatedAt: "now",
    toolCallId: null,
  };
  const store = useProviderSubagentStore.getState();
  store.replaceList("other-host", "owner", [descriptor]);
  store.replaceList("host", "other-owner", [{ ...descriptor, parentAgentId: "other-owner" }]);
  const select = createBtwThreadSelector("host", "owner");
  const current = () => select(useProviderSubagentStore.getState());
  expect(current()).toBeNull();
  store.replaceList("host", "owner", [descriptor]);
  expect(current()).toEqual(descriptor);
  store.replaceList("host", "owner", []);
  expect(current()).toBeNull();
});
