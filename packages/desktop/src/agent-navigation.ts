import { parseAgentDeepLink, type AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";

export function parseAgentDeepLinkFromArgv(argv: string[]): AgentDeepLinkTarget | null {
  for (const arg of argv) {
    const target = parseAgentDeepLink(arg);
    if (target) {
      return target;
    }
  }
  return null;
}

export class AgentNavigationInbox {
  private readonly readyWindows = new Set<number>();
  private readonly pendingForegroundByWindow = new Map<number, AgentDeepLinkTarget>();

  private readonly pendingBackgroundByWindow = new Map<number, AgentDeepLinkTarget[]>();

  drainBackground(webContentsId: number): AgentDeepLinkTarget[] {
    const pending = this.pendingBackgroundByWindow.get(webContentsId) ?? [];
    this.pendingBackgroundByWindow.delete(webContentsId);
    return pending;
  }

  windowLoading(webContentsId: number): void {
    this.readyWindows.delete(webContentsId);
  }

  windowReady(webContentsId: number): AgentDeepLinkTarget | null {
    this.readyWindows.add(webContentsId);
    const pending = this.pendingForegroundByWindow.get(webContentsId) ?? null;
    this.pendingForegroundByWindow.delete(webContentsId);
    if (pending) {
      const background = this.pendingBackgroundByWindow.get(webContentsId) ?? [];
      this.pendingBackgroundByWindow.set(
        webContentsId,
        background.filter(
          (target) => target.serverId !== pending.serverId || target.agentId !== pending.agentId,
        ),
      );
    }
    return pending;
  }

  deliverOrQueue(webContentsId: number, target: AgentDeepLinkTarget): AgentDeepLinkTarget | null {
    if (this.readyWindows.has(webContentsId)) {
      return target;
    }
    const matches = (candidate: AgentDeepLinkTarget) =>
      candidate.serverId === target.serverId && candidate.agentId === target.agentId;
    const background = this.pendingBackgroundByWindow.get(webContentsId) ?? [];
    if (target.focus === false) {
      if (!background.some(matches)) {
        this.pendingBackgroundByWindow.set(webContentsId, [
          ...background,
          { serverId: target.serverId, agentId: target.agentId, focus: false },
        ]);
      }
    } else {
      this.pendingForegroundByWindow.set(webContentsId, {
        serverId: target.serverId,
        agentId: target.agentId,
      });
    }
    return null;
  }

  removeWindow(webContentsId: number): void {
    this.readyWindows.delete(webContentsId);
    this.pendingForegroundByWindow.delete(webContentsId);
    this.pendingBackgroundByWindow.delete(webContentsId);
  }
}
