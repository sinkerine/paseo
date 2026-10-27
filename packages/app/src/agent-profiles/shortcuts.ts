import type { ParsedShortcutBinding } from "@/keyboard/keyboard-shortcuts";

export type AgentProfileShortcutAction = "agent-profile.select" | "agent-profile.start";

export function agentProfileShortcutId(
  action: AgentProfileShortcutAction,
  serverId: string,
  profileId: string,
): string {
  return JSON.stringify([action, serverId, profileId]);
}

export function agentProfileShortcutBinding(id: string): ParsedShortcutBinding | null {
  if (!id.startsWith('["agent-profile.')) return null;
  let value: unknown;
  try {
    value = JSON.parse(id);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [action, serverId, profileId] = value;
  if (action !== "agent-profile.select" && action !== "agent-profile.start") return null;
  if (typeof serverId !== "string" || typeof profileId !== "string") return null;
  return {
    id,
    action,
    combo: "",
    parsedChord: [],
    repeat: false,
    when: { commandCenter: false },
    payload: { type: "agent-profile", serverId, profileId },
  };
}
