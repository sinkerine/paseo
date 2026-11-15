import { describe, expect, it } from "vitest";
import { AgentNavigationInbox, parseAgentDeepLinkFromArgv } from "./agent-navigation.js";

describe("desktop agent navigation", () => {
  it("finds an agent deep link among Electron launch arguments", () => {
    expect(
      parseAgentDeepLinkFromArgv([
        "/Applications/Paseo.app/Contents/MacOS/Paseo",
        "--no-sandbox",
        "paseo://h/server-1/agent/agent-2",
      ]),
    ).toEqual({ serverId: "server-1", agentId: "agent-2" });
  });

  it("holds navigation until the existing renderer is ready", () => {
    const inbox = new AgentNavigationInbox();
    const target = { serverId: "server-1", agentId: "agent-2" };

    expect(inbox.deliverOrQueue(7, target)).toBeNull();
    expect(inbox.windowReady(7)).toEqual(target);
    expect(inbox.deliverOrQueue(7, target)).toEqual(target);
  });

  it("keeps background FIFO separate from the latest foreground and coalesces duplicates", () => {
    const inbox = new AgentNavigationInbox();
    const bg = (agentId: string) => ({ serverId: "server-1", agentId, focus: false });
    inbox.deliverOrQueue(7, bg("a"));
    inbox.deliverOrQueue(7, bg("b"));
    inbox.deliverOrQueue(7, bg("a"));
    inbox.deliverOrQueue(7, { serverId: "server-1", agentId: "foreground-old" });
    inbox.deliverOrQueue(7, { serverId: "server-1", agentId: "foreground" });
    expect(inbox.windowReady(7)).toEqual({ serverId: "server-1", agentId: "foreground" });
    expect(inbox.drainBackground(7)).toEqual([bg("a"), bg("b")]);
    expect(inbox.drainBackground(7)).toEqual([]);
    expect(inbox.deliverOrQueue(7, bg("c"))).toEqual(bg("c"));
    inbox.windowLoading(7);
    inbox.deliverOrQueue(7, bg("a"));
    inbox.deliverOrQueue(7, { serverId: "server-1", agentId: "a" });
    inbox.deliverOrQueue(7, bg("a"));
    expect(inbox.windowReady(7)).toEqual({ serverId: "server-1", agentId: "a" });
    expect(inbox.drainBackground(7)).toEqual([]);
    inbox.removeWindow(7);
    expect(inbox.windowReady(7)).toBeNull();
  });

  it.each(["background-first", "foreground-first"])(
    "retains a background target when its foreground is superseded (%s)",
    (order) => {
      const inbox = new AgentNavigationInbox();
      const background = { serverId: "server", agentId: "a", focus: false };
      const foreground = { serverId: "server", agentId: "a" };
      for (const target of order === "background-first"
        ? [background, foreground]
        : [foreground, background])
        inbox.deliverOrQueue(7, target);
      inbox.deliverOrQueue(7, { serverId: "server", agentId: "b" });
      expect(inbox.windowReady(7)).toEqual({ serverId: "server", agentId: "b" });
      expect(inbox.drainBackground(7)).toEqual([background]);
    },
  );

  it("returns only the newest navigation queued during startup", () => {
    const inbox = new AgentNavigationInbox();

    inbox.deliverOrQueue(7, { serverId: "server-1", agentId: "agent-1" });
    inbox.deliverOrQueue(7, { serverId: "server-1", agentId: "agent-2" });

    expect(inbox.windowReady(7)).toEqual({ serverId: "server-1", agentId: "agent-2" });
    expect(inbox.windowReady(7)).toBeNull();
  });
});
