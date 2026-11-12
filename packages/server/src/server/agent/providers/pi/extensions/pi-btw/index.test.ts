import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PiExtensionHost } from "../host.js";
import { vi } from "vitest";
import { piBtw, piBtwRuntimeBridge, PI_BTW_MARKER } from "./index.js";

export function btwState(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    parentSessionId: "parent",
    threadId: "thread",
    mode: "contextual",
    status: "idle",
    title: "Why?",
    sessionFile: "/tmp/btw/sessions/parent/thread/messages.jsonl",
    resumable: true,
    revision: 1,
    boundary: {
      kind: "turn_end",
      parentLeafEntryId: "leaf",
      parentTurnIndex: 2,
      messageCount: 4,
      prefixDigest: "a".repeat(64),
      pinnedAt: "2026-01-01T00:00:00.000Z",
    },
    parentAhead: 1,
    cache: {
      provider: "test",
      modelId: "model",
      api: "openai-completions",
      thinkingLevel: "off",
      requestSessionId: "parent",
      sharesParentPrefix: true,
      reason: null,
    },
    lastUsage: {
      input: 10,
      output: 2,
      cacheRead: 80,
      cacheWrite: 10,
      at: "2026-01-01T00:00:00.000Z",
    },
    error: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
export function btwNotification(thread = btwState()) {
  return `${PI_BTW_MARKER} ${JSON.stringify({ parentSessionId: "parent", event: { type: "state", thread } })}`;
}

describe("pi-btw adapter contract v1", () => {
  test.each([
    ["idle", "completed"],
    ["running", "running"],
    ["failed", "failed"],
    ["aborted", "canceled"],
  ])("maps %s with presentation, bounded file identity and pinned subtitle", (status, mapped) => {
    const session = piBtw.createSession();
    expect(
      session.mapRuntimeNotification?.(btwNotification(btwState({ status, error: "retry" }))),
    ).toEqual({
      subagents: [
        {
          type: "upsert",
          id: "btw:thread",
          title: "Why?",
          description: "retry",
          status: mapped,
          hasTimeline: true,
          subtitle: "Read-only · pinned turn 2 · next turn 3 · cache 80%",
          presentation: "side_conversation",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
      childSessions: [
        {
          id: "btw:thread",
          file: "/tmp/btw/sessions/parent/thread/messages.jsonl",
          lifetime: "conversation",
          projection: "pi-btw",
        },
      ],
    });
  });
  test("sync is idempotent, stale events never replace state and clear is terminal", () => {
    const session = piBtw.createSession();
    session.mapRuntimeNotification?.(btwNotification());
    expect(session.mapRuntimeNotification?.(btwNotification())).toEqual({ subagents: [] });
    expect(session.mapRuntimeNotification?.(btwNotification(btwState({ revision: 0 })))).toEqual({
      subagents: [],
    });
    expect(
      session.mapRuntimeNotification?.(
        `${PI_BTW_MARKER} ${JSON.stringify({
          parentSessionId: "parent",
          event: {
            type: "closed",
            version: 1,
            parentSessionId: "parent",
            threadId: "thread",
            reason: "cleared",
          },
        })}`,
      ),
    ).toEqual({ subagents: [{ type: "remove", id: "btw:thread" }] });
    expect(session.mapRuntimeNotification?.(btwNotification(btwState({ revision: 10 })))).toEqual({
      subagents: [],
    });
  });
  test("replacement removes the previous thread and in-memory threads have no file", () => {
    const session = piBtw.createSession();
    session.mapRuntimeNotification?.(btwNotification());
    const next = session.mapRuntimeNotification?.(
      btwNotification(btwState({ threadId: "next", sessionFile: null, resumable: false })),
    );
    expect(next?.subagents?.[0]).toEqual({ type: "remove", id: "btw:thread" });
    expect(next?.subagents?.[1]).toMatchObject({ id: "btw:next", hasTimeline: false });
    expect(next?.childSessions).toEqual([]);
  });
  test.each([
    { version: 2 },
    { sessionFile: "/tmp/parent.jsonl" },
    { sessionFile: "/tmp/btw/sessions/parent/thread/snapshot.json" },
    { parentSessionId: "source" },
    { revision: -1 },
  ])("rejects malformed/unsupported state %j without advancing revision", (invalid) => {
    const session = piBtw.createSession();
    expect(() => session.mapRuntimeNotification?.(btwNotification(btwState(invalid)))).toThrow();
    expect(session.mapRuntimeNotification?.(btwNotification())?.subagents).toHaveLength(1);
  });
  test("rejects changed file identity and ignores unrelated notifications", () => {
    const session = piBtw.createSession();
    expect(session.mapRuntimeNotification?.("other")).toBeUndefined();
    session.mapRuntimeNotification?.(btwNotification());
    expect(() =>
      session.mapRuntimeNotification?.(
        btwNotification(
          btwState({ revision: 2, sessionFile: "/tmp/btw/sessions/parent/thread/other.jsonl" }),
        ),
      ),
    ).toThrow("identity changed");
  });
});

test("malformed bridge payload is swallowed without a UI notification and warns once", async () => {
  const warn = vi.fn();
  const host = new PiExtensionHost([piBtw], { warn });
  for (let i = 0; i < 3; i++) {
    const result = host.mapRuntimeNotification("PASEO_PI_BTW broken");
    expect(result?.events).toEqual([]);
    expect(await result?.hydration).toEqual([]);
  }
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("broken");
  host.close();
});

test("runtime listener precedes idempotent sync, filters native owners and internal sync invokes no model", async () => {
  const notify = vi.fn();
  const context = { sessionManager: { getSessionId: () => "parent" }, ui: { notify } };
  const lifecycle = new Map<string, (event: unknown, ctx: typeof context) => void>();
  const channels = new Map<string, (event: unknown) => void>();
  const commands = new Map<string, { handler(args: string, ctx: typeof context): Promise<void> }>();
  const state = { type: "state", thread: btwState() };
  const emit = vi.fn((channel: string) => {
    if (channel === "pi-btw:sync") channels.get("pi-btw:thread")?.(state);
  });
  const pi = {
    events: {
      on: (channel: string, listener: (event: unknown) => void) => channels.set(channel, listener),
      emit,
    },
    on: (name: string, listener: (event: unknown, ctx: typeof context) => void) =>
      lifecycle.set(name, listener),
    registerCommand: (
      name: string,
      command: { handler(args: string, ctx: typeof context): Promise<void> },
    ) => commands.set(name, command),
  };
  new Function("pi", piBtwRuntimeBridge)(pi);
  lifecycle.get("session_start")?.({}, context);
  await commands.get("paseo_btw_sync")?.handler("", context);
  await commands.get("paseo_btw_sync")?.handler("", context);
  expect(emit).toHaveBeenCalledTimes(3);
  expect(notify).toHaveBeenCalledTimes(3);
  channels.get("pi-btw:thread")?.({
    type: "state",
    thread: btwState({ parentSessionId: "source" }),
  });
  expect(notify).toHaveBeenCalledTimes(3);
  lifecycle.get("session_shutdown")?.({}, context);
  channels.get("pi-btw:thread")?.(state);
  expect(notify).toHaveBeenCalledTimes(3);
});

test("command failure keeps producer revision ownership and the next producer state recovers", () => {
  const host = new PiExtensionHost([piBtw]);
  host.mapRuntimeNotification(btwNotification());
  const command = host.beginOutOfBandCommand("btw");
  expect(command?.fail(new Error("RPC disconnected"))?.events).toEqual([
    {
      type: "provider_subagent",
      provider: "pi",
      event: {
        type: "upsert",
        id: "btw:thread",
        status: "failed",
        description: "RPC disconnected",
        timestamp: expect.any(String),
      },
    },
  ]);
  expect(host.mapRuntimeNotification(btwNotification())?.events).toEqual([]);
  expect(
    host.mapRuntimeNotification(btwNotification(btwState({ revision: 2, status: "running" })))
      ?.events,
  ).toContainEqual(
    expect.objectContaining({
      type: "provider_subagent",
      event: expect.objectContaining({ id: "btw:thread", status: "running", description: null }),
    }),
  );
  host.close();
  expect(command?.fail(new Error("Late disconnect"))).toBeUndefined();
});

test("replay preserves the current thread and local error, and never resurrects replaced or closed threads", async () => {
  const host = new PiExtensionHost([piBtw]);
  const collect = async () => {
    const events = [];
    for await (const event of host.streamHistory()) events.push(event);
    return events;
  };
  host.mapRuntimeNotification(btwNotification(btwState({ sessionFile: null })));
  host.beginOutOfBandCommand("btw")?.fail(new Error("Command admission failed"));
  expect(await collect()).toContainEqual(
    expect.objectContaining({
      event: expect.objectContaining({
        id: "btw:thread",
        status: "failed",
        description: "Command admission failed",
      }),
    }),
  );
  host.mapRuntimeNotification(btwNotification(btwState({ threadId: "new", sessionFile: null })));
  expect(await collect()).toHaveLength(1);
  expect(await collect()).toContainEqual(
    expect.objectContaining({
      event: expect.objectContaining({ id: "btw:new", status: "completed", description: null }),
    }),
  );
  host.mapRuntimeNotification(
    `${PI_BTW_MARKER} ${JSON.stringify({ parentSessionId: "parent", event: { type: "closed", version: 1, parentSessionId: "parent", threadId: "new", reason: "cleared" } })}`,
  );
  host.mapRuntimeNotification(
    btwNotification(btwState({ threadId: "new", sessionFile: null, revision: 10 })),
  );
  expect(await collect()).toEqual([]);
  host.close();
});

test("closing a runtime during a history replay prevents later history publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paseo-btw-close-history-"));
  const file = join(dir, "btw/sessions/parent/thread/messages.jsonl");
  const host = new PiExtensionHost([piBtw]);
  try {
    await mkdir(join(dir, "btw/sessions/parent/thread"), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        message: { role: "assistant", content: [{ type: "text", text: "history" }] },
      }) + "\n",
    );
    await host.mapRuntimeNotification(btwNotification(btwState({ sessionFile: file })))?.hydration;
    const history = host.streamHistory();
    expect((await history.next()).done).toBe(false);
    host.close();
    expect(await history.next()).toEqual({ done: true, value: undefined });
  } finally {
    host.close();
    await rm(dir, { recursive: true, force: true });
  }
});
