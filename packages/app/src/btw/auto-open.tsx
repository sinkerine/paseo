import { useEffect, useRef } from "react";
import { useSessionStore } from "@/stores/session-store";
import { useProviderSubagentStore } from "@/subagents/provider-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { showWorkspaceTargetBeside } from "@/workspace-tabs/open-beside";
import { selectBtwThread, useBtwThread } from "./select";
import { btwTabTarget } from "./tab";
import { refreshBtwOnConnect } from "./refresh-on-connect";

export function BtwAutoOpen({
  serverId,
  workspaceId,
  agentId,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
}): null {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const thread = useBtwThread(serverId, agentId);
  const discovery = useRef({ initialized: false, seen: new Set<string>() });
  useEffect(() => {
    if (!client) return;
    return refreshBtwOnConnect(
      client,
      serverId,
      agentId,
      () => {
        if (discovery.current.initialized) return;
        // An existing thread at the first successful list is a baseline, not a new conversation.
        const prefix = `${serverId}\0${agentId}\0`;
        const rows = [...useProviderSubagentStore.getState().descriptors]
          .filter(([key]) => key.startsWith(prefix))
          .map(([, row]) => row);
        const current = selectBtwThread(rows);
        if (current) discovery.current.seen.add(current.id);
        discovery.current.initialized = true;
      },
      () => {},
    );
  }, [client, serverId, agentId]);
  useEffect(() => {
    if (!thread || !discovery.current.initialized || discovery.current.seen.has(thread.id)) return;
    discovery.current.seen.add(thread.id);
    showWorkspaceTargetBeside({
      workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
      target: btwTabTarget(agentId),
    });
  }, [thread, serverId, workspaceId, agentId]);
  return null;
}
