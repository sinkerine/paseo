import { describe, expect, it } from "vitest";
import { createDesktopWindowOwner, type OwnedDesktopWindow } from "./desktop-window-owner.js";

interface Target {
  serverId: string;
  agentId: string;
  focus?: boolean;
}

function harness() {
  const windows: OwnedDesktopWindow<Target>[] = [];
  const launches: Array<{ initialRoute: string | null; restoreWindowState: boolean }> = [];
  const sent: Target[] = [];
  let nextId = 1;
  let focused: OwnedDesktopWindow<Target> | null = null;
  let closeWindow = (_id: number) => {};
  const owner = createDesktopWindowOwner<Target>({
    async create(input) {
      launches.push({
        initialRoute: input.initialRoute,
        restoreWindowState: input.restoreWindowState,
      });
      const id = nextId++;
      closeWindow = input.onClosed;
      const window: OwnedDesktopWindow<Target> = {
        webContentsId: id,
        isDestroyed: () => false,
        isVisible: () => true,
        isMinimized: () => false,
        restore: () => {},
        show: () => {},
        focus: () => {},
        sendAgent: (target) => sent.push(target),
      };
      windows.push(window);
      input.onCreated(id);
      return window;
    },
    windows: () => windows,
    focusedWindow: () => focused,
    agentRoute: (target) => `/agent/${target.agentId}`,
    deliverAgent: (_id, target) => target,
  });
  return {
    owner,
    launches,
    sent,
    windows,
    setFocused: (window: OwnedDesktopWindow<Target>) => {
      focused = window;
    },
    close: (id: number) => closeWindow(id),
  };
}

describe("desktop window owner", () => {
  it("restores only primary launches and routes pending projects per window", async () => {
    const h = harness();
    await h.owner.openPrimary({ pendingProjectPath: " /project/a " });
    await h.owner.openAdditional({ pendingProjectPath: "/project/b" });
    expect(h.launches).toEqual([
      { initialRoute: null, restoreWindowState: true },
      { initialRoute: null, restoreWindowState: false },
    ]);
    expect(h.owner.takePendingProject(1)).toBe("/project/a");
    expect(h.owner.takePendingProject(2)).toBe("/project/b");
  });

  it("focuses an existing window and delivers agent routing through its inbox", async () => {
    const h = harness();
    await h.owner.openPrimary();
    h.setFocused(h.windows[0]);
    await h.owner.openOrFocusAgent({ serverId: "server", agentId: "agent-7" });
    expect(h.launches).toHaveLength(1);
    expect(h.sent).toEqual([{ serverId: "server", agentId: "agent-7" }]);
  });

  it("removes pending routing state when a window closes", async () => {
    const h = harness();
    await h.owner.openAdditional({ pendingProjectPath: "/project/a" });
    h.close(1);
    expect(h.owner.takePendingProject(1)).toBeNull();
  });
});

describe("workspace affinity and non-focusing opens", () => {
  function setup(workspace: () => Promise<string | null> = async () => "A") {
    const effects: string[] = [];
    const sent: Array<{ window: number; target: Target }> = [];
    const windows: OwnedDesktopWindow<Target>[] = [1, 2, 3].map((id) => ({
      webContentsId: id,
      isDestroyed: () => false,
      isVisible: () => id !== 1,
      isMinimized: () => id === 1,
      restore: () => {
        effects.push(`restore:${id}`);
      },
      show: () => {
        effects.push(`show:${id}`);
      },
      focus: () => {
        effects.push(`focus:${id}`);
      },
      sendAgent: (target) => {
        sent.push({ window: id, target });
      },
    }));
    const launches: unknown[] = [];
    const owner = createDesktopWindowOwner<Target>({
      windows: () => windows,
      focusedWindow: () => windows.find((w) => w.webContentsId === 2) ?? null,
      agentRoute: (target) => `/agent/${target.agentId}`,
      deliverAgent: (_id, target) => target,
      resolveAgentWorkspace: workspace,
      create: async (input) => {
        launches.push({ initialRoute: input.initialRoute, showInactive: input.showInactive });
        const win: OwnedDesktopWindow<Target> = {
          webContentsId: 4,
          isDestroyed: () => false,
          isVisible: () => true,
          isMinimized: () => false,
          restore: () => {},
          show: () => {
            effects.push("show:4");
          },
          focus: () => {
            effects.push("focus:4");
          },
          sendAgent: (target) => {
            sent.push({ window: 4, target });
          },
        };
        windows.push(win);
        input.onCreated(4);
        return win;
      },
    });
    owner.setActiveWorkspace(1, { serverId: "server", workspaceId: "A" });
    owner.setActiveWorkspace(2, { serverId: "server", workspaceId: "B" });
    owner.setActiveWorkspace(3, { serverId: "server", workspaceId: "A" });
    return { owner, effects, sent, windows, launches };
  }

  it("delivers background opens to every matching window without restoring a minimized one", async () => {
    const h = setup();
    const target = { serverId: "server", agentId: "agent-a", focus: false };
    await h.owner.openOrFocusAgent(target);
    expect(h.effects).toEqual([]);
    expect(h.sent).toEqual([
      { window: 1, target },
      { window: 3, target },
    ]);
  });
  it("prefers a visible matching workspace over an unrelated focused window", async () => {
    const h = setup();
    const target = { serverId: "server", agentId: "agent-a" };
    await h.owner.openOrFocusAgent(target);
    expect(h.effects).toEqual(["show:3", "focus:3"]);
    expect(h.sent).toEqual([{ window: 3, target }]);
  });
  it.each(["unseen", "failed"])("falls back cleanly for %s workspace resolution", async (mode) => {
    const h = setup(async () => {
      if (mode === "failed") throw new Error("timeout");
      return null;
    });
    const target = { serverId: "server", agentId: "agent-c", focus: false };
    await h.owner.openOrFocusAgent(target);
    expect(h.effects).toEqual([]);
    expect(h.sent).toEqual([{ window: 2, target }]);
  });
  it("creates an inactive zero-window primary and queues the background target", async () => {
    const h = setup();
    h.windows.splice(0);
    const target = { serverId: "server", agentId: "agent-c", focus: false };
    await h.owner.openOrFocusAgent(target);
    expect(h.launches).toEqual([{ initialRoute: null, showInactive: true }]);
    expect(h.effects).toEqual([]);
    expect(h.sent).toEqual([{ window: 4, target }]);
  });
});
