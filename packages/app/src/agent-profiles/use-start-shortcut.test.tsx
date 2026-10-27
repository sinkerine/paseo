/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyboardActionHandler } from "@/keyboard/keyboard-action-dispatcher";
import { createKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";
import { useAgentProfileStartShortcut } from "./use-start-shortcut";

// Keep the dispatcher real; replace host RPC and toast boundaries to exercise pending and failure deterministically.
const boundary = vi.hoisted(() => ({
  createAgent: vi.fn(),
  show: vi.fn(),
  dismiss: vi.fn(),
  onCreated: vi.fn(),
}));
const dispatcher = createKeyboardActionDispatcher();
vi.mock("@/hooks/use-keyboard-action-handler", () => ({
  useKeyboardActionHandler: (handler: KeyboardActionHandler) => {
    React.useEffect(() => dispatcher.registerHandler(handler), [handler]);
  },
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ createAgent: boundary.createAgent }),
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ show: boundary.show }) }));
vi.mock("./internal/use-agent-profiles", () => ({
  useAgentProfiles: () => ({
    isSupported: true,
    profiles: [
      {
        id: "profile",
        name: "Saved",
        provider: "pi",
        model: "model",
        modeId: "plan",
        thinkingOptionId: "high",
        featureValues: { feature: true },
      },
    ],
  }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: () => "Starting agent: Saved" }) }));

function Probe({ enabled = true }: { enabled?: boolean }) {
  useAgentProfileStartShortcut({
    serverId: "host",
    workspaceId: "workspace",
    cwd: "/repo",
    enabled,
    onCreated: boundary.onCreated,
  });
  return null;
}
function start(serverId = "host", profileId = "profile") {
  return dispatcher.dispatch({
    id: "agent-profile.start",
    scope: "workspace",
    serverId,
    profileId,
  });
}

describe("immediate profile agent creation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    boundary.show.mockReturnValue(boundary.dismiss);
  });
  afterEach(cleanup);

  it("creates an empty agent with the saved settings and opens it once", async () => {
    const request = Promise.withResolvers<{ id: string }>();
    boundary.createAgent.mockReturnValue(request.promise);
    render(<Probe />);
    expect(start()).toBe(true);
    expect(start()).toBe(true);
    expect(boundary.createAgent).toHaveBeenCalledTimes(1);
    expect(boundary.createAgent).toHaveBeenCalledWith({
      workspaceId: "workspace",
      config: {
        provider: "pi",
        cwd: "/repo",
        model: "model",
        modeId: "plan",
        thinkingOptionId: "high",
        featureValues: { feature: true },
      },
    });
    expect(boundary.show).toHaveBeenCalledWith("Starting agent: Saved", { durationMs: null });
    await act(async () => {
      request.resolve({ id: "created-agent" });
      await request.promise;
    });
    expect(boundary.onCreated).toHaveBeenCalledExactlyOnceWith("created-agent");
    expect(boundary.dismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps a creation failure visible and allows retry", async () => {
    boundary.createAgent.mockRejectedValue(new Error("Provider unavailable"));
    render(<Probe />);
    await act(async () => {
      start();
    });
    expect(boundary.show).toHaveBeenLastCalledWith("Provider unavailable", {
      variant: "error",
      durationMs: null,
    });
    expect(boundary.onCreated).not.toHaveBeenCalled();
    boundary.createAgent.mockResolvedValue({ id: "retried-agent" });
    await act(async () => {
      start();
    });
    expect(boundary.onCreated).toHaveBeenCalledExactlyOnceWith("retried-agent");
  });

  it("ignores shortcuts for another host, deleted profiles, and hidden workspaces", () => {
    const view = render(<Probe />);
    expect(start("other-host")).toBe(false);
    expect(start("host", "deleted-profile")).toBe(false);
    view.rerender(<Probe enabled={false} />);
    expect(start()).toBe(false);
    expect(boundary.createAgent).not.toHaveBeenCalled();
  });
});
