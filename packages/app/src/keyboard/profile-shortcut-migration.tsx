import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAgentProfiles } from "@/agent-profiles";
import {
  hasLegacyAgentProfileShortcuts,
  migrateLegacyAgentProfileShortcuts,
} from "@/agent-profiles/shortcuts";
import {
  getShortcutOverrideStore,
  useKeyboardShortcutOverrides,
} from "@/hooks/use-keyboard-shortcut-overrides";

interface MigrationAttempt {
  serverId: string;
  profiles: ReturnType<typeof useAgentProfiles>["profiles"];
}

// The hook returns a fresh empty array when loaded config omits agentProfiles.
const EMPTY_AGENT_PROFILES: NonNullable<MigrationAttempt["profiles"]> = [];

// COMPAT(sharedProfileShortcuts): added 2026-10-31, remove after 2027-04-30
export function ProfileShortcutMigration({ serverId }: { serverId: string }): ReactNode {
  const { overrides, isLoading } = useKeyboardShortcutOverrides();
  // Optimistic removal unmounts the child; a failed write must not retry the same input.
  const attemptedMigration = useRef<MigrationAttempt | null>(null);
  if (isLoading || !hasLegacyAgentProfileShortcuts(overrides, serverId)) return null;
  return (
    <LoadedProfileShortcutMigration serverId={serverId} attemptedMigration={attemptedMigration} />
  );
}

// COMPAT(sharedProfileShortcuts): added 2026-10-31, remove after 2027-04-30
interface LoadedProfileShortcutMigrationProps {
  serverId: string;
  attemptedMigration: RefObject<MigrationAttempt | null>;
}

function LoadedProfileShortcutMigration({
  serverId,
  attemptedMigration,
}: LoadedProfileShortcutMigrationProps): ReactNode {
  const queryClient = useQueryClient();
  const { profiles: loadedProfiles, isSupported } = useAgentProfiles(serverId);
  const profiles = loadedProfiles?.length === 0 ? EMPTY_AGENT_PROFILES : loadedProfiles;

  useEffect(() => {
    if (!isSupported || profiles === null) return;
    const previous = attemptedMigration.current;
    const alreadyAttempted = previous?.serverId === serverId && previous.profiles === profiles;
    if (alreadyAttempted) return;
    attemptedMigration.current = { serverId, profiles };
    void getShortcutOverrideStore(queryClient).update((current) =>
      migrateLegacyAgentProfileShortcuts(current, serverId, profiles),
    );
  }, [attemptedMigration, isSupported, profiles, queryClient, serverId]);

  return null;
}
