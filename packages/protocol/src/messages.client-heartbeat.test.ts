import { describe, expect, it } from "vitest";
import { ClientHeartbeatMessageSchema } from "./messages.js";

const heartbeat = {
  type: "client_heartbeat",
  deviceType: "web",
  focusedAgentId: null,
  focusedTerminalId: null,
  lastActivityAt: "2026-11-14T12:00:00.000Z",
  appVisible: true,
};

describe("client heartbeat notification scope", () => {
  it("preserves a project allowlist, including an empty allowlist", () => {
    for (const projectIds of [[], ["alpha", "beta"]]) {
      expect(
        ClientHeartbeatMessageSchema.parse({ ...heartbeat, notificationScope: { projectIds } }),
      ).toEqual({ ...heartbeat, notificationScope: { projectIds } });
    }
  });

  it("accepts an old heartbeat with no scope", () => {
    expect(ClientHeartbeatMessageSchema.parse(heartbeat)).toEqual(heartbeat);
  });

  it("rejects a scope whose project ids are not an array", () => {
    expect(
      ClientHeartbeatMessageSchema.safeParse({
        ...heartbeat,
        notificationScope: { projectIds: "alpha" },
      }).success,
    ).toBe(false);
  });
});
