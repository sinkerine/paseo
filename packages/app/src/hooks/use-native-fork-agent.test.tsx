// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import {
  useNativeForkAgent,
  useNativeForkPending,
  useNativeSessionForkAvailable,
} from "./use-native-fork-agent";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  accept: vi.fn(),
  show: vi.fn(() => vi.fn()),
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: mocks.navigate,
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ acceptAgentSnapshot: mocks.accept }),
}));
vi.mock("@/contexts/toast-api-context", () => ({ useToast: () => ({ show: mocks.show }) }));

const capabilities = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsNativeSessionFork: true,
};
const snapshot: AgentSnapshotPayload = {
  id: "fork",
  provider: "pi",
  cwd: "/work",
  workspaceId: "workspace",
  model: "selected",
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T00:00:00.000Z",
  lastUserMessageAt: null,
  status: "idle",
  capabilities,
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  title: "Source (fork)",
  labels: {},
};
const request = { agentId: "source", workspaceId: "workspace", target: "latest" as const };
let client: DaemonClient;
beforeEach(() => {
  mocks.navigate.mockClear();
  mocks.show.mockClear();
  mocks.accept.mockClear();
  client = new DaemonClient({
    url: "ws://unit.invalid",
    clientId: "native-fork-unit",
    reconnect: { enabled: false },
  });
  useSessionStore.getState().initializeSession("server", client);
});
afterEach(async () => {
  cleanup();
  useSessionStore.getState().clearSession("server");
  await client.close();
  vi.restoreAllMocks();
});

test("old hosts and read-only panes hide native actions while capable interactive hosts enable them", () => {
  const hook = renderHook(
    ({ readOnly, supportsNativeSessionFork }) =>
      useNativeSessionForkAvailable(
        "server",
        { ...capabilities, supportsNativeSessionFork },
        readOnly,
      ),
    { initialProps: { readOnly: false, supportsNativeSessionFork: true } },
  );
  expect(hook.result.current).toBe(false);
  act(() =>
    useSessionStore.getState().updateSessionServerInfo("server", {
      serverId: "server",
      hostname: null,
      version: null,
      features: { agentNativeSessionFork: true },
    }),
  );
  expect(hook.result.current).toBe(true);
  hook.rerender({ readOnly: true, supportsNativeSessionFork: true });
  expect(hook.result.current).toBe(false);
  hook.rerender({ readOnly: false, supportsNativeSessionFork: false });
  expect(hook.result.current).toBe(false);
});

test("footer and tab callers share pending state and block duplicate native fork submissions", async () => {
  let finish: (value: AgentSnapshotPayload) => void = () => {};
  const response = new Promise<AgentSnapshotPayload>((resolve) => {
    finish = resolve;
  });
  const rpc = vi.spyOn(client, "forkAgentSession").mockReturnValue(response);
  const footer = renderHook(() => ({
    fork: useNativeForkAgent({ serverId: "server" }),
    pending: useNativeForkPending("server", "source"),
  }));
  const tab = renderHook(() => ({
    fork: useNativeForkAgent({ serverId: "server" }),
    pending: useNativeForkPending("server", "source"),
  }));
  let operation: Promise<void> = Promise.resolve();
  act(() => {
    operation = footer.result.current.fork(request);
  });
  expect(footer.result.current.pending).toBe(true);
  expect(tab.result.current.pending).toBe(true);
  await act(async () => tab.result.current.fork(request));
  expect(rpc).toHaveBeenCalledOnce();
  await act(async () => {
    finish(snapshot);
    await operation;
  });
  expect(footer.result.current.pending).toBe(false);
  expect(tab.result.current.pending).toBe(false);
  expect(mocks.accept).toHaveBeenCalledWith(
    "server",
    expect.objectContaining({ id: "fork", workspaceId: "workspace" }),
  );
  expect(mocks.accept.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.navigate.mock.invocationCallOrder[0]!,
  );
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
    serverId: "server",
    workspaceId: "workspace",
    target: { kind: "agent", agentId: "fork" },
  });
});

test("failure leaves dismissible persistent feedback, releases pending state, and permits a retry", async () => {
  const rpc = vi
    .spyOn(client, "forkAgentSession")
    .mockRejectedValueOnce(new Error("Restore the source session file and retry."))
    .mockResolvedValueOnce(snapshot);
  const hook = renderHook(() => ({
    fork: useNativeForkAgent({ serverId: "server" }),
    pending: useNativeForkPending("server", "source"),
  }));
  await act(async () => hook.result.current.fork(request));
  expect(hook.result.current.pending).toBe(false);
  expect(mocks.show).toHaveBeenCalledWith(
    expect.objectContaining({
      props: expect.objectContaining({
        description: "Restore the source session file and retry.",
        testID: "native-session-fork-error",
      }),
    }),
    { durationMs: null, testID: "native-session-fork-error-toast" },
  );
  expect(mocks.navigate).not.toHaveBeenCalled();
  await act(async () => hook.result.current.fork(request));
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(mocks.navigate).toHaveBeenCalledOnce();
});
