import { randomUUID } from "node:crypto";
import { app, BrowserWindow, ipcMain } from "electron";
import { AppConfigResponseSchema, type AppConfigResponse } from "@getpaseo/protocol/app-config";
import { startAppConfigServer } from "./app-config-server.js";

export async function registerAppConfigServer(): Promise<void> {
  interface PendingRequest {
    windowId: number;
    resolve(response: AppConfigResponse): void;
    timer: ReturnType<typeof setTimeout>;
  }
  const pending = new Map<string, PendingRequest>();
  let queue: Promise<unknown> = Promise.resolve();
  ipcMain.handle("paseo:app-config:reply", (event, id: unknown, raw: unknown) => {
    if (typeof id !== "string") throw new Error("Invalid app configuration reply.");
    const entry = pending.get(id);
    if (!entry || entry.windowId !== event.sender.id)
      throw new Error("Unexpected app configuration reply.");
    const response = AppConfigResponseSchema.parse(raw);
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(response);
    if (response.ok && response.data.action === "saved") {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("paseo:app-config:changed");
      }
    }
  });
  const stop = await startAppConfigServer({
    userDataPath: app.getPath("userData"),
    execute: (request) => {
      const run = queue.then(
        () =>
          new Promise<AppConfigResponse>((resolve) => {
            const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
            if (!window || window.webContents.isDestroyed()) {
              resolve({
                ok: false,
                error: "Open a Paseo Desktop window before configuring app preferences.",
              });
              return;
            }
            const id = randomUUID();
            const timer = setTimeout(() => {
              pending.delete(id);
              resolve({
                ok: false,
                error:
                  "Desktop app did not respond. Open an updated Paseo Desktop window and retry.",
              });
            }, 10000);
            pending.set(id, { windowId: window.webContents.id, resolve, timer });
            window.webContents.send("paseo:app-config:request", id, request);
          }),
      );
      queue = run.catch(() => undefined);
      return run;
    },
  });
  app.once("will-quit", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: "Desktop app is quitting." });
    }
    pending.clear();
    void stop();
  });
}
