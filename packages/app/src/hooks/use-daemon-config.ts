import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useReplicaQuery } from "@/data/query";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

interface UseDaemonConfigResult {
  config: MutableDaemonConfig | null;
  isLoading: boolean;
  patchConfig: (patch: MutableDaemonConfigPatch) => Promise<MutableDaemonConfig | undefined>;
}

export function daemonConfigReplicaInput(input: {
  serverId: string | null;
  client: DaemonClient | null;
  isConnected: boolean;
  disconnectedMessage: string;
}) {
  const { serverId, client, isConnected, disconnectedMessage } = input;
  return {
    queryKey: daemonConfigQueryKey(serverId),
    enabled: Boolean(serverId && client && isConnected),
    pushEvent: "status:daemon_config_changed",
    queryFn: async () => {
      if (!client) {
        throw new Error(disconnectedMessage);
      }
      const result = await client.getDaemonConfig();
      return result.config;
    },
  };
}

export function useDaemonConfig(serverId: string | null): UseDaemonConfigResult {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const queryKey = useMemo(() => daemonConfigQueryKey(serverId), [serverId]);

  const configQuery = useReplicaQuery(
    daemonConfigReplicaInput({
      serverId,
      client,
      isConnected,
      disconnectedMessage: t("workspace.terminal.hostDisconnected"),
    }),
  );

  const patchConfig = useCallback(
    async (patch: MutableDaemonConfigPatch) => {
      if (!client) {
        return undefined;
      }
      const result = await client.patchDaemonConfig(patch);
      queryClient.setQueryData(queryKey, result.config);
      return result.config;
    },
    [client, queryClient, queryKey],
  );

  return {
    config: configQuery.data ?? null,
    isLoading: configQuery.isLoading,
    patchConfig,
  };
}
