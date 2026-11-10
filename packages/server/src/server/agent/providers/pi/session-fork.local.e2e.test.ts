import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { PiRpcAgentClient } from "./agent.js";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  appendFile,
  rename,
  stat,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { afterEach, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { PiCliRuntime } from "./cli-runtime.js";
import type { PiRuntime } from "./runtime.js";
import { materializePiBranch, readPiSessionPath } from "./session-fork.js";

const logger = createTestLogger();
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(fixtureName = "continuation-session.jsonl") {
  const root = await mkdtemp(join(tmpdir(), "paseo-native-fork-"));
  roots.push(root);
  const sourceFile = join(root, "source.jsonl");
  const fixture = fileURLToPath(new URL(`./fixtures/session-fork/${fixtureName}`, import.meta.url));
  const lines = (await readFile(fixture, "utf8")).trimEnd().split("\n");
  const header = JSON.parse(lines[0]!);
  header.cwd = root;
  lines[0] = JSON.stringify(header);
  await writeFile(sourceFile, lines.join("\n") + "\n");
  const source = await readPiSessionPath(sourceFile, null);
  const integrity = async () => ({
    hash: createHash("sha256")
      .update(await readFile(sourceFile))
      .digest("hex"),
    mtime: (await stat(sourceFile, { bigint: true })).mtimeNs,
  });
  const runtime = new PiCliRuntime({ logger, command: [process.env.PASEO_PI_BINARY ?? "pi"] });
  return { root, sourceFile, source, integrity, runtime, targetEntryId: source.path.at(-1)!.id };
}

test("public SDK materialization preserves native entries and source bytes/mtime without a model call", async () => {
  const f = await setup();
  const before = await f.integrity();
  const branch = await materializePiBranch({
    ...f,
    cwd: f.root,
    signal: new AbortController().signal,
    logger,
  });
  const copied = await readPiSessionPath(branch.sessionFile, null);
  expect(branch.sessionId).not.toBe(f.source.header.id);
  expect(copied.path.filter((e) => e.type !== "label")).toEqual(
    f.source.path.filter((e) => e.type !== "label"),
  );
  const branchRecords = (await readFile(branch.sessionFile, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const sourceRecords = (await readFile(f.sourceFile, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(branchRecords.slice(1)).toEqual(sourceRecords.slice(1));
  const header = branchRecords[0];
  expect(header.parentSession).toBe(f.sourceFile);
  expect(await f.integrity()).toEqual(before);
  expect(await readdir(f.root)).not.toContain(".paseo-fork-staging");
  // Only the destination is opened as a full runtime.
  const destination = await f.runtime.startSession({
    cwd: f.root,
    session: branch.sessionFile,
    extraArgs: ["--no-extensions", "--no-mcp"],
  });
  try {
    const raw = z
      .object({ entries: z.array(z.unknown()) })
      .parse(await destination.request({ type: "get_entries" }));
    expect(raw.entries).toEqual(sourceRecords.slice(1));
    const history = await destination.getHistory();
    expect(history.messages.filter((m) => m.role === "toolResult").length).toBeGreaterThan(0);
    expect(history.messages.filter((m) => m.role === "assistant").length).toBeGreaterThan(0);
  } finally {
    await destination.close();
  }
}, 60_000);

test("version mismatch and unknown entry remove staging and preserve source", async () => {
  const f = await setup();
  for (const version of [3, -1]) {
    if (version < 0) {
      const lines = (await readFile(f.sourceFile, "utf8")).split("\n");
      lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), version });
      await writeFile(f.sourceFile, lines.join("\n"));
    }
    const before = await f.integrity();
    await expect(
      materializePiBranch({
        ...f,
        targetEntryId: "absent",
        cwd: f.root,
        signal: new AbortController().signal,
        logger,
      }),
    ).rejects.toMatchObject({
      code: version < 0 ? "source_needs_migration" : "materialize_failed",
    });
    expect(await f.integrity()).toEqual(before);
    expect(await readdir(f.root)).toEqual(["source.jsonl"]);
  }
}, 60_000);

test("worker spawn failure removes staging", async () => {
  const f = await setup();
  const before = await f.integrity();
  const runtime: PiRuntime = {
    startSession: async () => {
      throw new Error("spawn failure");
    },
  };
  await expect(
    materializePiBranch({
      ...f,
      runtime,
      cwd: f.root,
      signal: new AbortController().signal,
      logger,
    }),
  ).rejects.toMatchObject({ code: "materialize_failed" });
  expect(await f.integrity()).toEqual(before);
  expect(await readdir(f.root)).toEqual(["source.jsonl"]);
});

test("abort and deadline close the extension-free worker and sweep staging", async () => {
  const f = await setup();
  const before = await f.integrity();
  for (const timeout of [false, true]) {
    const controller = new AbortController();
    const timer = new AbortController();
    if (timeout) vi.spyOn(AbortSignal, "timeout").mockReturnValue(timer.signal);
    const runtime: PiRuntime = {
      startSession: async (input) => {
        expect(input.noSession).toBe(true);
        expect(input.extraArgs).toEqual(["--no-extensions", "--no-mcp"]);
        const real = await f.runtime.startSession(input);
        return new Proxy(real, {
          get(target, key, receiver) {
            if (key === "onEvent") return () => () => {};
            if (key === "prompt")
              return async () => {
                (timeout ? timer : controller).abort();
                throw new Error("aborted");
              };
            const value = Reflect.get(target, key, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    await expect(
      materializePiBranch({ ...f, runtime, cwd: f.root, signal: controller.signal, logger }),
    ).rejects.toMatchObject({ code: timeout ? "timeout" : "canceled" });
    expect(await f.integrity()).toEqual(before);
    expect(await readdir(f.root)).toEqual(["source.jsonl"]);
  }
}, 60_000);

test("a destination collision never clobbers an existing native file", async () => {
  const f = await setup();
  const before = await f.integrity();
  let existing: string | undefined;
  const runtime: PiRuntime = {
    startSession: async (input) => {
      const real = await f.runtime.startSession(input);
      return new Proxy(real, {
        get(target, key) {
          if (key === "onEvent")
            return (callback: Parameters<typeof real.onEvent>[0]) =>
              real.onEvent((event) => {
                if (
                  event.type === "extension_ui_request" &&
                  typeof event.message === "string" &&
                  event.message.startsWith("PASEO_COMMAND_RESULT ")
                ) {
                  const result = JSON.parse(event.message.slice("PASEO_COMMAND_RESULT ".length));
                  if (result.ok) {
                    existing = join(f.root, basename(result.sessionFile));
                    writeFileSync(existing, "preexisting native file");
                  }
                }
                callback(event);
              });
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  await expect(
    materializePiBranch({
      ...f,
      runtime,
      cwd: f.root,
      signal: new AbortController().signal,
      logger,
    }),
  ).rejects.toMatchObject({ code: "materialize_failed" });
  if (!existing) throw new Error("The helper did not produce a destination collision");
  expect(await readFile(existing, "utf8")).toBe("preexisting native file");
  expect(await f.integrity()).toEqual(before);
  expect(await readdir(f.root)).not.toContain(".paseo-fork-staging");
}, 60_000);

test("destination resume failure deletes the published branch and leaves the source intact", async () => {
  const f = await setup();
  const before = await f.integrity();
  const runtime: PiRuntime = {
    startSession: async (input) => {
      if (input.session) throw new Error("destination runtime cannot start");
      return f.runtime.startSession(input);
    },
  };
  const client = new PiRpcAgentClient({ logger, runtime });
  await expect(
    client.forkSession(
      {
        source: { provider: "pi", sessionId: f.source.header.id, nativeHandle: f.sourceFile },
        cwd: f.root,
        target: { kind: "latest", leafEntryId: null },
        signal: new AbortController().signal,
      },
      { config: { provider: "pi", cwd: f.root }, storedConfig: { provider: "pi", cwd: f.root } },
    ),
  ).rejects.toMatchObject({ code: "resume_failed" });
  expect(await f.integrity()).toEqual(before);
  expect(await readdir(f.root)).toEqual(["source.jsonl"]);
}, 60_000);

// Unmodified G3 real Pi steer/error/tool/compaction capture; only the disposable header cwd changes.
test("SDK branching preserves real compaction firstKeptEntryId and its structured native ancestry", async () => {
  const f = await setup("compaction-session.jsonl");
  const before = await f.integrity();
  const branch = await materializePiBranch({
    ...f,
    cwd: f.root,
    signal: new AbortController().signal,
    logger,
  });
  const sourceRecords = (await readFile(f.sourceFile, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const branchRecords = (await readFile(branch.sessionFile, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(branchRecords.slice(1)).toEqual(sourceRecords.slice(1));
  expect(branchRecords.find((entry) => entry.type === "compaction")).toMatchObject({
    id: "777ba4f8",
    firstKeptEntryId: "7d387f4b",
  });
  const destination = await f.runtime.startSession({
    cwd: f.root,
    session: branch.sessionFile,
    extraArgs: ["--no-extensions", "--no-mcp"],
  });
  try {
    const messages = z
      .object({ messages: z.array(z.object({ role: z.string() })) })
      .parse(await destination.request({ type: "get_messages" }));
    expect(messages.messages.map((message) => message.role)).toContain("compactionSummary");
    const entries = z
      .object({ entries: z.array(z.unknown()) })
      .parse(await destination.request({ type: "get_entries" }));
    expect(entries.entries).toEqual(sourceRecords.slice(1));
  } finally {
    await destination.close();
  }
  expect(await f.integrity()).toEqual(before);
}, 60_000);

test("a configured source extension executes normally and is absent from the isolated helper", async () => {
  const f = await setup();
  const before = await f.integrity();
  const marker = join(f.root, "source-extension-loaded");
  const extension = join(f.root, "source-extension.ts");
  await writeFile(
    extension,
    `import { writeFileSync } from "node:fs"; export default function() { writeFileSync(${JSON.stringify(marker)}, "loaded"); }`,
  );
  const runtime = new PiCliRuntime({
    logger,
    command: [process.env.PASEO_PI_BINARY ?? "pi", "--extension", extension],
  });
  const ordinary = await runtime.startSession({
    cwd: f.root,
    noSession: true,
    extraArgs: ["--no-extensions", "--no-mcp"],
  });
  try {
    await ordinary.getState();
    expect(await readFile(marker, "utf8")).toBe("loaded");
  } finally {
    await ordinary.close();
  }
  await rm(marker);
  await materializePiBranch({
    ...f,
    runtime,
    cwd: f.root,
    signal: new AbortController().signal,
    logger,
  });
  expect(await readdir(f.root)).not.toContain("source-extension-loaded");
  expect(await f.integrity()).toEqual(before);
}, 60_000);

test("a missing helper command fails unsupported without sending any model prompt", async () => {
  const f = await setup();
  const before = await f.integrity();
  const prompt = vi.fn();
  const runtime: PiRuntime = {
    startSession: async (input) => {
      const real = await f.runtime.startSession(input);
      return new Proxy(real, {
        get(target, key) {
          if (key === "getCommands") return async () => [];
          if (key === "prompt") return prompt;
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  await expect(
    materializePiBranch({
      ...f,
      runtime,
      cwd: f.root,
      signal: new AbortController().signal,
      logger,
    }),
  ).rejects.toMatchObject({ code: "unsupported" });
  expect(prompt).not.toHaveBeenCalled();
  expect(await f.integrity()).toEqual(before);
  expect(await readdir(f.root)).toEqual(["source.jsonl"]);
});

test("cloning a labeled native leaf honors SDK label rechaining without rejecting the correct branch", async () => {
  const f = await setup();
  const leaf = f.source.path.at(-1)!.id;
  await appendFile(
    f.sourceFile,
    JSON.stringify({
      type: "label",
      id: "source-label",
      parentId: leaf,
      targetId: leaf,
      label: "source mark",
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
  const before = await f.integrity();
  const branch = await materializePiBranch({
    ...f,
    targetEntryId: "source-label",
    cwd: f.root,
    signal: new AbortController().signal,
    logger,
  });
  const records = (await readFile(branch.sessionFile, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const label = records.find((entry) => entry.type === "label");
  expect(label).toMatchObject({ label: "source mark", targetId: leaf, parentId: leaf });
  expect(label.id).not.toBe("source-label");
  expect(await f.integrity()).toEqual(before);
}, 60_000);

test("fork origin records the re-chained destination label before resume appends its own native entries", async () => {
  const f = await setup("observed-framing-session.jsonl");
  const leaf = f.source.path.at(-1)!.id;
  await appendFile(
    f.sourceFile,
    JSON.stringify({
      type: "label",
      id: "source-final-label",
      parentId: leaf,
      targetId: leaf,
      label: "marked copy",
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
  const before = await f.integrity();
  const client = new PiRpcAgentClient({ logger, runtime: f.runtime });
  const config = {
    provider: "pi",
    cwd: f.root,
    model: process.env.PI_REAL_TEST_MODEL ?? "magpie/group/luna-fast",
  };
  const imported = await client.forkSession(
    {
      source: { provider: "pi", sessionId: f.source.header.id, nativeHandle: f.sourceFile },
      cwd: f.root,
      target: { kind: "latest", leafEntryId: null },
      signal: new AbortController().signal,
    },
    { config, storedConfig: config },
  );
  try {
    const branch = await readPiSessionPath(imported.persistence.nativeHandle!, null);
    const marker = branch.path.find((entry) => entry.id === imported.origin.inheritedLeafEntryId);
    expect(marker?.type).toBe("label");
    expect(marker?.id).not.toBe("source-final-label");
    expect(imported.origin.targetEntryId).toBe("source-final-label");
    expect(await f.integrity()).toEqual(before);
  } finally {
    await imported.discard();
  }
}, 60_000);

test("a native fork imports the real persisted compaction as a timeline row", async () => {
  const f = await setup("compaction-session.jsonl");
  const before = await f.integrity();
  const client = new PiRpcAgentClient({ logger, runtime: f.runtime });
  const config = {
    provider: "pi",
    cwd: f.root,
    model: process.env.PI_REAL_TEST_MODEL ?? "magpie/group/luna-fast",
  };
  const imported = await client.forkSession(
    {
      source: { provider: "pi", sessionId: f.source.header.id, nativeHandle: f.sourceFile },
      cwd: f.root,
      target: { kind: "latest", leafEntryId: null },
      signal: new AbortController().signal,
    },
    { config, storedConfig: config },
  );
  try {
    const compactions = imported.timeline.filter((entry) => entry.item.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.providerMessageId).toBe("777ba4f8");
    expect(imported.timeline.some((entry) => entry.item.type === "tool_call")).toBe(true);
    const positions = new Map(f.source.path.map((entry, index) => [entry.id, index]));
    const ordering = imported.timeline.map(
      (entry) => positions.get(entry.providerMessageId ?? "") ?? -1,
    );
    expect(ordering.every((index) => index >= 0)).toBe(true);
    expect(ordering).toEqual(ordering.toSorted((left, right) => left - right));
    expect(await f.integrity()).toEqual(before);
  } finally {
    await imported.discard();
  }
}, 60_000);

test("an unavailable source reports recovery guidance before staging or launching a worker", async () => {
  const f = await setup();
  const before = await f.integrity();
  await rename(f.sourceFile, `${f.sourceFile}.held`);
  const startSession = vi.fn(async () => {
    throw new Error("Unexpected worker launch");
  });
  const client = new PiRpcAgentClient({ logger, runtime: { startSession } });
  const config = { provider: "pi", cwd: f.root };
  try {
    await expect(
      client.forkSession(
        {
          source: { provider: "pi", sessionId: f.source.header.id, nativeHandle: f.sourceFile },
          cwd: f.root,
          target: { kind: "latest", leafEntryId: null },
          signal: new AbortController().signal,
        },
        { config, storedConfig: config },
      ),
    ).rejects.toMatchObject({
      code: "boundary_not_found",
      message: expect.stringContaining("Restore the file"),
    });
    expect(startSession).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual(["source.jsonl.held"]);
  } finally {
    await rename(`${f.sourceFile}.held`, f.sourceFile);
  }
  expect(await f.integrity()).toEqual(before);
});
