import { describe, expect, test } from "vitest";
import { mkdtemp, appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiExtensionHost } from "./index.js";
import { PiHistoryMapper } from "../history-mapper.js";
import { parseToolArgs, parseToolResult } from "../tool-call-mapper.js";
import type { PiExtension, PiExtensionCustomMapping } from "./contract.js";
import { PiChildSessionFollower } from "./child-session.js";
import { PiExtensionHost } from "./host.js";
import {
  ProviderSubagentStore,
  type ProviderSubagentInputEvent,
} from "../../../provider-subagents/store.js";

const throwingAdapter: PiExtension = {
  id: "throwing-test-adapter",
  createSession: () => ({
    mapToolCall: () => {
      throw new Error("tool failed");
    },
    mapDialog: () => {
      throw new Error("dialog failed");
    },
    respondToPermission: () => {
      throw new Error("response failed");
    },
    onToolStart: () => {
      throw new Error("start failed");
    },
    onToolEnd: () => {
      throw new Error("end failed");
    },
    mapCustomMessage: () => {
      throw new Error("custom failed");
    },
  }),
};

describe("Pi extension host", () => {
  test("streams appended child rows before the child completes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-live-child-"));
    const file = join(dir, "child.jsonl");
    const received: string[] = [];
    const host = new PiExtensionHost([
      {
        id: "child",
        createSession: () => ({
          mapToolCall: () => ({
            subagents: [{ type: "upsert", id: "child-1", status: "running" }],
            childSessions: [{ id: "child-1", file }],
          }),
        }),
      },
    ]);
    try {
      host.follow((event) => {
        if (event.type === "provider_subagent" && event.event.type === "timeline") {
          received.push(JSON.stringify(event.event.item));
        }
      });
      host.mapToolCall({
        callId: "x",
        toolName: "child",
        args: {},
        status: "completed",
        result: null,
      });
      await appendFile(
        file,
        '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"BEGIN"}]}}\n',
      );
      await expect.poll(() => received.length).toBe(1);
      await appendFile(
        file,
        '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"DO',
      );
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(received).toHaveLength(1);
      await appendFile(file, 'NE"}]}}\n');
      await expect.poll(() => received.length).toBe(2);
      expect(received.join(" ")).toContain("DONE");
    } finally {
      host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("publishes the final one-shot child read before releasing its follower", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-finished-child-"));
    const file = join(dir, "child.jsonl");
    const host = new PiExtensionHost([
      {
        id: "child",
        createSession: () => ({
          mapRuntimeNotification: () => ({
            subagents: [{ type: "upsert", id: "child", status: "completed" }],
            childSessions: [{ id: "child", file }],
          }),
        }),
      },
    ]);
    const received: ProviderSubagentInputEvent[] = [];
    try {
      await writeFile(
        file,
        JSON.stringify({
          message: { role: "assistant", content: [{ type: "text", text: "FINAL" }] },
        }) + "\n",
      );
      host.follow((event) => {
        if (event.type === "provider_subagent") received.push(event.event);
      });
      await host.mapRuntimeNotification("finished")?.hydration;
      expect(received).toMatchObject([
        { type: "timeline", item: { type: "assistant_message", text: "FINAL" } },
      ]);
      await appendFile(
        file,
        JSON.stringify({
          message: { role: "assistant", content: [{ type: "text", text: "AFTER_COMPLETION" }] },
        }) + "\n",
      );
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(received).toHaveLength(1);
    } finally {
      host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("declines a throwing adapter and preserves generic history", async () => {
    const host = createPiExtensionHost(undefined, [throwingAdapter]);
    const mapper = new PiHistoryMapper("pi", [], {}, host);
    const events = await mapper.mapMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "other", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "other",
        content: [{ type: "text", text: "ok" }],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
    expect(events.filter((event) => event.type === "timeline")).toHaveLength(3);
    expect(await mapper.hydrate()).toEqual([]);
  });

  test("declines throwing lifecycle and dialog hooks", () => {
    const host = createPiExtensionHost(undefined, [throwingAdapter]);
    const call = {
      callId: "x",
      toolName: "other",
      args: {},
      status: "running" as const,
      result: null,
    };
    expect(host.onToolStart(call)).toBeUndefined();
    expect(() => host.onToolEnd(call)).not.toThrow();
    expect(
      host.mapDialog(
        {
          type: "extension_ui_request",
          id: "ui-1",
          method: "select",
          title: "Pick",
          options: ["A"],
        },
        "pi",
      ),
    ).toBeUndefined();
    expect(
      host.respondToPermission(
        { id: "ui-1", provider: "pi", kind: "question", title: "Pick", input: { questions: [] } },
        { behavior: "allow" },
      ),
    ).toBeUndefined();
    expect(
      host.mapCustomMessage({ role: "custom", customType: "other", content: "hello" }),
    ).toBeUndefined();
  });

  test("rejected child hydration emits no events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-rejected-hydration-"));
    try {
      const file = join(dir, "child.jsonl");
      await appendFile(file, "x");
      let readerCalls = 0;
      const host = new PiExtensionHost(
        [
          {
            id: "child",
            createSession: () => ({
              mapToolCall: () => ({ childSessions: [{ id: "child-1", file }] }),
            }),
          },
        ],
        undefined,
        2 * 1024 * 1024,
        async () => {
          readerCalls += 1;
          throw new Error("read failed");
        },
      );
      const output = host.mapToolCall({
        callId: "x",
        toolName: "other",
        args: {},
        status: "completed",
        result: null,
      });
      expect(await output?.hydration).toEqual([]);
      expect(readerCalls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("charges replay reads by transcript size, not the per-file cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-replay-budget-"));
    try {
      const files = Array.from({ length: 10 }, (_, index) => join(dir, `${index}.jsonl`));
      for (const file of files) await appendFile(file, "x".repeat(400));
      const replay = async (budget: number) => {
        const reads: number[] = [];
        const host = new PiExtensionHost(
          [
            {
              id: "child",
              createSession: () => ({
                mapToolCall: () => ({
                  childSessions: files.map((file, index) => ({ id: String(index), file })),
                }),
              }),
            },
          ],
          undefined,
          budget,
          async (_id, _file, bytes) => {
            reads.push(bytes ?? 0);
            return [];
          },
        );
        await host.mapToolCall({
          callId: "x",
          toolName: "other",
          args: {},
          status: "completed",
          result: null,
        })?.hydration;
        return reads.sort((a, b) => b - a);
      };

      expect(await replay(16 * 1024 * 1024)).toEqual(Array(10).fill(400));
      expect(await replay(1000)).toEqual([400, 400, 200]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("claims a tool, declines an unrelated one, and maps history like live events", async () => {
    const host = createPiExtensionHost();
    const args = { agent: "scout", task: "Inspect files" };
    const result = parseToolResult({ content: [{ type: "text", text: "Found two files" }] });
    const live = host.mapToolCall({
      callId: "call-1",
      toolName: "subagent",
      args,
      status: "completed",
      result,
    });
    expect(live).toEqual(
      expect.objectContaining({
        detail: {
          type: "sub_agent",
          subAgentType: "scout",
          description: "Inspect files",
          log: "",
        },
      }),
    );
    expect(
      host.mapToolCall({
        callId: "call-2",
        toolName: "unrelated",
        args: {},
        status: "completed",
        result,
      }),
    ).toBeUndefined();

    const mapper = new PiHistoryMapper("pi");
    const events = await mapper.mapMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: args }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "subagent",
        content: [{ type: "text", text: "Found two files" }],
      },
    ]);
    const completed = events.find(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "tool_call" &&
        event.item.status === "completed",
    );
    expect(
      completed?.type === "timeline" && completed.item.type === "tool_call"
        ? completed.item.detail
        : null,
    ).toEqual(live?.detail);
    expect(parseToolArgs("subagent", args).toolName).toBe("subagent");
  });
});

test("conversation followers park at idle, retain offsets past 200 items and reset only on replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paseo-btw-follower-"));
  const file = join(dir, "thread.jsonl");
  const other = join(dir, "replacement.jsonl");
  const received: string[] = [];
  const host = new PiExtensionHost([
    {
      id: "conversation",
      createSession: () => ({
        mapRuntimeNotification: (status) => ({
          subagents: [
            {
              type: "upsert",
              id: "btw:thread",
              status: status === "running" ? "running" : "completed",
            },
          ],
          childSessions: [
            {
              id: "btw:thread",
              file: status === "replacement" ? other : file,
              lifetime: "conversation",
            },
          ],
        }),
      }),
    },
  ]);
  const row = (n: number) =>
    JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: `answer-${n}` }] },
    }) + "\n";
  try {
    host.follow((event) => {
      if (event.type === "provider_subagent" && event.event.type === "timeline")
        received.push(JSON.stringify(event.event.item));
    });
    await appendFile(file, Array.from({ length: 230 }, (_, i) => row(i)).join(""));
    await host.mapRuntimeNotification("idle")?.hydration;
    expect(received).toHaveLength(230);
    await host.mapRuntimeNotification("running")?.hydration;
    expect(received).toHaveLength(230);
    await appendFile(file, row(230));
    await host.mapRuntimeNotification("idle")?.hydration;
    expect(received).toHaveLength(231);
    await host.mapRuntimeNotification("running")?.hydration;
    await host.mapRuntimeNotification("idle")?.hydration;
    expect(received).toHaveLength(231);
    await appendFile(other, row(999));
    await host.mapRuntimeNotification("replacement")?.hydration;
    expect(received).toHaveLength(232);
    expect(received[231]).toContain("answer-999");
  } finally {
    host.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("conversation source keys survive split UTF-8, partial and multi-item lines, and preserve repeated text and replaced files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paseo-btw-source-"));
  const file = join(dir, "thread.jsonl");
  const row = Buffer.from(
    JSON.stringify({
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "你好" },
          { type: "text", text: "same" },
        ],
      },
    }) + "\n",
  );
  const live = new PiChildSessionFollower("btw", file, 7, "conversation");
  const readAll = async (reader: PiChildSessionFollower) => {
    const events: ProviderSubagentInputEvent[] = [];
    do {
      events.push(...(await reader.readNew()));
    } while (reader.hasMore);
    return events;
  };
  try {
    const split = row.indexOf(Buffer.from("你")) + 1;
    await writeFile(file, row.subarray(0, split));
    expect(await readAll(live)).toEqual([]);
    await appendFile(file, row.subarray(split));
    const first = await readAll(live);
    expect(first).toHaveLength(2);
    await appendFile(file, row);
    const second = await readAll(live);
    const history = await readAll(
      new PiChildSessionFollower("btw", file, undefined, "conversation"),
    );
    expect(history).toEqual([...first, ...second]);
    const keys = history.map((event) => (event.type === "timeline" ? event.sourceKey : null));
    expect(new Set(keys).size).toBe(4);
    const store = new ProviderSubagentStore();
    for (const event of [...first, ...second, ...history]) store.apply("parent", "pi", event);
    expect(store.fetchTimeline("parent", "btw", { limit: 0 }).rows.at(-1)?.seq).toBe(4);
    await writeFile(file, row.toString().replace("你好", "再见"));
    const replaced = await readAll(
      new PiChildSessionFollower("btw", file, undefined, "conversation"),
    );
    expect(replaced).toHaveLength(2);
    expect(
      replaced.map((event) => (event.type === "timeline" ? event.sourceKey : null)),
    ).not.toEqual(keys.slice(0, 2));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("conversation readers have per-read byte budgets while one-shot readers keep lifetime limits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paseo-btw-byte-budget-"));
  const file = join(dir, "thread.jsonl");
  const row =
    JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "x".repeat(1024) }] },
    }) + "\n";
  try {
    await appendFile(file, row.repeat(5));
    const conversation = new PiChildSessionFollower("btw", file, row.length, "conversation");
    const oneShot = new PiChildSessionFollower("child", file, row.length);
    for (let i = 0; i < 5; i++) expect(await conversation.readNew()).toHaveLength(1);
    expect(await conversation.readNew()).toEqual([]);
    expect(await oneShot.readNew()).toHaveLength(1);
    expect(await oneShot.readNew()).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("conversation history is complete beyond 200 items and 2 MiB, repeatable, and independent of live parked offsets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paseo-btw-history-"));
  const file = join(dir, "thread.jsonl");
  const mapping: PiExtensionCustomMapping = {
    subagents: [{ type: "upsert", id: "btw", status: "completed" }],
    childSessions: [{ id: "btw", file, lifetime: "conversation" }],
  };
  const host = new PiExtensionHost([
    {
      id: "conversation",
      createSession: () => ({
        mapRuntimeNotification: () => mapping,
        replay: () => mapping,
      }),
    },
  ]);
  const live: string[] = [];
  const row = (n: number) =>
    JSON.stringify({
      message: {
        role: "assistant",
        content: [{ type: "text", text: `answer-${n}:` + "x".repeat(10000) }],
      },
    }) + "\n";
  const history = async () => {
    const items: string[] = [];
    for await (const event of host.streamHistory()) {
      if (
        event.type === "provider_subagent" &&
        event.event.type === "timeline" &&
        event.event.item.type === "assistant_message"
      )
        items.push(event.event.item.text.slice(0, 20));
    }
    return items;
  };
  try {
    await appendFile(file, Array.from({ length: 230 }, (_, index) => row(index)).join(""));
    host.follow((event) => {
      if (event.type === "provider_subagent" && event.event.type === "timeline")
        live.push(event.event.id);
    });
    await host.mapRuntimeNotification("idle")?.hydration;
    expect(live).toHaveLength(230);
    const first = await history();
    expect(first).toHaveLength(230);
    expect(await history()).toEqual(first);
    expect(live).toHaveLength(230);
    const canceled = host.streamHistory();
    await canceled.next();
    await canceled.return(undefined);
    await appendFile(file, row(230));
    await host.mapRuntimeNotification("idle")?.hydration;
    expect(live).toHaveLength(231);
    expect(await history()).toHaveLength(231);
    expect(live).toHaveLength(231);
    host.close();
    expect(await history()).toEqual([]);
  } finally {
    host.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "pi-btw projection removes only the known generated first prefix (structured=%s)",
  async (structured) => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-btw-display-"));
    const file = join(dir, "thread.jsonl");
    const prefix =
      "<btw>You are a read-only side conversation. The inherited conversation is context, not a task to continue. Answer the question below. Only unchanged Pi read, grep, find and ls tools execute; other tools return errors. Nothing is sent to the main agent unless the user explicitly requests it.</btw>\n\n";
    const question = "Literal <btw>user markup</btw>\n日本語";
    const content = prefix + prefix + question;
    const row = (text: string) =>
      JSON.stringify({
        message: { role: "user", content: structured ? [{ type: "text", text }] : text },
      }) + "\n";
    const bytes = row(content) + row(prefix + question);
    const mapping: PiExtensionCustomMapping = {
      subagents: [{ type: "upsert", id: "thread", status: "completed" }],
      childSessions: [{ id: "thread", file, lifetime: "conversation", projection: "pi-btw" }],
    };
    const extension: PiExtension = {
      id: "btw-test",
      createSession: () => ({
        mapRuntimeNotification: () => mapping,
        replay: () => mapping,
      }),
    };
    const host = new PiExtensionHost([extension]);
    const live: ProviderSubagentInputEvent[] = [];
    const items = (events: ProviderSubagentInputEvent[]) =>
      events.flatMap((event) => (event.type === "timeline" ? [event.item] : []));
    try {
      await writeFile(file, bytes);
      const hydrated = await host.mapRuntimeNotification("hydrate")?.hydration;
      expect(
        hydrated?.map((event) => (event.type === "provider_subagent" ? event.event : null)),
      ).toMatchObject([
        { item: { type: "user_message", text: prefix + question } },
        { item: { type: "user_message", text: prefix + question } },
      ]);
      host.follow((event) => {
        if (event.type === "provider_subagent") live.push(event.event);
      });
      await host.mapRuntimeNotification("live")?.hydration;
      expect(items(live)).toMatchObject([
        { type: "user_message", text: prefix + question },
        { type: "user_message", text: prefix + question },
      ]);
      const history: ProviderSubagentInputEvent[] = [];
      for await (const event of host.streamHistory())
        if (event.type === "provider_subagent" && event.event.type === "timeline")
          history.push(event.event);
      expect(history).toEqual(live);
      expect(await readFile(file, "utf8")).toBe(bytes);
      const generic = await new PiChildSessionFollower(
        "other",
        file,
        undefined,
        "conversation",
      ).readNew();
      expect(items(generic)).toMatchObject([
        { type: "user_message", text: content },
        { type: "user_message", text: prefix + question },
      ]);
      await writeFile(file, row(question) + row(prefix + question));
      const literal = await new PiChildSessionFollower(
        "thread",
        file,
        undefined,
        "conversation",
        undefined,
        "pi-btw",
      ).readNew();
      expect(items(literal)).toMatchObject([
        { type: "user_message", text: question },
        { type: "user_message", text: prefix + question },
      ]);
    } finally {
      host.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
