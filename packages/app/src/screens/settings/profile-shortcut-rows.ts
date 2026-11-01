import type { TFunction } from "i18next";
import type { HostAgentProfiles } from "@/agent-profiles";
import { agentProfileShortcutId, agentProfileShortcutKey } from "@/agent-profiles/shortcuts";
import type { KeyboardShortcutHelpRow } from "@/keyboard/keyboard-shortcuts";

export function buildProfileShortcutRows(input: {
  hosts: readonly HostAgentProfiles[];
  hostLabel: (serverId: string) => string;
  t: TFunction;
}): KeyboardShortcutHelpRow[] {
  const names = new Map<string, { name: string; hosts: Set<string> }>();
  for (const host of input.hosts) {
    for (const profile of host.profiles) {
      const key = agentProfileShortcutKey(profile.name);
      if (!key) continue;
      let entry = names.get(key);
      if (!entry) {
        entry = { name: profile.name, hosts: new Set() };
        names.set(key, entry);
      }
      entry.hosts.add(host.serverId);
    }
  }
  return Array.from(names).flatMap(([key, entry]) => {
    const note = Array.from(entry.hosts, input.hostLabel).join(", ");
    return (["agent-profile.select", "agent-profile.start"] as const).map((action) => {
      const labelKey = action === "agent-profile.select" ? "select" : "start";
      const label = input.t(`settings.shortcuts.profiles.${labelKey}`, { name: entry.name });
      return { id: agentProfileShortcutId(action, key), label, labelKey: label, chord: null, note };
    });
  });
}
