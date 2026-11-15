import { createWorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import { SessionDelivery } from "./session/owned-subscriptions/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server as HTTPServer } from "http";
import type pino from "pino";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { ScheduleService } from "./schedule/service.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import type { PushNotificationSender, PushPayload } from "./push/index.js";
import type { WorkspaceRegistry, PersistedWorkspaceRecord } from "./workspace-registry.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";

const WORKSPACE_ID = "workspace-1";

const wsModuleMock = vi.hoisted(() => {
  class MockWebSocketServer {
    readonly handlers = new Map<string, (...args: unknown[]) => void>();

    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    close() {
      // no-op
    }
  }

  return { MockWebSocketServer };
});

vi.mock("ws", () => ({
  WebSocketServer: wsModuleMock.MockWebSocketServer,
}));

vi.mock("./session.js", () => ({
  Session: function Session() {
    return {};
  },
}));

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";

interface WebSocketServerInternals {
  sessions: Map<unknown, unknown>;
  broadcastAgentAttention(params: {
    agentId: string;
    reason: string;
    preview?: string;
    provider: "claude";
    timestamp?: string;
  }): Promise<void>;
}

function createLogger() {
  const logger = {
    child: vi.fn(() => logger),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function createWorkspaceAutoNameStub(): WorkspaceAutoName {
  return createStub<WorkspaceAutoName>({
    scheduleForWorktree: () => {},
    scheduleForDirectory: () => {},
  });
}

class RecordingPushNotificationSender implements PushNotificationSender {
  readonly sent: PushPayload[] = [];

  async send(payload: PushPayload): Promise<void> {
    this.sent.push(payload);
  }
}

function createServer(
  agentManagerOverrides?: Record<string, unknown>,
  workspaceRegistry?: WorkspaceRegistry,
) {
  const logger = createLogger();
  const pushNotifications = new RecordingPushNotificationSender();
  const agentManager = {
    subscribe: vi.fn(() => () => {}),
    setAgentAttentionCallback: vi.fn(),
    getAgent: vi.fn(() => ({ workspaceId: WORKSPACE_ID, pendingPermissions: new Map() })),
    getLastAssistantMessage: vi.fn(async () => null),
    getMetricsSnapshot: vi.fn(() => ({
      total: 0,
      byLifecycle: {},
      withActiveForegroundTurn: 0,
      timelineStats: {
        totalItems: 0,
        maxItemsPerAgent: 0,
      },
    })),
    ...agentManagerOverrides,
  };
  const daemonConfigStore = {
    onApply: vi.fn(() => () => {}),
    onChange: vi.fn(() => () => {}),
  };

  const server = new VoiceAssistantWebSocketServer(
    createStub<HTTPServer>({}),
    createStub<pino.Logger>(logger),
    "srv-test",
    createStub<AgentManager>(agentManager),
    createStub<AgentStorage>({}),
    createStub<DownloadTokenStore>({}),
    "/tmp/paseo-test",
    createStub<DaemonConfigStore>(daemonConfigStore),
    null,
    { allowedOrigins: new Set() },
    createWorkspaceAutoNameStub(),
    createWorkspaceRuntimeStore(),
    undefined,
    undefined,
    undefined,
    undefined,
    "1.2.3-test",
    undefined,
    undefined,
    workspaceRegistry,
    createStub<ScheduleService>({}),
    createStub<CheckoutDiffManager>({
      subscribe: vi.fn(),
      scheduleRefreshForCwd: vi.fn(),
      getMetrics: vi.fn(() => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      })),
      dispose: vi.fn(),
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    pushNotifications,
    createProviderSnapshotManagerStub().manager,
  );

  return { server, agentManager, pushNotifications, logger };
}

function createOpenSocket() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
  };
}

function createSessionWithActivity(
  activity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt?: Date;
    notificationProjectIds?: ReadonlySet<string> | null;
  } | null,
  subscribed = true,
) {
  return {
    getClientActivity: vi.fn(() =>
      activity ? { notificationProjectIds: null, ...activity } : null,
    ),
    supports: () => false,
    supportsForSource: () => false,
    subscribesToAgent: vi.fn(async () => subscribed),
  };
}

function connectClient(
  server: VoiceAssistantWebSocketServer,
  activity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt?: Date;
    notificationProjectIds?: ReadonlySet<string> | null;
  } | null,
  options: { subscribed?: boolean } = {},
) {
  const ws = createOpenSocket();
  const delivery = new SessionDelivery(() => {});
  delivery.attach(ws, false);
  asInternals<WebSocketServerInternals>(server).sessions.set(ws, {
    kind: "trusted",
    session: {
      ...createSessionWithActivity(activity, options.subscribed ?? true),
      delivery,
      wantsSourceNotification: () => true,
    },
    clientId: "client-test",
    appVersion: null,
    connectionLogger: createLogger(),
    sockets: new Set([ws]),
    externalDisconnectCleanupTimeout: null,
  });
  return ws;
}

function readAttentionRequiredMessage(ws: ReturnType<typeof createOpenSocket>) {
  const rawMessage = ws.send.mock.calls[0]?.[0];
  expect(typeof rawMessage).toBe("string");
  if (typeof rawMessage !== "string") throw new Error("Expected string WebSocket frame");
  const message = JSON.parse(rawMessage);
  expect(message.type).toBe("session");
  expect(message.message.type).toBe("agent_stream");
  expect(message.message.payload.event.type).toBe("attention_required");
  return message.message.payload.event;
}

describe("VoiceAssistantWebSocketServer notification payloads", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("elects the in-scope client over a more recent out-of-scope client", async () => {
    const record: PersistedWorkspaceRecord = {
      workspaceId: WORKSPACE_ID,
      projectId: "alpha",
      cwd: "/tmp/alpha",
      kind: "directory",
      displayName: "Alpha",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    };
    const registry = createStub<WorkspaceRegistry>({ get: async () => record });
    const { server, pushNotifications } = createServer(undefined, registry);
    const alpha = connectClient(server, {
      deviceType: "web",
      appVisible: true,
      focusedAgentId: null,
      lastActivityAt: new Date(Date.now() - 1000),
      notificationProjectIds: new Set(["alpha"]),
    });
    const beta = connectClient(server, {
      deviceType: "web",
      appVisible: true,
      focusedAgentId: null,
      lastActivityAt: new Date(),
      notificationProjectIds: new Set(["beta"]),
    });
    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });
    expect(readAttentionRequiredMessage(alpha).shouldNotify).toBe(true);
    expect(readAttentionRequiredMessage(beta).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
  });

  it("drops attention without push when every present client excludes the project", async () => {
    const registry = createStub<WorkspaceRegistry>({
      get: async () => ({
        workspaceId: WORKSPACE_ID,
        projectId: "alpha",
        cwd: "/tmp/alpha",
        kind: "directory",
        displayName: "Alpha",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
      }),
    });
    const { server, pushNotifications } = createServer(undefined, registry);
    const client = connectClient(server, {
      deviceType: "web",
      appVisible: true,
      focusedAgentId: null,
      lastActivityAt: new Date(),
      notificationProjectIds: new Set(["beta"]),
    });
    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });
    expect(readAttentionRequiredMessage(client).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
  });

  it.each(["missing", "rejecting"] as const)(
    "admits only unrestricted clients for a %s workspace lookup",
    async (lookup) => {
      const failure = new Error("workspace read failed");
      const requestedIds: string[] = [];
      const registry = createStub<WorkspaceRegistry>({
        get: async (workspaceId) => {
          requestedIds.push(workspaceId);
          if (lookup === "rejecting") throw failure;
          return null;
        },
      });
      const { server, pushNotifications, logger } = createServer(
        { getAgent: () => ({ workspaceId: "current-workspace", pendingPermissions: new Map() }) },
        registry,
      );
      const unrestricted = connectClient(server, {
        deviceType: "web",
        appVisible: true,
        focusedAgentId: null,
        lastActivityAt: new Date(Date.now() - 1000),
      });
      const scoped = connectClient(server, {
        deviceType: "web",
        appVisible: true,
        focusedAgentId: null,
        lastActivityAt: new Date(),
        notificationProjectIds: new Set(["alpha"]),
      });
      await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
        agentId: "agent-1",
        provider: "claude",
        reason: "finished",
      });
      expect(requestedIds).toEqual(["current-workspace"]);
      expect(readAttentionRequiredMessage(unrestricted).shouldNotify).toBe(true);
      expect(readAttentionRequiredMessage(scoped).shouldNotify).toBe(false);
      expect(pushNotifications.sent).toEqual([]);
      if (lookup === "rejecting") {
        expect(logger.warn).toHaveBeenCalledWith(
          { err: failure, workspaceId: "current-workspace" },
          "Failed to resolve notification target project",
        );
      } else {
        expect(logger.warn).not.toHaveBeenCalled();
      }
    },
  );

  it("does not emit attention or include presence without an agent-directory subscription", async () => {
    const { server, pushNotifications } = createServer();
    const now = new Date();
    const unsubscribed = connectClient(
      server,
      {
        deviceType: "web",
        appVisible: true,
        focusedAgentId: "agent-1",
        lastActivityAt: now,
      },
      { subscribed: false },
    );

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(unsubscribed.send).not.toHaveBeenCalled();
    expect(pushNotifications.sent).toHaveLength(1);
  });

  it("uses assistant preview text for push notifications with markdown removed", async () => {
    const getLastAssistantMessage = vi.fn(
      async () => "**Done**. Updated `README.md` and [link](https://example.com).",
    );
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        workspaceId: WORKSPACE_ID,
        pendingPermissions: new Map(),
      })),
      getLastAssistantMessage,
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sent).toEqual([
      {
        title: "Agent finished",
        body: "Done. Updated README.md and link.",
        data: {
          serverId: "srv-test",
          workspaceId: WORKSPACE_ID,
          agentId: "agent-1",
          reason: "finished",
        },
      },
    ]);
    expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-1");
  });

  it("sends push notifications regardless of UI label presence", async () => {
    const getLastAssistantMessage = vi.fn(async () => "Done.");
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        workspaceId: WORKSPACE_ID,
        labels: {},
        pendingPermissions: new Map(),
      })),
      getLastAssistantMessage,
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-2",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sent).toHaveLength(1);
    expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-2");
  });

  it("routes a hidden stale focused browser tab's notification to the present Electron web client", async () => {
    const { server, pushNotifications } = createServer();
    const nowMs = Date.now();
    const electronWs = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "agent-Y",
      lastActivityAt: new Date(nowMs - 5_000),
    });
    const firefoxWs = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "agent-X",
      lastActivityAt: new Date(nowMs - 300_000),
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-X",
      provider: "claude",
      reason: "finished",
    });

    expect(readAttentionRequiredMessage(electronWs).shouldNotify).toBe(true);
    expect(readAttentionRequiredMessage(firefoxWs).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
  });

  it("pushes non-error attention when the only connected client has never sent a heartbeat", async () => {
    const { server, pushNotifications } = createServer();
    const ws = connectClient(server, null);

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-no-heartbeat",
      provider: "claude",
      reason: "finished",
    });

    expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toHaveLength(1);
  });

  it("does not push error attention when the only connected client has never sent a heartbeat", async () => {
    const { server, pushNotifications } = createServer();
    const ws = connectClient(server, null);

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-no-heartbeat",
      provider: "claude",
      reason: "error",
    });

    expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
  });
});
