import { PendingOpenProjectStore } from "../pending-open-project-store.js";

export interface DesktopActiveWorkspaceSelection {
  serverId: string;
  workspaceId: string;
}

interface AgentTarget {
  serverId: string;
  agentId: string;
  focus?: boolean;
}

export interface OwnedDesktopWindow<TAgentTarget extends AgentTarget> {
  webContentsId: number;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  sendAgent(target: TAgentTarget): void;
}

export interface DesktopWindowOwnerPort<TAgentTarget extends AgentTarget> {
  create(input: {
    initialRoute: string | null;
    restoreWindowState: boolean;
    showInactive?: boolean;
    onCreated(webContentsId: number): void;
    onClosed(webContentsId: number): void;
  }): Promise<OwnedDesktopWindow<TAgentTarget>>;
  windows(): OwnedDesktopWindow<TAgentTarget>[];
  focusedWindow(): OwnedDesktopWindow<TAgentTarget> | null;
  agentRoute(target: TAgentTarget): string;
  deliverAgent(webContentsId: number, target: TAgentTarget): TAgentTarget | null;
  resolveAgentWorkspace?(
    target: Pick<TAgentTarget, "serverId" | "agentId">,
  ): Promise<string | null>;
}

export interface DesktopWindowOwner<TAgentTarget extends AgentTarget> {
  openPrimary(input?: {
    initialRoute?: string | null;
    pendingProjectPath?: string | null;
    showInactive?: boolean;
  }): Promise<void>;
  openAdditional(input?: { pendingProjectPath?: string | null }): Promise<void>;
  openOrFocusAgent(target: TAgentTarget): Promise<void>;
  restoreWhenActivated(): Promise<void>;
  setActiveWorkspace(
    webContentsId: number,
    selection: DesktopActiveWorkspaceSelection | null,
  ): void;
  takePendingProject(webContentsId: number): string | null;
}

export function createDesktopWindowOwner<TAgentTarget extends AgentTarget>(
  port: DesktopWindowOwnerPort<TAgentTarget>,
): DesktopWindowOwner<TAgentTarget> {
  const pendingProjects = new PendingOpenProjectStore();
  const activeWorkspaceByWindow = new Map<number, DesktopActiveWorkspaceSelection>();
  let agentWindowCreation: Promise<void> | null = null;

  const open = async (input: {
    initialRoute: string | null;
    pendingProjectPath: string | null;
    restoreWindowState: boolean;
    showInactive?: boolean;
  }): Promise<void> => {
    await port.create({
      initialRoute: input.initialRoute,
      restoreWindowState: input.restoreWindowState,
      ...(input.showInactive ? { showInactive: true } : {}),
      onCreated: (webContentsId) => pendingProjects.set(webContentsId, input.pendingProjectPath),
      onClosed: (webContentsId) => {
        pendingProjects.delete(webContentsId);
        activeWorkspaceByWindow.delete(webContentsId);
      },
    });
  };

  const owner: DesktopWindowOwner<TAgentTarget> = {
    openPrimary: (input = {}) =>
      open({
        initialRoute: input.initialRoute ?? null,
        pendingProjectPath: input.pendingProjectPath ?? null,
        restoreWindowState: true,
        ...(input.showInactive ? { showInactive: true } : {}),
      }),
    openAdditional: (input = {}) =>
      open({
        initialRoute: null,
        pendingProjectPath: input.pendingProjectPath ?? null,
        restoreWindowState: false,
      }),
    async openOrFocusAgent(target) {
      const windows = port.windows().filter((candidate) => !candidate.isDestroyed());
      if (!windows.length) {
        if (agentWindowCreation) {
          await agentWindowCreation;
          return owner.openOrFocusAgent(target);
        }
        agentWindowCreation = owner
          .openPrimary(
            target.focus === false
              ? { initialRoute: null, showInactive: true }
              : { initialRoute: port.agentRoute(target) },
          )
          .finally(() => {
            agentWindowCreation = null;
          });
        await agentWindowCreation;
        if (target.focus === false) await owner.openOrFocusAgent(target);
        return;
      }
      const workspaceId =
        windows.length > 1
          ? ((await port.resolveAgentWorkspace?.(target).catch(() => null)) ?? null)
          : null;
      const liveWindows = windows.filter((candidate) => !candidate.isDestroyed());
      const matching = workspaceId
        ? liveWindows.filter((candidate) => {
            const selection = activeWorkspaceByWindow.get(candidate.webContentsId);
            return selection?.serverId === target.serverId && selection.workspaceId === workspaceId;
          })
        : [];
      const focused = port.focusedWindow();
      const choose = (candidates: OwnedDesktopWindow<TAgentTarget>[]) =>
        candidates.find((candidate) => candidate.webContentsId === focused?.webContentsId) ??
        candidates.find((candidate) => candidate.isVisible()) ??
        candidates[0];
      const window = choose(matching) ?? choose(liveWindows);
      if (!window) return owner.openOrFocusAgent(target);
      if (target.focus === false) {
        for (const recipient of matching.length ? matching : [window]) {
          const deliverable = port.deliverAgent(recipient.webContentsId, target);
          if (deliverable) recipient.sendAgent(deliverable);
        }
        return;
      }
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      const deliverable = port.deliverAgent(window.webContentsId, target);
      if (deliverable) window.sendAgent(deliverable);
    },
    async restoreWhenActivated() {
      if (port.windows().length === 0) await owner.openPrimary();
    },
    setActiveWorkspace: (id, selection) => {
      if (selection) activeWorkspaceByWindow.set(id, selection);
      else activeWorkspaceByWindow.delete(id);
    },
    takePendingProject: (webContentsId) => pendingProjects.take(webContentsId),
  };
  return owner;
}
