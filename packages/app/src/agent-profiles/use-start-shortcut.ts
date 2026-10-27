import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { buildWorkspaceDraftAgentConfig } from "@/screens/workspace/workspace-draft-agent-config";
import { materializeAgentProfile } from "./internal/materialize-profile";
import { useAgentProfiles } from "./internal/use-agent-profiles";

interface StartShortcutInput {
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  enabled: boolean;
  onCreated: (agentId: string) => void;
}

export function useAgentProfileStartShortcut(input: StartShortcutInput) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(input.serverId);
  const { profiles, isSupported } = useAgentProfiles(input.serverId);
  const pending = useRef(false);
  useKeyboardActionHandler({
    handlerId: `profile-start:${input.serverId}:${input.workspaceId}`,
    actions: ["agent-profile.start"],
    enabled: input.enabled && isSupported,
    priority: 100,
    handle: (action) => {
      if (action.id !== "agent-profile.start" || action.serverId !== input.serverId) return false;
      const profile = profiles?.find((entry) => entry.id === action.profileId);
      if (!profile || !client || !input.cwd || !input.workspaceId) return false;
      if (pending.current) return true;
      pending.current = true;
      const dismissPending = toast.show(
        t("settings.shortcuts.profiles.starting", { name: profile.name }),
        { durationMs: null },
      );
      const resolved = materializeAgentProfile(profile);
      const config = buildWorkspaceDraftAgentConfig({
        provider: resolved.provider,
        cwd: input.cwd,
        model: resolved.modelId,
        modeId: resolved.modeId,
        thinkingOptionId: resolved.thinkingOptionId,
        featureValues: resolved.featureValues,
      });
      void client
        .createAgent({ workspaceId: input.workspaceId, config })
        .then((agent) => {
          dismissPending();
          return input.onCreated(agent.id);
        })
        .catch((error) => {
          toast.show(toErrorMessage(error), { variant: "error", durationMs: null });
        })
        .finally(() => {
          pending.current = false;
        });
      return true;
    },
  });
}
