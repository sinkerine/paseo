import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

export interface RecordedNotification {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

declare global {
  interface Window {
    __paseoNotifications: RecordedNotification[];
  }
}

// Observe only the OS boundary; the renderer and daemon still own all eligibility decisions.
export async function installNotificationRecorder(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    window.__paseoNotifications = [];
    class NotificationRecorder {
      static permission = "granted";
      static async requestPermission() {
        return "granted";
      }
      constructor(title: string, options?: NotificationOptions) {
        window.__paseoNotifications.push({ title, body: options?.body, data: options?.data });
      }
      addEventListener() {}
    }
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: NotificationRecorder,
    });
  });
}

export async function readNotifications(page: Page): Promise<RecordedNotification[]> {
  return page.evaluate(() => window.__paseoNotifications);
}

export async function captureNotifications(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const path = testInfo.outputPath(`${name}-notifications.json`);
  await writeFile(path, JSON.stringify(await readNotifications(page), null, 2));
  await testInfo.attach(`${name}-notifications`, { path, contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath(`${name}-sidebar.png`) });
}
