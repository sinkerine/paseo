import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { createElement, useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { AgentCapabilityFlags } from "@getpaseo/protocol/agent-types";
import type { ToastApi, DismissToast } from "@/components/toast-host";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-api-context";
import type { ForkAgentBoundary } from "./use-fork-agent";
import { useStableEvent } from "./use-stable-event";
import { useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { toErrorMessage } from "@/utils/error-messages";

const pendingForks = new Set<string>();
const listeners = new Set<() => void>();
let pendingSnapshot: ReadonlySet<string> = new Set();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const notify = () => {
  pendingSnapshot = new Set(pendingForks);
  for (const listener of listeners) listener();
};
const forkKey = (serverId: string, agentId: string) => JSON.stringify([serverId, agentId]);

export function useNativeForkPending(serverId: string, agentId: string): boolean {
  return useSyncExternalStore(subscribe, () => pendingForks.has(forkKey(serverId, agentId)));
}

export function isNativeSessionForkAvailable(
  capabilities: AgentCapabilityFlags | undefined,
  readOnly = false,
): boolean {
  return capabilities?.supportsNativeSessionFork === true && !readOnly;
}

export interface NativeForkAgentRequest {
  agentId: string;
  workspaceId: string;
  target: "turn" | "latest";
  boundary?: ForkAgentBoundary;
}

export function useNativeForkAgent(input: {
  serverId: string;
  toast?: ToastApi | null;
}): (request: NativeForkAgentRequest) => Promise<void> {
  const { t } = useTranslation();
  const sharedToast = useToast();
  const toast = input.toast ?? sharedToast;
  return useStableEvent(async (request) => {
    const key = forkKey(input.serverId, request.agentId);
    if (pendingForks.has(key)) return;
    pendingForks.add(key);
    notify();
    try {
      const client = useSessionStore.getState().sessions[input.serverId]?.client;
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      const agent = await client.forkAgentSession(request.agentId, {
        target: request.target,
        ...request.boundary,
      });
      const source = useSessionStore
        .getState()
        .sessions[input.serverId]?.agents.get(request.agentId);
      getHostRuntimeStore().acceptAgentSnapshot(input.serverId, {
        ...normalizeAgentSnapshot(agent, input.serverId),
        ...(source?.projectPlacement ? { projectPlacement: source.projectPlacement } : {}),
      });
      navigateToWorkspace({
        serverId: input.serverId,
        workspaceId: request.workspaceId,
        target: { kind: "agent", agentId: agent.id },
      });
    } catch (error) {
      let dismiss: DismissToast = () => {};
      const content = createElement(
        Alert,
        {
          variant: "error",
          title: t("message.actions.forkSessionFailed"),
          description: toErrorMessage(error),
          testID: "native-session-fork-error",
        },
        createElement(
          Button,
          {
            variant: "ghost",
            size: "sm",
            testID: "native-session-fork-error-dismiss",
            onPress: () => dismiss(),
          },
          t("common.actions.dismiss"),
        ),
      );
      dismiss = toast.show(content, {
        durationMs: null,
        testID: "native-session-fork-error-toast",
      });
    } finally {
      pendingForks.delete(key);
      notify();
    }
  });
}

/** The tab collection subscribes once; individual rows receive derived action data. */
export function useNativeForkTabActions(
  serverId: string,
  workspaceId: string,
  onSettled?: () => void,
) {
  const { t } = useTranslation();
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);
  const pendingRequests = useSyncExternalStore(subscribe, () => pendingSnapshot);
  const fork = useNativeForkAgent({ serverId });
  return useCallback(
    (agentId: string) => {
      const agent = agents?.get(agentId);
      if (!agent || !isNativeSessionForkAvailable(agent.capabilities)) return undefined;
      const pending = pendingRequests.has(forkKey(serverId, agentId));
      return {
        pending,
        disabled: pending || agent.status === "running",
        tooltip: agent.status === "running" ? t("message.actions.forkSessionRunning") : undefined,
        onSelect: async () => {
          await fork({ agentId, workspaceId, target: "latest" });
          onSettled?.();
        },
      };
    },
    [agents, pendingRequests, fork, serverId, workspaceId, t, onSettled],
  );
}
