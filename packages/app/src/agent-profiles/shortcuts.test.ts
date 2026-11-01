import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import {
  agentProfileShortcutBinding,
  agentProfileShortcutId,
  agentProfileShortcutKey,
  findAgentProfileForShortcut,
  hasLegacyAgentProfileShortcuts,
  migrateLegacyAgentProfileShortcuts,
} from "./shortcuts";

const profiles: AgentProfile[] = [
  { id: "first", name: " Saved ", provider: "pi" },
  { id: "second", name: "SAVED", provider: "claude" },
  { id: "blank", name: " \t ", provider: "pi" },
];
// COMPAT(sharedProfileShortcuts): added 2026-10-31, remove after 2027-04-30
function legacy(profileId: string, host = "host", action = "agent-profile.select") {
  return JSON.stringify([action, host, profileId]);
}

describe("profile shortcut identity", () => {
  it("normalizes NFC, case and whitespace, including blank names", () => {
    expect(agentProfileShortcutKey("  Pi\t Opus\n")).toBe("pi opus");
    expect(agentProfileShortcutKey(" CAFE\u0301 ")).toBe("café");
    expect(agentProfileShortcutKey(" \n\t")).toBe("");
  });

  it.each(["agent-profile.select", "agent-profile.start"] as const)("round trips %s", (action) => {
    const id = agentProfileShortcutId(action, "pi opus");
    expect(id).toBe(JSON.stringify([action, "pi opus"]));
    expect(agentProfileShortcutBinding(id)).toMatchObject({
      id,
      action,
      payload: { type: "agent-profile", profileKey: "pi opus" },
    });
  });

  it.each([
    legacy("first"),
    '["agent-profile.select",""]',
    '["agent-profile.select","  "]',
    '["agent-profile.select",42]',
    '["agent-profile.bad","saved"]',
    '["agent-profile.select",',
    "{}",
  ])("rejects invalid ID %s", (id) => {
    expect(agentProfileShortcutBinding(id)).toBeNull();
  });

  it("resolves the first normalized name and never resolves blank or unloaded profiles", () => {
    expect(findAgentProfileForShortcut(profiles, "saved")).toBe(profiles[0]);
    expect(findAgentProfileForShortcut(profiles, "")).toBeNull();
    expect(findAgentProfileForShortcut(profiles, "missing")).toBeNull();
    expect(findAgentProfileForShortcut(null, "saved")).toBeNull();
    expect(findAgentProfileForShortcut(undefined, "saved")).toBeNull();
  });
});

// COMPAT(sharedProfileShortcuts): added 2026-10-31, remove after 2027-04-30
describe("legacy profile shortcut migration", () => {
  it("migrates in profile list order, drops deleted, blank and null entries, and preserves unrelated keys", () => {
    const unrelated = {
      [legacy("first", "other")]: "Ctrl+O",
      ordinary: "Ctrl+N",
      '["agent-profile.select",42,"first"]': "Ctrl+M",
      '["agent-profile.start","host",3]': "Ctrl+P",
      '["agent-profile.select",': null,
    };
    const overrides = {
      ...unrelated,
      [legacy("second")]: "Ctrl+2",
      [legacy("first")]: "Ctrl+1",
      [legacy("deleted")]: "Ctrl+D",
      [legacy("blank")]: "Ctrl+B",
      [legacy("first", "host", "agent-profile.start")]: null,
    };
    expect(hasLegacyAgentProfileShortcuts(overrides, "host")).toBe(true);
    const migrated = migrateLegacyAgentProfileShortcuts(overrides, "host", profiles);
    expect(migrated).toEqual({
      ...unrelated,
      [agentProfileShortcutId("agent-profile.select", "saved")]: "Ctrl+1",
    });
    expect(hasLegacyAgentProfileShortcuts(migrated, "host")).toBe(false);
    expect(overrides[legacy("first")]).toBe("Ctrl+1");
  });

  it.each(["Ctrl+S", null])("keeps an existing shared override %s", (combo) => {
    const id = agentProfileShortcutId("agent-profile.select", "saved");
    expect(
      migrateLegacyAgentProfileShortcuts(
        { [id]: combo, [legacy("first")]: "Ctrl+1" },
        "host",
        profiles,
      ),
    ).toEqual({ [id]: combo });
  });

  it("migrates both actions and allows a later profile after a null override", () => {
    const overrides = {
      [legacy("first")]: null,
      [legacy("second")]: "Ctrl+2",
      [legacy("first", "host", "agent-profile.start")]: "Ctrl+3",
    };
    expect(migrateLegacyAgentProfileShortcuts(overrides, "host", profiles)).toEqual({
      [agentProfileShortcutId("agent-profile.select", "saved")]: "Ctrl+2",
      [agentProfileShortcutId("agent-profile.start", "saved")]: "Ctrl+3",
    });
  });

  it("returns the same map when no keys belong to this host", () => {
    const overrides = { ordinary: null, [legacy("first", "other")]: "Ctrl+O" };
    expect(hasLegacyAgentProfileShortcuts(overrides, "host")).toBe(false);
    expect(migrateLegacyAgentProfileShortcuts(overrides, "host", profiles)).toBe(overrides);
    expect(migrateLegacyAgentProfileShortcuts({}, "host", [])).toEqual({});
  });
});
