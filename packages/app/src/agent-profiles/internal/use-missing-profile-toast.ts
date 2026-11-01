import { useQueryClient } from "@tanstack/react-query";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { daemonConfigQueryRoot } from "@/data/daemon-config";
import { useHosts } from "@/runtime/host-runtime";
import { findAgentProfileForShortcut } from "../shortcuts";

export function useMissingAgentProfileToast(serverId: string | null): (profileKey: string) => void {
  const queryClient = useQueryClient();
  const hosts = useHosts();
  const toast = useToast();
  const { t } = useTranslation();
  return (profileKey) => {
    const configs = queryClient.getQueriesData<MutableDaemonConfig>({
      queryKey: daemonConfigQueryRoot,
    });
    let name = profileKey;
    for (const [, config] of configs) {
      const profile = findAgentProfileForShortcut(config?.agentProfiles, profileKey);
      if (profile) {
        name = profile.name;
        break;
      }
    }
    const host = hosts.find((entry) => entry.serverId === serverId)?.label ?? serverId;
    toast.show(t("settings.shortcuts.profiles.missing", { name, host }), { variant: "warning" });
  };
}
