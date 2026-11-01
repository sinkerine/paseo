import { useCallback } from "react";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { useTranslation } from "react-i18next";
import { useReplicaQueries } from "@/data/query";
import { getHostRuntimeStore, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";
import { daemonConfigReplicaInput, useDaemonConfig } from "@/hooks/use-daemon-config";
import { useSessionStore } from "@/stores/session-store";
import { supportsAgentProfiles } from "./capabilities";

export interface UseAgentProfilesResult {
  /** `null` until the daemon config has arrived. */
  profiles: AgentProfile[] | null;
  /** False on daemons that predate agent profiles, or while disconnected. */
  isSupported: boolean;
  /** Writes the whole list; there is no per-profile RPC. */
  saveProfiles: (next: AgentProfile[]) => Promise<void>;
}

export function useAgentProfiles(serverId: string | null): UseAgentProfilesResult {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const isSupported = useSessionStore((state) => {
    return supportsAgentProfiles(state.sessions[serverId ?? ""]?.serverInfo?.features);
  });

  const saveProfiles = useCallback(
    async (next: AgentProfile[]) => {
      await patchConfig({ agentProfiles: next });
    },
    [patchConfig],
  );

  return {
    profiles: config ? (config.agentProfiles ?? []) : null,
    isSupported,
    saveProfiles,
  };
}

export interface HostAgentProfiles {
  serverId: string;
  profiles: AgentProfile[];
}

/** Hosts whose daemon supports profiles and whose config has loaded, in `serverIds` order. */
export function useAgentProfilesForHosts(serverIds: readonly string[]): HostAgentProfiles[] {
  const { t } = useTranslation();
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  const support = useSessionStore((state) =>
    serverIds
      .map((serverId) =>
        supportsAgentProfiles(state.sessions[serverId]?.serverInfo?.features) ? "1" : "0",
      )
      .join(""),
  );
  const supportedIds = serverIds.filter((_, index) => support[index] === "1");
  const store = getHostRuntimeStore();
  const queries = useReplicaQueries(
    supportedIds.map((serverId) =>
      daemonConfigReplicaInput({
        serverId,
        client: store.getClient(serverId),
        isConnected: statuses.get(serverId) === "online",
        disconnectedMessage: t("workspace.terminal.hostDisconnected"),
      }),
    ),
  );
  return queries.flatMap((query, index) =>
    query.data
      ? [
          {
            serverId: supportedIds[index]!,
            profiles: query.data.agentProfiles ?? [],
          },
        ]
      : [],
  );
}
