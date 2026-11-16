import { useEffect, useRef } from "react";
import { i18n } from "@/i18n/i18next";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost } from "@/desktop/host";
import { useStableEvent } from "@/hooks/use-stable-event";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";

interface AgentTarget {
  serverId: string;
  agentId: string;
}
export interface OpenAgentTabInBackgroundDeps {
  isHostReady: (serverId: string) => boolean;
  readCachedWorkspaceId: (target: AgentTarget) => string | null;
  fetchWorkspaceId: (target: AgentTarget) => Promise<string | null>;
  subscribeHostReady: (serverId: string, onChange: () => void) => () => void;
  prepareWorkspace: (workspaceKey: string) => Promise<void>;
  openBackgroundTab: (input: { workspaceKey: string; agentId: string }) => void;
}

export function createBackgroundAgentTabOpener(deps: OpenAgentTabInBackgroundDeps): {
  open: (target: AgentTarget) => void;
  dispose: () => void;
} {
  const pending = new Map<string, { running: boolean; unsubscribe?: () => void }>();
  let disposed = false;
  return {
    open(target) {
      const key = `${target.serverId}:${target.agentId}`;
      if (disposed || pending.has(key)) return;
      const entry: { running: boolean; unsubscribe?: () => void } = { running: false };
      pending.set(key, entry);
      const finish = () => {
        entry.unsubscribe?.();
        entry.unsubscribe = undefined;
        pending.delete(key);
      };
      const attempt = async () => {
        if (disposed || entry.running) return;
        entry.running = true;
        const wasReady = deps.isHostReady(target.serverId);
        let workspaceId: string | null;
        try {
          workspaceId = deps.readCachedWorkspaceId(target) ?? (await deps.fetchWorkspaceId(target));
        } catch {
          entry.running = false;
          if (disposed || wasReady) {
            finish();
            return;
          }
          // Registration can notify synchronously, or connectivity can change before catch runs.
          let waiting = true;
          let unsubscribe: (() => void) | undefined;
          const retry = () => {
            if (!waiting || disposed || !deps.isHostReady(target.serverId)) return;
            waiting = false;
            unsubscribe?.();
            entry.unsubscribe = undefined;
            void attempt().catch(finish);
          };
          unsubscribe = deps.subscribeHostReady(target.serverId, retry);
          if (waiting) {
            entry.unsubscribe = () => {
              waiting = false;
              unsubscribe?.();
            };
            retry();
          } else unsubscribe();
          return;
        }
        try {
          if (workspaceId) {
            const workspaceKey = `${target.serverId}:${workspaceId}`;
            await deps.prepareWorkspace(workspaceKey);
            if (!disposed)
              deps.openBackgroundTab({
                workspaceKey,
                agentId: target.agentId,
              });
          }
        } finally {
          finish();
        }
      };
      void attempt().catch(finish);
    },
    dispose() {
      disposed = true;
      for (const entry of pending.values()) entry.unsubscribe?.();
      pending.clear();
    },
  };
}

function readCachedWorkspaceId({ serverId, agentId }: AgentTarget): string | null {
  const session = useSessionStore.getState().sessions[serverId];
  return (session?.agents.get(agentId) ?? session?.agentDetails.get(agentId))?.workspaceId ?? null;
}
async function fetchWorkspaceId({ serverId, agentId }: AgentTarget): Promise<string | null> {
  const runtime = getHostRuntimeStore();
  await runtime.prepareAgentRoute(serverId, agentId);
  const client = runtime.getClient(serverId);
  if (!client || !isHostRuntimeConnected(runtime.getSnapshot(serverId)))
    throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
  return (await client.fetchAgent({ agentId }))?.agent.workspaceId ?? null;
}

interface OpenAgentEventPayload {
  serverId?: unknown;
  agentId?: unknown;
  focus?: unknown;
}

export function AgentNavigationListener() {
  const selection = useActiveWorkspaceSelection();
  const background = useRef<ReturnType<typeof createBackgroundAgentTabOpener> | null>(null);
  useEffect(() => {
    const opener = createBackgroundAgentTabOpener({
      isHostReady: (serverId) =>
        isHostRuntimeConnected(getHostRuntimeStore().getSnapshot(serverId)),
      readCachedWorkspaceId,
      fetchWorkspaceId,
      subscribeHostReady: (serverId, onChange) =>
        getHostRuntimeStore().subscribe(serverId, () => {
          if (isHostRuntimeConnected(getHostRuntimeStore().getSnapshot(serverId))) onChange();
        }),
      prepareWorkspace: async (workspaceKey) => {
        await new Promise<void>((resolve) => {
          if (useWorkspaceLayoutStore.persist.hasHydrated()) {
            resolve();
            return;
          }
          const unsubscribe = useWorkspaceLayoutStore.persist.onFinishHydration(() => {
            unsubscribe();
            resolve();
          });
        });
        if (useWorkspaceLayoutStore.getState().activeWorkspaceKey !== workspaceKey)
          await useWorkspaceLayoutStore.getState().syncWorkspaceFromStorage(workspaceKey);
      },
      openBackgroundTab: ({ workspaceKey, agentId }) => {
        useWorkspaceLayoutStore.getState().openTab({
          workspaceKey,
          target: { kind: "agent", agentId },
          intent: "background",
          pin: true,
        });
      },
    });
    background.current = opener;
    return () => {
      opener.dispose();
      background.current = null;
    };
  }, []);
  const activeServerId = selection?.serverId;
  const activeWorkspaceId = selection?.workspaceId;
  useEffect(() => {
    void getDesktopHost()?.agentNavigation?.setActiveWorkspace?.(
      activeServerId && activeWorkspaceId
        ? { serverId: activeServerId, workspaceId: activeWorkspaceId }
        : null,
    );
  }, [activeServerId, activeWorkspaceId]);
  useEffect(() => {
    const bridge = getDesktopHost()?.agentNavigation;
    const reply = async (requestId: string, target: AgentTarget) => {
      let workspaceId = readCachedWorkspaceId(target);
      try {
        workspaceId ??= await fetchWorkspaceId(target);
      } catch {
        workspaceId = null;
      }
      await bridge?.replyResolveWorkspace?.(requestId, { workspaceId });
    };
    return bridge?.onResolveWorkspaceRequest?.((requestId, target) => {
      void reply(requestId, target);
    });
  }, []);
  const openAgent = useStableEvent((payload: OpenAgentEventPayload | null) => {
    const serverId = typeof payload?.serverId === "string" ? payload.serverId.trim() : "";
    const agentId = typeof payload?.agentId === "string" ? payload.agentId.trim() : "";
    if (!serverId || !agentId) {
      return;
    }
    if (payload?.focus === false) background.current?.open({ serverId, agentId });
    else navigateToAgent({ serverId, agentId, pin: true });
  });

  useEffect(() => {
    const host = getDesktopHost();
    const ready = host?.agentNavigation?.ready;
    if (typeof host?.events?.on !== "function" || typeof ready !== "function") {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      let dispose: (() => void) | null = null;
      try {
        dispose = await listenToDesktopEvent<OpenAgentEventPayload>("open-agent", openAgent);
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        const pending = await ready();
        if (!disposed && pending) {
          openAgent(pending);
        }
      } catch {
        dispose?.();
        if (unlisten === dispose) {
          unlisten = null;
        }
        if (!disposed) {
          retryTimer = setTimeout(() => void connect(), 1_000);
        }
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      unlisten?.();
    };
  }, [openAgent]);

  return null;
}
