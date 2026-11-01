import { useId } from "react";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useAgentProfiles } from "./internal/use-agent-profiles";
import type { AgentProfilePicker } from "./internal/use-agent-profile-picker";
import { useMissingAgentProfileToast } from "./internal/use-missing-profile-toast";
import { findAgentProfileForShortcut } from "./shortcuts";

interface SelectShortcutInput {
  serverId: string | null;
  agentProfiles: AgentProfilePicker | null;
  onApplyAgentProfile: ((profileId: string) => void) | undefined;
  enabled: boolean;
}

export function useAgentProfileSelectShortcut(input: SelectShortcutInput) {
  const handlerId = useId();
  const { profiles, isSupported } = useAgentProfiles(input.serverId);
  const showMissingProfile = useMissingAgentProfileToast(input.serverId);
  useKeyboardActionHandler({
    handlerId,
    actions: ["agent-profile.select"],
    enabled: input.enabled && isSupported,
    priority: 200,
    handle: (action) => {
      if (
        action.id !== "agent-profile.select" ||
        profiles === null ||
        !input.onApplyAgentProfile ||
        !input.agentProfiles
      )
        return false;
      const profile = findAgentProfileForShortcut(profiles, action.profileKey);
      if (!profile) {
        showMissingProfile(action.profileKey);
        return true;
      }
      if (!input.agentProfiles.rows.some((row) => row.id === profile.id)) return false;
      input.onApplyAgentProfile(profile.id);
      return true;
    },
  });
}
