import { describe, expect, it } from "vitest";
import {
  computeNotificationPlan,
  isPushEligibleAttentionReason,
  type ClientPresenceState,
  PRESENCE_THRESHOLD_MS,
} from "./agent-attention-policy.js";

function state(overrides: Partial<ClientPresenceState>): ClientPresenceState {
  return {
    appVisible: true,
    focusedAgentId: null,
    focusedTerminalId: null,
    lastActivityAtMs: null,
    notificationProjectIds: null,
    ...overrides,
  };
}

describe("computeNotificationPlan", () => {
  const nowMs = Date.parse("2026-04-19T12:00:00.000Z");
  const staleAtMs = nowMs - PRESENCE_THRESHOLD_MS - 1;
  const presentAtMs = nowMs - PRESENCE_THRESHOLD_MS + 1;

  it("elects the in-scope client over a more recent out-of-scope client", () => {
    expect(
      computeNotificationPlan({
        allStates: [
          state({ lastActivityAtMs: nowMs - 1000, notificationProjectIds: new Set(["alpha"]) }),
          state({ lastActivityAtMs: nowMs, notificationProjectIds: new Set(["beta"]) }),
        ],
        targetProjectId: "alpha",
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, shouldPush: false });
  });

  it.each([
    {
      name: "keeps overlap on the most recent matching client",
      states: [
        state({ lastActivityAtMs: nowMs - 1, notificationProjectIds: new Set(["alpha"]) }),
        state({ lastActivityAtMs: nowMs }),
      ],
      targetProjectId: "alpha",
      expected: { inAppRecipientIndex: 1, shouldPush: false },
    },
    {
      name: "keeps lower-index ties among overlapping scopes",
      states: [
        state({ lastActivityAtMs: nowMs, notificationProjectIds: new Set(["alpha"]) }),
        state({ lastActivityAtMs: nowMs, notificationProjectIds: new Set(["alpha", "beta"]) }),
      ],
      targetProjectId: "alpha",
      expected: { inAppRecipientIndex: 0, shouldPush: false },
    },
    {
      name: "does not push when present clients are all out of scope",
      states: [state({ lastActivityAtMs: nowMs, notificationProjectIds: new Set() })],
      targetProjectId: "alpha",
      expected: { inAppRecipientIndex: null, shouldPush: false },
    },
    {
      name: "a focused out-of-scope client suppresses everything",
      states: [
        state({ lastActivityAtMs: nowMs - 1 }),
        state({
          lastActivityAtMs: nowMs,
          focusedAgentId: "agent-1",
          notificationProjectIds: new Set(["beta"]),
        }),
      ],
      targetProjectId: "alpha",
      expected: { inAppRecipientIndex: null, shouldPush: false },
    },
    {
      name: "no present client pushes despite restrictive scopes",
      states: [state({ lastActivityAtMs: staleAtMs, notificationProjectIds: new Set() })],
      targetProjectId: "alpha",
      expected: { inAppRecipientIndex: null, shouldPush: true },
    },
    {
      name: "an unknown target admits only unrestricted clients",
      states: [
        state({ lastActivityAtMs: nowMs - 1 }),
        state({ lastActivityAtMs: nowMs, notificationProjectIds: new Set(["alpha"]) }),
      ],
      targetProjectId: null,
      expected: { inAppRecipientIndex: 0, shouldPush: false },
    },
    {
      name: "an unknown target with only restrictive clients drops without push",
      states: [state({ lastActivityAtMs: nowMs, notificationProjectIds: new Set(["alpha"]) })],
      targetProjectId: null,
      expected: { inAppRecipientIndex: null, shouldPush: false },
    },
  ])("$name", ({ states, targetProjectId, expected }) => {
    expect(
      computeNotificationPlan({
        allStates: states,
        targetProjectId,
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual(expected);
  });

  it("does not suppress notifications when a focused client is stale", () => {
    const staleFocused = state({
      focusedAgentId: "agent-1",
      lastActivityAtMs: staleAtMs,
    });

    expect(
      computeNotificationPlan({
        targetProjectId: "alpha",
        allStates: [staleFocused],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: true });
  });

  it("suppresses notifications when a focused client is present", () => {
    const staleFocused = state({
      focusedAgentId: "agent-1",
      lastActivityAtMs: staleAtMs,
    });
    const presentFocused = state({
      focusedAgentId: "agent-1",
      lastActivityAtMs: presentAtMs,
    });

    expect(
      computeNotificationPlan({
        targetProjectId: "alpha",
        allStates: [staleFocused, presentFocused],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: false });
  });

  it("does not suppress notifications when a focused client is backgrounded", () => {
    const backgroundFocused = state({
      appVisible: false,
      focusedAgentId: "agent-1",
      lastActivityAtMs: presentAtMs,
    });

    expect(
      computeNotificationPlan({
        targetProjectId: "alpha",
        allStates: [backgroundFocused],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, shouldPush: false });
  });

  it("treats present clients focused on different agents as eligible", () => {
    expect(
      computeNotificationPlan({
        targetProjectId: "alpha",
        allStates: [
          state({
            focusedAgentId: "agent-2",
            lastActivityAtMs: nowMs - 1_000,
          }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, shouldPush: false });
  });

  it("chooses the present client with the greatest clamped activity timestamp", () => {
    expect(
      computeNotificationPlan({
        targetProjectId: "alpha",
        allStates: [
          state({ lastActivityAtMs: nowMs - 10_000 }),
          state({ lastActivityAtMs: nowMs - 1_000 }),
          state({ lastActivityAtMs: staleAtMs }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 1, shouldPush: false });
  });

  it("uses the lower index when present clients have identical timestamps", () => {
    expect(
      computeNotificationPlan({
        targetProjectId: "alpha",
        allStates: [
          state({ lastActivityAtMs: nowMs - 1_000 }),
          state({ lastActivityAtMs: nowMs - 1_000 }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, shouldPush: false });
  });

  it("clamps future timestamps to now and treats them as present", () => {
    expect(
      computeNotificationPlan({
        targetProjectId: "alpha",
        allStates: [
          state({ lastActivityAtMs: nowMs - 1 }),
          state({ lastActivityAtMs: nowMs + 600_000 }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 1, shouldPush: false });
  });

  it("never treats no-heartbeat clients as present", () => {
    expect(
      computeNotificationPlan({
        targetProjectId: "alpha",
        allStates: [state({ lastActivityAtMs: null })],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: true });
  });

  it("falls back to push for non-error attention when no clients are present", () => {
    expect(
      computeNotificationPlan({
        targetProjectId: "alpha",
        allStates: [state({ lastActivityAtMs: staleAtMs })],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: true });
  });

  it("does not push error attention when no clients are present", () => {
    expect(
      computeNotificationPlan({
        targetProjectId: "alpha",
        allStates: [state({ lastActivityAtMs: staleAtMs })],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: false,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: false });
  });

  it("lets a foreground mobile-style client with recent activity win as most recent", () => {
    expect(
      computeNotificationPlan({
        targetProjectId: "alpha",
        allStates: [
          state({ focusedAgentId: "agent-2", lastActivityAtMs: nowMs - 20_000 }),
          state({ focusedAgentId: null, lastActivityAtMs: nowMs - 500 }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 1, shouldPush: false });
  });

  it("selects no in-app recipient and pushes when two web-style clients are stale", () => {
    expect(
      computeNotificationPlan({
        targetProjectId: "alpha",
        allStates: [state({ lastActivityAtMs: staleAtMs }), state({ lastActivityAtMs: staleAtMs })],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: true });
  });

  it("never suppresses when focusTarget is null even if a client focuses a matching id", () => {
    expect(
      computeNotificationPlan({
        targetProjectId: "alpha",
        allStates: [state({ focusedAgentId: "terminal-1", lastActivityAtMs: nowMs - 500 })],
        focusTarget: null,
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, shouldPush: false });
  });

  it("suppresses terminal notifications when a present visible client focuses the terminal", () => {
    expect(
      computeNotificationPlan({
        targetProjectId: "alpha",
        allStates: [state({ focusedTerminalId: "terminal-1", lastActivityAtMs: nowMs - 500 })],
        focusTarget: { kind: "terminal", id: "terminal-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: false });
  });

  it("pushes for a null-focus target when no client is present and push is eligible", () => {
    expect(
      computeNotificationPlan({
        targetProjectId: "alpha",
        allStates: [state({ lastActivityAtMs: staleAtMs })],
        focusTarget: null,
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: true });
  });
});

describe("isPushEligibleAttentionReason", () => {
  it("allows push for finished and permission but not error", () => {
    expect(isPushEligibleAttentionReason("finished")).toBe(true);
    expect(isPushEligibleAttentionReason("permission")).toBe(true);
    expect(isPushEligibleAttentionReason("error")).toBe(false);
  });
});
