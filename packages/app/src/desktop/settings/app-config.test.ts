import { describe, expect, it } from "vitest";
import { createAppConfigHandler } from "./app-config";
import { DEFAULT_CLIENT_SETTINGS } from "@/hooks/use-settings/storage";
import type { ShortcutOverrides } from "@/keyboard/keyboard-shortcuts";

function setup() {
  let settings = structuredClone(DEFAULT_CLIENT_SETTINGS);
  const shortcuts: ShortcutOverrides = {};
  const handler = createAppConfigHandler({
    readSettings: async () => structuredClone(settings),
    writeSettings: async (next) => {
      settings = next;
    },
    readShortcuts: async () => ({ ...shortcuts }),
    writeShortcut: async (id, value) => {
      if (value === undefined) delete shortcuts[id];
      else shortcuts[id] = value;
    },
  });
  return { handler, settings: () => settings, shortcuts };
}

describe("desktop app configuration", () => {
  it("reads, changes, and resets preferences while preserving other settings", async () => {
    const { handler, settings } = setup();
    expect(await handler({ operation: "get", path: "settings.vimKeybindings" })).toEqual({
      source: "desktop",
      path: "settings.vimKeybindings",
      set: true,
      value: false,
    });
    await handler({ operation: "set", path: "settings.vimKeybindings", value: true });
    await handler({ operation: "set", path: "settings.openInSidePane.chatFiles", value: true });
    expect(settings()).toEqual({
      ...DEFAULT_CLIENT_SETTINGS,
      vimKeybindings: true,
      openInSidePane: { ...DEFAULT_CLIENT_SETTINGS.openInSidePane, chatFiles: true },
    });
    await handler({ operation: "unset", path: "settings.openInSidePane.chatFiles" });
    expect(settings().openInSidePane.chatFiles).toBe(false);
    expect(settings().vimKeybindings).toBe(true);
    await handler({
      operation: "set",
      path: "settings.filePanelAssociations.ext:md",
      value: "builtin:markdown",
    });
    await handler({ operation: "unset", path: "settings.filePanelAssociations.ext:md" });
    expect(settings().filePanelAssociations).toEqual({});
  });

  it("rejects invalid preferences without changing settings", async () => {
    const { handler, settings } = setup();
    for (const [path, value] of [
      ["settings.vimKeybindings", "true"],
      ["settings.theme", "unknown"],
      ["settings.codeFontSize", 1000],
      ["settings.noSuchPreference", true],
      ["settings.openInSidePane", { unknown: true }],
      ["settings.__proto__.polluted", true],
      ["settings.filePanelAssociations.ext:md", 123],
    ] as const) {
      await expect(handler({ operation: "set", path, value })).rejects.toThrow();
      expect(settings()).toEqual(DEFAULT_CLIENT_SETTINGS);
    }
  });

  it("lists and reads shortcut bindings, rebinds, unassigns, and restores defaults", async () => {
    const { handler, shortcuts } = setup();
    const id = "workspace-new-cmd-n-mac";
    await handler({ operation: "set", path: `shortcuts.${id}`, value: "Mod+Shift+N" });
    expect(shortcuts).toEqual({ [id]: "Mod+Shift+N" });
    const listed = await handler({ operation: "shortcuts" });
    expect(listed.shortcuts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id, effective: "Mod+Shift+N", override: "Mod+Shift+N" }),
      ]),
    );
    expect(await handler({ operation: "get", path: `shortcuts.${id}` })).toEqual({
      source: "desktop",
      path: `shortcuts.${id}`,
      set: true,
      value: "Mod+Shift+N",
    });
    await handler({ operation: "set", path: `shortcuts.${id}`, value: null });
    expect(shortcuts[id]).toBeNull();
    await handler({ operation: "unset", path: `shortcuts.${id}` });
    expect(shortcuts).toEqual({});
    for (const value of ["", "Ctrl+", 123]) {
      await expect(handler({ operation: "set", path: `shortcuts.${id}`, value })).rejects.toThrow();
    }
    await expect(
      handler({ operation: "set", path: "shortcuts.unknown", value: "Mod+K" }),
    ).rejects.toThrow(/Unknown shortcut/);
    expect(shortcuts).toEqual({});
  });

  it("reports persistence failures and continues processing later requests", async () => {
    const handler = createAppConfigHandler({
      readSettings: async () => DEFAULT_CLIENT_SETTINGS,
      writeSettings: async () => {
        throw new Error("Disk full");
      },
      readShortcuts: async () => ({}),
      writeShortcut: async () => {
        throw new Error("Disk full");
      },
    });
    await expect(
      handler({ operation: "set", path: "settings.vimKeybindings", value: true }),
    ).rejects.toThrow("Disk full");
    await expect(
      handler({ operation: "set", path: "shortcuts.workspace-new-cmd-n-mac", value: "Mod+N" }),
    ).rejects.toThrow("Disk full");
    expect(await handler({ operation: "get", path: "settings.vimKeybindings" })).toEqual({
      source: "desktop",
      path: "settings.vimKeybindings",
      set: true,
      value: false,
    });
  });
});
