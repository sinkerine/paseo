/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import type { KeyboardActionHandler } from "@/keyboard/keyboard-action-dispatcher";
import { createKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";
import { useAgentProfileStartShortcut } from "./use-start-shortcut";

// Keep the dispatcher real; replace host RPC and toast boundaries to exercise pending and failure deterministically.
const boundary = vi.hoisted(() => ({
  createAgent: vi.fn(),
  createAgentA: vi.fn(),
  profiles: null as AgentProfile[] | null,
  profilesA: [{ id: "profile-a", name: "Saved", provider: "claude" }] as AgentProfile[],
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
  useHostRuntimeClient: (serverId: string) => ({
    createAgent: serverId === "host-b" ? boundary.createAgent : boundary.createAgentA,
  }),
  useHosts: () => [{ serverId: "host-b", label: "sachi" }],
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ show: boundary.show }) }));
vi.mock("./internal/use-agent-profiles", () => ({
  useAgentProfiles: (serverId: string) => ({
    isSupported: true,
    profiles: serverId === "host-b" ? boundary.profiles : boundary.profilesA,
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values: { name: string; host?: string }) =>
      key.endsWith("missing")
        ? `No agent profile named ${values.name} on ${values.host}`
        : `Starting agent: ${values.name}`,
  }),
}));
const queryClient = new QueryClient();
function TestProbe({ enabled = true }: { enabled?: boolean }) {
  return (
    <QueryClientProvider client={queryClient}>
      <Probe enabled={enabled} />
    </QueryClientProvider>
  );
}

function Probe({ enabled = true }: { enabled?: boolean }) {
  useAgentProfileStartShortcut({
    serverId: "host-b",
    workspaceId: "workspace",
    cwd: "/repo",
    enabled,
    onCreated: boundary.onCreated,
  });
  return null;
}
function start(profileKey = "saved") {
  return dispatcher.dispatch({ id: "agent-profile.start", scope: "workspace", profileKey });
}

describe("immediate profile agent creation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    boundary.show.mockReturnValue(boundary.dismiss);
    queryClient.clear();
    boundary.profiles = [
      {
        id: "profile-b",
        name: "Saved",
        provider: "pi",
        model: "model",
        modeId: "plan",
        thinkingOptionId: "high",
        featureValues: { feature: true },
      },
    ];
    queryClient.setQueryData(daemonConfigQueryKey("host-a"), {
      agentProfiles: [
        { id: "profile-a", name: "Saved", provider: "claude" },
        { id: "pi-a", name: "Pi Opus", provider: "pi" },
      ],
    });
  });
  afterEach(cleanup);

  it("creates an empty agent with the saved settings and opens it once", async () => {
    const request = Promise.withResolvers<{ id: string }>();
    boundary.createAgent.mockReturnValue(request.promise);
    render(<TestProbe />);
    expect(start()).toBe(true);
    expect(start()).toBe(true);
    expect(boundary.createAgent).toHaveBeenCalledTimes(1);
    expect(boundary.createAgentA).not.toHaveBeenCalled();
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
    render(<TestProbe />);
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

  it("consumes missing names with a warning using the cached display name, without an RPC", () => {
    render(<TestProbe />);
    expect(start("pi opus")).toBe(true);
    expect(boundary.show).toHaveBeenCalledExactlyOnceWith(
      "No agent profile named Pi Opus on sachi",
      { variant: "warning" },
    );
    expect(boundary.createAgent).not.toHaveBeenCalled();
    expect(boundary.createAgentA).not.toHaveBeenCalled();
  });

  it("uses the key when no cached profile has the missing name", () => {
    render(<TestProbe />);
    expect(start("unknown")).toBe(true);
    expect(boundary.show).toHaveBeenCalledExactlyOnceWith(
      "No agent profile named unknown on sachi",
      { variant: "warning" },
    );
  });

  it("ignores loading profiles and hidden workspaces without a toast", () => {
    boundary.profiles = null;
    const view = render(<TestProbe />);
    expect(start()).toBe(false);
    boundary.profiles = [{ id: "profile-b", name: "Saved", provider: "pi" }];
    view.rerender(<TestProbe enabled={false} />);
    expect(start()).toBe(false);
    expect(boundary.createAgent).not.toHaveBeenCalled();
    expect(boundary.show).not.toHaveBeenCalled();
  });
});
