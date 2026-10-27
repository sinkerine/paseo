import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppConfigRequestSchema } from "@getpaseo/protocol/app-config";
import { getDesktopHost } from "@/desktop/host";
import { loadAppSettingsFromStorage, saveAppSettings } from "@/hooks/use-settings";
import { APP_SETTINGS_QUERY_KEY } from "@/hooks/use-settings/storage";
import {
  getShortcutOverrideStore,
  readShortcutOverrides,
  QUERY_KEY,
} from "@/hooks/use-keyboard-shortcut-overrides";
import { createAppConfigHandler } from "./app-config";

export function AppConfigListener() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const bridge = getDesktopHost()?.appConfig;
    if (!bridge) return;
    const handler = createAppConfigHandler({
      readSettings: loadAppSettingsFromStorage,
      writeSettings: async (settings) => {
        const previous = await loadAppSettingsFromStorage();
        try {
          await saveAppSettings({ queryClient, updates: settings });
        } catch (error) {
          queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, previous);
          throw error;
        }
      },
      readShortcuts: async () => {
        const overrides = await readShortcutOverrides();
        queryClient.setQueryData(QUERY_KEY, overrides);
        return overrides;
      },
      writeShortcut: async (id, value) => {
        queryClient.setQueryData(QUERY_KEY, await readShortcutOverrides());
        const store = getShortcutOverrideStore(queryClient);
        if (value === undefined) await store.remove(id);
        else if (value === null) await store.clear(id);
        else await store.set(id, value);
        const saved = await readShortcutOverrides();
        if (saved[id] !== value) throw new Error("Failed to save keyboard shortcut.");
      },
    });
    const unsubscribe = bridge.onRequest(async (id, raw) => {
      try {
        const data = await handler(AppConfigRequestSchema.parse(raw));
        await bridge.reply(id, { ok: true, data });
      } catch (error) {
        await bridge.reply(id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    const unsubscribeChanged = bridge.onChanged(() => {
      void queryClient.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY });
      void readShortcutOverrides()
        .then((overrides) => queryClient.setQueryData(QUERY_KEY, overrides))
        .catch((error) => console.error("[AppConfig] Failed to refresh shortcuts", error));
    });
    return () => {
      unsubscribe();
      unsubscribeChanged();
    };
  }, [queryClient]);
  return null;
}
