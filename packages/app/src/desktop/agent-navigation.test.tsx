import { describe, expect, it } from "vitest";
import {
  createBackgroundAgentTabOpener,
  type OpenAgentTabInBackgroundDeps,
} from "./agent-navigation";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness() {
  const opened: Array<{ workspaceKey: string; agentId: string }> = [];
  const subscriptions = new Set<() => void>();
  let cached: string | null = null;
  let fetched: string | null = "workspace";
  let offline = false;
  let calls = 0;
  let hydrate: () => void = () => {};
  const hydration = new Promise<void>((resolve) => {
    hydrate = resolve;
  });
  const deps: OpenAgentTabInBackgroundDeps = {
    isHostReady: () => !offline,
    readCachedWorkspaceId: () => cached,
    fetchWorkspaceId: async () => {
      calls++;
      if (offline) throw new Error("offline");
      return fetched;
    },
    subscribeHostReady: (_server, onChange) => {
      subscriptions.add(onChange);
      return () => subscriptions.delete(onChange);
    },
    prepareWorkspace: () => hydration,
    openBackgroundTab: (input) => {
      opened.push(input);
    },
  };
  return {
    deps,
    opened,
    subscriptions,
    hydrate: () => hydrate(),
    calls: () => calls,
    setCached: (value: string) => {
      cached = value;
    },
    setFetched: (value: string | null) => {
      fetched = value;
    },
    setOffline: (value: boolean) => {
      offline = value;
    },
    reconnect: () => {
      for (const changed of subscriptions) changed();
    },
  };
}
const target = { serverId: "server", agentId: "agent" };

describe("background desktop agent navigation", () => {
  it("deduplicates overlapping requests and waits for layout hydration", async () => {
    const h = harness();
    const opener = createBackgroundAgentTabOpener(h.deps);
    opener.open(target);
    opener.open(target);
    await turn();
    expect(h.calls()).toBe(1);
    expect(h.opened).toEqual([]);
    h.hydrate();
    await turn();
    expect(h.opened).toEqual([{ workspaceKey: "server:workspace", agentId: "agent" }]);
    opener.dispose();
  });
  it("uses cached ownership without a network fetch", async () => {
    const h = harness();
    h.setCached("cached");
    h.hydrate();
    const opener = createBackgroundAgentTabOpener(h.deps);
    opener.open(target);
    await turn();
    expect(h.calls()).toBe(0);
    expect(h.opened).toEqual([{ workspaceKey: "server:cached", agentId: "agent" }]);
    opener.dispose();
  });
  it("retries an offline host on connection and settles a missing agent without a tab", async () => {
    const h = harness();
    h.setOffline(true);
    h.hydrate();
    const opener = createBackgroundAgentTabOpener(h.deps);
    opener.open(target);
    await turn();
    expect(h.opened).toEqual([]);
    expect(h.subscriptions.size).toBe(1);
    h.setOffline(false);
    h.reconnect();
    await turn();
    expect(h.opened).toEqual([{ workspaceKey: "server:workspace", agentId: "agent" }]);
    expect(h.subscriptions.size).toBe(0);
    h.setFetched(null);
    opener.open({ ...target, agentId: "missing" });
    await turn();
    expect(h.opened).toHaveLength(1);
    expect(h.subscriptions.size).toBe(0);
    opener.dispose();
  });
  it("cancels pending hydration and offline retries on disposal", async () => {
    const h = harness();
    const opener = createBackgroundAgentTabOpener(h.deps);
    opener.open(target);
    await turn();
    opener.dispose();
    h.hydrate();
    await turn();
    expect(h.opened).toEqual([]);
    const offline = harness();
    offline.setOffline(true);
    const other = createBackgroundAgentTabOpener(offline.deps);
    other.open(target);
    await turn();
    other.dispose();
    expect(offline.subscriptions.size).toBe(0);
    offline.reconnect();
    await turn();
    expect(offline.calls()).toBe(1);
    expect(offline.opened).toEqual([]);
  });
  it("allows an explicit retry after a connected RPC failure", async () => {
    const h = harness();
    h.hydrate();
    let failed = false;
    h.deps.fetchWorkspaceId = async () => {
      if (!failed) {
        failed = true;
        throw new Error("RPC timeout");
      }
      return "workspace";
    };
    const opener = createBackgroundAgentTabOpener(h.deps);
    opener.open(target);
    await turn();
    expect(h.subscriptions.size).toBe(0);
    opener.open(target);
    await turn();
    expect(h.opened).toEqual([{ workspaceKey: "server:workspace", agentId: "agent" }]);
    opener.dispose();
  });
  it.each([false, true])(
    "closes readiness registration across a missed transition (sync=%s)",
    async (sync) => {
      const h = harness();
      h.hydrate();
      h.setOffline(true);
      let calls = 0;
      let unsubscribed = 0;
      h.deps.fetchWorkspaceId = async () => {
        calls++;
        if (calls === 1) {
          if (!sync) h.setOffline(false);
          throw new Error("offline");
        }
        return "workspace";
      };
      h.deps.subscribeHostReady = (_server, changed) => {
        if (sync) {
          h.setOffline(false);
          changed();
        }
        return () => {
          unsubscribed++;
        };
      };
      const opener = createBackgroundAgentTabOpener(h.deps);
      opener.open(target);
      await turn();
      expect(h.opened).toEqual([{ workspaceKey: "server:workspace", agentId: "agent" }]);
      expect(unsubscribed).toBe(1);
      opener.dispose();
      expect(unsubscribed).toBe(1);
    },
  );
  it("closes a synchronous readiness subscription when the immediate retry fails and allows another open", async () => {
    const h = harness();
    h.setOffline(true);
    h.hydrate();
    let calls = 0;
    let unsubscribed = 0;
    h.deps.fetchWorkspaceId = async () => {
      calls++;
      if (calls === 1) throw new Error("offline");
      if (calls === 2) throw new Error("connected RPC timeout");
      return "workspace";
    };
    h.deps.subscribeHostReady = (_server, changed) => {
      h.setOffline(false);
      changed();
      return () => {
        unsubscribed++;
      };
    };
    const opener = createBackgroundAgentTabOpener(h.deps);
    opener.open(target);
    await turn();
    expect(calls).toBe(2);
    expect(unsubscribed).toBe(1);
    opener.open(target);
    await turn();
    expect(calls).toBe(3);
    expect(h.opened).toEqual([{ workspaceKey: "server:workspace", agentId: "agent" }]);
    opener.dispose();
    expect(unsubscribed).toBe(1);
  });
});
