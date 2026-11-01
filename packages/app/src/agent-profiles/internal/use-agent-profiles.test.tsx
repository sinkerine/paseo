/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useAgentProfilesForHosts } from "./use-agent-profiles";

interface SessionState {
  sessions: Record<
    string,
    { serverInfo: { features: { agentProfiles: boolean; agentConfigApply: boolean } } }
  >;
}
const boundary = vi.hoisted(() => ({
  getDaemonConfig: vi.fn(),
}));
const useSessions = create<SessionState>(() => ({ sessions: {} }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: SessionState) => unknown) => useSessions(selector),
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: () => ({ getDaemonConfig: boundary.getDaemonConfig }) }),
  useHostRuntimeConnectionStatuses: (ids: readonly string[]) =>
    new Map(ids.map((id) => [id, "online"])),
  useHostRuntimeClient: () => ({ getDaemonConfig: boundary.getDaemonConfig }),
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function config(name: string): MutableDaemonConfig {
  return {
    mcp: { injectIntoAgents: true },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
    agentProfiles: [{ id: name, name, provider: "claude" }],
  };
}

let queryClient: QueryClient;
function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  boundary.getDaemonConfig.mockReset();
  boundary.getDaemonConfig.mockImplementation(() => new Promise(() => {}));
  useSessions.setState({
    sessions: Object.fromEntries(
      ["a", "b", "unloaded"].map((id) => [
        id,
        { serverInfo: { features: { agentProfiles: true, agentConfigApply: true } } },
      ]),
    ),
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("useAgentProfilesForHosts", () => {
  it("omits unsupported and unloaded hosts, keeps requested order and follows daemon-config pushes", async () => {
    queryClient.setQueryData(daemonConfigQueryKey("a"), config("Claude"));
    queryClient.setQueryData(daemonConfigQueryKey("b"), config("Pi"));
    queryClient.setQueryData(daemonConfigQueryKey("unsupported"), config("Hidden"));
    const { result } = renderHook(
      () => useAgentProfilesForHosts(["b", "unsupported", "unloaded", "a"]),
      { wrapper },
    );
    expect(result.current).toEqual([
      { serverId: "b", profiles: config("Pi").agentProfiles },
      { serverId: "a", profiles: config("Claude").agentProfiles },
    ]);
    await act(async () => {
      queryClient.setQueryData(daemonConfigQueryKey("b"), config("Codex"));
    });
    await waitFor(() =>
      expect(result.current).toEqual([
        { serverId: "b", profiles: config("Codex").agentProfiles },
        { serverId: "a", profiles: config("Claude").agentProfiles },
      ]),
    );
    await act(async () => {
      queryClient.setQueryData(daemonConfigQueryKey("unloaded"), {});
    });
    await waitFor(() =>
      expect(result.current).toEqual([
        { serverId: "b", profiles: config("Codex").agentProfiles },
        { serverId: "unloaded", profiles: [] },
        { serverId: "a", profiles: config("Claude").agentProfiles },
      ]),
    );
    expect(result.current[1]?.profiles).toEqual([]);
  });

  it("shares one fetch and cache with useDaemonConfig and reacts to support changes", async () => {
    boundary.getDaemonConfig.mockResolvedValue({ config: config("Fetched") });
    const { result } = renderHook(
      () => ({ single: useDaemonConfig("a"), hosts: useAgentProfilesForHosts(["a"]) }),
      { wrapper },
    );
    await waitFor(() =>
      expect(result.current.hosts).toEqual([
        { serverId: "a", profiles: config("Fetched").agentProfiles },
      ]),
    );
    expect(result.current.single.config).toEqual(config("Fetched"));
    expect(boundary.getDaemonConfig).toHaveBeenCalledTimes(1);
    act(() => useSessions.setState({ sessions: {} }));
    expect(result.current.hosts).toEqual([]);
  });
});
