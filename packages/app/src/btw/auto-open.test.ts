import { afterEach, expect, test } from "vitest";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import { useProviderSubagentStore } from "@/subagents/provider-store";
import { createBtwDiscovery } from "./discovery";
import { refreshBtwOnConnect } from "./refresh-on-connect";
import { createBtwThreadSelector } from "./select";
import { btwTestConnection } from "./test-connection";

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
afterEach(() =>
  useProviderSubagentStore.setState({
    descriptors: new Map(),
    timelines: new Map(),
    trackedParents: new Set(),
  }),
);
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("existing thread at baseline does not open; later IDs open only once even after removal", () => {
  const discovery = createBtwDiscovery();
  expect(discovery.observe("before-success")).toBe(false);
  discovery.baseline("existing");
  expect(discovery.observe("existing")).toBe(false);
  expect(discovery.observe("new")).toBe(true);
  expect(discovery.observe(null)).toBe(false);
  expect(discovery.observe("new")).toBe(false);
  discovery.baseline("later-list");
  expect(discovery.observe("later-list")).toBe(true);
});

test("empty baseline admits the first new thread", () => {
  const discovery = createBtwDiscovery();
  discovery.baseline(null);
  expect(discovery.observe("first")).toBe(true);
  expect(discovery.observe("first")).toBe(false);
});

test.each(["transport", "reported"] as const)(
  "failed %s list establishes no baseline; same-client reconnect retries and preserves subsequent discovery",
  async (failure) => {
    const connection = btwTestConnection();
    connection.setRead(async (parentAgentId) => {
      if (failure === "transport") throw new Error("offline");
      return { requestId: "failed", parentAgentId, subagents: [], error: "offline" };
    });
    const discovery = createBtwDiscovery();
    const select = createBtwThreadSelector("host", "parent");
    const errors: string[] = [];
    const detach = refreshBtwOnConnect(
      connection.client,
      "host",
      "parent",
      () => discovery.baseline(select(useProviderSubagentStore.getState())?.id ?? null),
      (error) => errors.push(String(error)),
    );
    await settle();
    expect(errors).toEqual(["Error: offline"]);
    expect(discovery.observe("arrived-before-list")).toBe(false);
    connection.setRead(async (parentAgentId) => ({
      requestId: "list",
      parentAgentId,
      subagents: [thread("arrived-before-list")],
      error: null,
    }));
    connection.status({ status: "connected" });
    await settle();
    expect(discovery.observe("arrived-before-list")).toBe(false);
    expect(discovery.observe("next")).toBe(true);
    connection.status({ status: "disconnected" });
    connection.status({ status: "connected" });
    await settle();
    expect(discovery.observe("next")).toBe(false);
    expect(connection.calls).toEqual(["parent", "parent", "parent"]);
    detach();
    connection.status({ status: "disconnected" });
    connection.status({ status: "connected" });
    await settle();
    expect(connection.calls).toHaveLength(3);
    expect(connection.listeners.size).toBe(0);
  },
);

test("same-client reconnect preserves the baseline and discovers a new thread", async () => {
  const connection = btwTestConnection([thread("old")]);
  const select = createBtwThreadSelector("host", "parent");
  const discovery = createBtwDiscovery();
  const detach = refreshBtwOnConnect(
    connection.client,
    "host",
    "parent",
    () => discovery.baseline(select(useProviderSubagentStore.getState())?.id ?? null),
    () => {},
  );
  await settle();
  connection.setRead(async (parentAgentId) => ({
    requestId: "list",
    parentAgentId,
    subagents: [thread("new")],
    error: null,
  }));
  connection.status({ status: "disconnected" });
  connection.status({ status: "connected" });
  await settle();
  expect(discovery.observe(select(useProviderSubagentStore.getState())?.id ?? null)).toBe(true);
  expect(discovery.observe("new")).toBe(false);
  detach();
});

test.each(["disconnect", "detach"] as const)(
  "late completion after %s cannot establish a baseline or report a stale error",
  async (retire) => {
    const connection = btwTestConnection();
    let finish = () => {};
    connection.setRead(
      (parentAgentId) =>
        new Promise((resolve) => {
          finish = () => resolve({ requestId: "list", parentAgentId, subagents: [], error: null });
        }),
    );
    const callbacks: string[] = [];
    const detach = refreshBtwOnConnect(
      connection.client,
      "host",
      "parent",
      () => callbacks.push("success"),
      () => callbacks.push("error"),
    );
    if (retire === "disconnect") connection.status({ status: "disconnected" });
    else detach();
    finish();
    await settle();
    expect(callbacks).toEqual([]);
    detach();
  },
);
