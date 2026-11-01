import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import { buildProfileShortcutRows } from "./profile-shortcut-rows";

const i18n = createInstance();
await i18n.init({
  lng: "en",
  resources: {
    en: {
      translation: {
        settings: {
          shortcuts: {
            profiles: {
              select: "Select profile: {{name}}",
              start: "Start agent: {{name}}",
            },
          },
        },
      },
    },
  },
});

function profile(id: string, name: string) {
  return { id, name, provider: "claude" as const };
}

describe("buildProfileShortcutRows", () => {
  it("merges normalized names with first display names, row order and each host once", () => {
    const rows = buildProfileShortcutRows({
      hosts: [
        {
          serverId: "b",
          profiles: [
            profile("1", "Pi Opus"),
            profile("2", "Claude"),
            profile("3", " pi  OPUS "),
            profile("4", " \t "),
          ],
        },
        { serverId: "a", profiles: [profile("5", "PI opus"), profile("6", "Codex")] },
        { serverId: "b", profiles: [profile("7", "pi opus")] },
      ],
      hostLabel: (id) => (id === "b" ? "sachi" : "kazuki"),
      t: i18n.t,
    });
    expect(rows).toEqual([
      {
        id: '["agent-profile.select","pi opus"]',
        label: "Select profile: Pi Opus",
        labelKey: "Select profile: Pi Opus",
        chord: null,
        note: "sachi, kazuki",
      },
      {
        id: '["agent-profile.start","pi opus"]',
        label: "Start agent: Pi Opus",
        labelKey: "Start agent: Pi Opus",
        chord: null,
        note: "sachi, kazuki",
      },
      {
        id: '["agent-profile.select","claude"]',
        label: "Select profile: Claude",
        labelKey: "Select profile: Claude",
        chord: null,
        note: "sachi",
      },
      {
        id: '["agent-profile.start","claude"]',
        label: "Start agent: Claude",
        labelKey: "Start agent: Claude",
        chord: null,
        note: "sachi",
      },
      {
        id: '["agent-profile.select","codex"]',
        label: "Select profile: Codex",
        labelKey: "Select profile: Codex",
        chord: null,
        note: "kazuki",
      },
      {
        id: '["agent-profile.start","codex"]',
        label: "Start agent: Codex",
        labelKey: "Start agent: Codex",
        chord: null,
        note: "kazuki",
      },
    ]);
  });

  it("omits blank names and returns no rows without loaded profiles", () => {
    expect(buildProfileShortcutRows({ hosts: [], hostLabel: (id) => id, t: i18n.t })).toEqual([]);
    expect(
      buildProfileShortcutRows({
        hosts: [{ serverId: "a", profiles: [profile("1", "  ")] }],
        hostLabel: (id) => id,
        t: i18n.t,
      }),
    ).toEqual([]);
  });
});
