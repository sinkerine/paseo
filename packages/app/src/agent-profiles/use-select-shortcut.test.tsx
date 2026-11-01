/** @vitest-environment jsdom */
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { KeyboardActionHandler } from "@/keyboard/keyboard-action-dispatcher";
import { createKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import type { AgentProfilePickerRow } from "./internal/use-agent-profile-picker";
import { useAgentProfileSelectShortcut } from "./use-select-shortcut";

const boundary = vi.hoisted(() => ({
  profiles: null as AgentProfile[] | null,
  profilesA: [{ id: "profile-a", name: "Saved", provider: "claude" }] as AgentProfile[],
  rows: [] as AgentProfilePickerRow[],
  apply: vi.fn(),
  show: vi.fn(),
}));
const dispatcher = createKeyboardActionDispatcher();
vi.mock("@/hooks/use-keyboard-action-handler", () => ({
  useKeyboardActionHandler: (handler: KeyboardActionHandler) => {
    React.useEffect(() => dispatcher.registerHandler(handler), [handler]);
  },
}));
vi.mock("./internal/use-agent-profiles", () => ({
  useAgentProfiles: (serverId: string) => ({
    isSupported: true,
    profiles: serverId === "host-b" ? boundary.profiles : boundary.profilesA,
  }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "host-b", label: "sachi" }],
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ show: boundary.show }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, values: { name: string; host: string }) =>
      `No agent profile named ${values.name} on ${values.host}`,
  }),
}));
const queryClient = new QueryClient();
function Probe({ enabled = true }: { enabled?: boolean }) {
  useAgentProfileSelectShortcut({
    serverId: "host-b",
    agentProfiles: { rows: boundary.rows, applyProfile: boundary.apply },
    onApplyAgentProfile: boundary.apply,
    enabled,
  });
  return null;
}
function TestProbe({ enabled = true }: { enabled?: boolean }) {
  return (
    <QueryClientProvider client={queryClient}>
      <Probe enabled={enabled} />
    </QueryClientProvider>
  );
}
function row(profile: AgentProfile): AgentProfilePickerRow {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    modelId: "",
    icon: "",
    color: "",
    summary: "",
  };
}
function select(profileKey = "saved") {
  return dispatcher.dispatch({ id: "agent-profile.select", scope: "message-input", profileKey });
}

describe("profile select shortcut", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    queryClient.clear();
    const profile: AgentProfile = { id: "profile-b", name: "Saved", provider: "pi" };
    boundary.profiles = [profile];
    boundary.rows = [row(profile)];
    queryClient.setQueryData(daemonConfigQueryKey("host-a"), {
      agentProfiles: [...boundary.profilesA, { id: "pi-a", name: "Pi Opus", provider: "pi" }],
    });
  });
  afterEach(cleanup);

  it("applies the active host's profile ID rather than the other host's same-name profile", () => {
    render(<TestProbe />);
    expect(select()).toBe(true);
    expect(boundary.apply).toHaveBeenCalledExactlyOnceWith("profile-b");
    expect(boundary.show).not.toHaveBeenCalled();
  });

  it("leaves an incompatible existing profile unapplied without a missing-profile toast", () => {
    boundary.rows = [];
    render(<TestProbe />);
    expect(select()).toBe(false);
    expect(boundary.apply).not.toHaveBeenCalled();
    expect(boundary.show).not.toHaveBeenCalled();
  });

  it("does not skip an incompatible first duplicate to apply a later compatible provider", () => {
    const later: AgentProfile = { id: "later-b", name: " SAVED ", provider: "claude" };
    boundary.profiles = [{ id: "first-b", name: "Saved", provider: "pi" }, later];
    boundary.rows = [row(later)];
    render(<TestProbe />);
    expect(select()).toBe(false);
    expect(boundary.apply).not.toHaveBeenCalled();
    expect(boundary.show).not.toHaveBeenCalled();
  });

  it("applies the first compatible duplicate in full host list order", () => {
    const first: AgentProfile = { id: "first-b", name: " Saved ", provider: "pi" };
    const later: AgentProfile = { id: "later-b", name: "saved", provider: "claude" };
    boundary.profiles = [first, later];
    boundary.rows = [row(later), row(first)];
    render(<TestProbe />);
    expect(select()).toBe(true);
    expect(boundary.apply).toHaveBeenCalledExactlyOnceWith("first-b");
    expect(boundary.show).not.toHaveBeenCalled();
  });

  it("warns only for names missing from the loaded host list, using the cached display name", () => {
    render(<TestProbe />);
    expect(select("pi opus")).toBe(true);
    expect(boundary.apply).not.toHaveBeenCalled();
    expect(boundary.show).toHaveBeenCalledExactlyOnceWith(
      "No agent profile named Pi Opus on sachi",
      { variant: "warning" },
    );
  });

  it("uses the normalized key when no cached display name exists", () => {
    render(<TestProbe />);
    expect(select("unknown")).toBe(true);
    expect(boundary.apply).not.toHaveBeenCalled();
    expect(boundary.show).toHaveBeenCalledExactlyOnceWith(
      "No agent profile named unknown on sachi",
      { variant: "warning" },
    );
  });

  it("ignores loading profiles and inactive composers without applying or warning", () => {
    boundary.profiles = null;
    const view = render(<TestProbe />);
    expect(select()).toBe(false);
    boundary.profiles = [{ id: "profile-b", name: "Saved", provider: "pi" }];
    view.rerender(<TestProbe enabled={false} />);
    expect(select()).toBe(false);
    expect(boundary.apply).not.toHaveBeenCalled();
    expect(boundary.show).not.toHaveBeenCalled();
  });
});
