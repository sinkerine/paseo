import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { ParsedShortcutBinding, ShortcutOverrides } from "@/keyboard/keyboard-shortcuts";

// Profile shortcuts are keyed by name; the active surface supplies the host at dispatch.
export type AgentProfileShortcutAction = "agent-profile.select" | "agent-profile.start";

export function agentProfileShortcutKey(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function agentProfileShortcutId(
  action: AgentProfileShortcutAction,
  profileKey: string,
): string {
  return JSON.stringify([action, profileKey]);
}

function parseProfileShortcutId(id: string): unknown[] | null {
  if (!id.startsWith('["agent-profile.')) return null;
  try {
    const value: unknown = JSON.parse(id);
    if (!Array.isArray(value)) return null;
    if (value[0] !== "agent-profile.select" && value[0] !== "agent-profile.start") return null;
    return value;
  } catch {
    return null;
  }
}

export function agentProfileShortcutBinding(id: string): ParsedShortcutBinding | null {
  const value = parseProfileShortcutId(id);
  if (!value || value.length !== 2) return null;
  const [action, profileKey] = value;
  if (action !== "agent-profile.select" && action !== "agent-profile.start") return null;
  if (typeof profileKey !== "string" || !profileKey.trim()) return null;
  return {
    id,
    action,
    combo: "",
    parsedChord: [],
    repeat: false,
    when: { commandCenter: false },
    payload: { type: "agent-profile", profileKey },
  };
}

export function findAgentProfileForShortcut<T extends { name: string }>(
  profiles: readonly T[] | null | undefined,
  profileKey: string,
): T | null {
  if (!profileKey) return null;
  return profiles?.find((profile) => agentProfileShortcutKey(profile.name) === profileKey) ?? null;
}

// COMPAT(sharedProfileShortcuts): added 2026-10-31, remove after 2027-04-30
interface LegacyProfileShortcut {
  action: AgentProfileShortcutAction;
  profileId: string;
}

// COMPAT(sharedProfileShortcuts): added 2026-10-31, remove after 2027-04-30
function legacyProfileShortcut(id: string, serverId: string): LegacyProfileShortcut | null {
  const value = parseProfileShortcutId(id);
  if (!value || value.length !== 3) return null;
  const [action, host, profileId] = value;
  if (action !== "agent-profile.select" && action !== "agent-profile.start") return null;
  if (host !== serverId || typeof profileId !== "string") return null;
  return { action, profileId };
}

// COMPAT(sharedProfileShortcuts): added 2026-10-31, remove after 2027-04-30
export function hasLegacyAgentProfileShortcuts(
  overrides: ShortcutOverrides,
  serverId: string,
): boolean {
  return Object.keys(overrides).some((id) => legacyProfileShortcut(id, serverId) !== null);
}

// COMPAT(sharedProfileShortcuts): added 2026-10-31, remove after 2027-04-30
export function migrateLegacyAgentProfileShortcuts(
  overrides: ShortcutOverrides,
  serverId: string,
  profiles: readonly AgentProfile[],
): ShortcutOverrides {
  const legacy = Object.entries(overrides).flatMap(([id, combo]) => {
    const parsed = legacyProfileShortcut(id, serverId);
    return parsed ? [{ id, combo, ...parsed }] : [];
  });
  if (!legacy.length) return overrides;
  const next = { ...overrides };
  for (const { id } of legacy) delete next[id];
  for (const profile of profiles) {
    const key = agentProfileShortcutKey(profile.name);
    if (!key) continue;
    for (const entry of legacy) {
      if (entry.profileId !== profile.id || entry.combo === null) continue;
      const id = agentProfileShortcutId(entry.action, key);
      if (!Object.hasOwn(next, id)) next[id] = entry.combo;
    }
  }
  return next;
}
