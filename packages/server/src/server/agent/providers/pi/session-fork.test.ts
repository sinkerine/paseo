import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeSessionForkFramingSchema } from "../../native-fork-framing.js";
import { describe, expect, test } from "vitest";
import { InMemoryAgentTimelineStore } from "../../agent-timeline-store.js";
import { resolveNativeForkTarget } from "../../native-fork-boundary.js";
import { streamPiHistory } from "./history-mapper.js";
import { readPiTranscript } from "./transcript.js";
import {
  readPiSessionPath,
  resolvePiForkTarget,
  rebindPiForkFraming,
  resolvePiSessionForkTransaction,
  resolvePiInheritedForkEntries,
} from "./session-fork.js";

// Unmodified Pi 1.4.0 JSONL captured with the local scripted provider and a real
// sendMessage(triggerTurn:true). It is not a goal-x or pi-subagents capture.
const fixture = fileURLToPath(
  new URL("./fixtures/session-fork/continuation-session.jsonl", import.meta.url),
);

async function replayFixture() {
  const transcript = readPiTranscript(await readFile(fixture, "utf8"));
  const store = new InMemoryAgentTimelineStore();
  store.initialize("fixture");
  for await (const event of streamPiHistory(
    "pi",
    transcript.messages,
    transcript.userEntries,
    {},
    undefined,
    undefined,
    transcript.messageEntryIds,
  )) {
    if (event.type === "timeline")
      store.append("fixture", event.item, { providerMessageId: event.providerMessageId });
  }
  return store.getRows("fixture");
}

describe("Pi native session fork mapping", () => {
  test("rejects an unobserved original run while preserving its exact native ancestry", async () => {
    const rows = await replayFixture();
    const original = rows.find(
      (row) => row.item.type === "assistant_message" && row.item.messageId,
    );
    if (!original) throw new Error("Captured original response missing");
    const target = resolveNativeForkTarget({
      rows,
      boundary: { cursor: { epoch: "fixture", seq: original.seq } },
      leafEntryId: null,
    });
    const source = await readPiSessionPath(fixture, null);
    expect(source.path.map((entry) => entry.id)).toEqual([
      "d579f590",
      "2247587b",
      "6b277a19",
      "bfac6b6b",
      "4ad709af",
      "ec3927ae",
      "c533c58f",
      "28db885e",
      "0a49564e",
    ]);
    expect(() => resolvePiForkTarget(source, target)).toThrowError(
      expect.objectContaining({ code: "boundary_mismatch" }),
    );
  });

  test("maps the real image-only continuation to its own run in replay", async () => {
    const rows = await replayFixture();
    const original = rows.find(
      (row) => row.item.type === "assistant_message" && row.item.messageId,
    );
    const image = rows.findLast(
      (row) => row.item.type === "assistant_message" && !row.item.messageId,
    );
    if (!original || !image) throw new Error("Captured response boundaries missing");
    expect(original.providerMessageId).toBe("4ad709af");
    expect(image.providerMessageId).toBe("28db885e");
    const target = resolveNativeForkTarget({
      rows,
      boundary: { cursor: { epoch: "fixture", seq: image.seq } },
      leafEntryId: null,
    });
    const source = await readPiSessionPath(fixture, null);
    expect(resolvePiForkTarget(source, target)).toEqual({ targetEntryId: "0a49564e" });
    expect(() =>
      resolvePiForkTarget(source, { kind: "turn", entryId: original.providerMessageId! }),
    ).toThrowError(expect.objectContaining({ code: "boundary_mismatch" }));
  });

  test("resolves clone to the persisted leaf or the explicit rewind ancestry", async () => {
    const source = await readPiSessionPath(fixture, null);
    expect(resolvePiForkTarget(source, { kind: "latest", leafEntryId: null })).toEqual({
      targetEntryId: "0a49564e",
    });
    const rewind = await readPiSessionPath(fixture, "4ad709af");
    expect(rewind.path.map((entry) => entry.id)).toEqual(
      source.path.slice(0, 5).map((entry) => entry.id),
    );
    expect(resolvePiForkTarget(rewind, { kind: "latest", leafEntryId: "4ad709af" })).toEqual({
      targetEntryId: "4ad709af",
    });
  });

  test("rejects an unknown native entry on the active ancestry", async () => {
    const source = await readPiSessionPath(fixture, null);
    expect(() => resolvePiForkTarget(source, { kind: "turn", entryId: "missing" })).toThrowError(
      expect.objectContaining({ code: "boundary_not_found" }),
    );
  });

  test("refuses unobserved notifier postlude ownership while mapping the native latest run", async () => {
    const source = await readPiSessionPath(
      fileURLToPath(new URL("./fixtures/session-fork/goal-notify-session.jsonl", import.meta.url)),
      null,
    );
    expect(resolvePiForkTarget(source, { kind: "turn", entryId: "ff8c101e" })).toEqual({
      targetEntryId: "ff8c101e",
    });
    expect(() => resolvePiForkTarget(source, { kind: "turn", entryId: "1e4ba35a" })).toThrowError(
      expect.objectContaining({ code: "boundary_mismatch" }),
    );
  });

  test("reads a live append without mutating bytes and refuses broken ancestry", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-fork-path-"));
    const file = path.join(directory, "session.jsonl");
    const bytes = await readFile(fixture, "utf8");
    try {
      await writeFile(file, bytes + '{"type":"message"');
      expect((await readPiSessionPath(file, null)).path.at(-1)?.id).toBe("0a49564e");
      expect(await readFile(file, "utf8")).toBe(bytes + '{"type":"message"');
      await expect(readPiSessionPath(file, "missing")).rejects.toMatchObject({
        code: "boundary_not_found",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("uses production-persisted provenance for earlier runs despite identical passive messages after the trigger", async () => {
  const file = fileURLToPath(
    new URL("./fixtures/session-fork/observed-framing-session.jsonl", import.meta.url),
  );
  const saved = JSON.parse(
    await readFile(
      new URL("./fixtures/session-fork/observed-framing-persistence.json", import.meta.url),
      "utf8",
    ),
  );
  const framing = NativeSessionForkFramingSchema.parse(saved.metadata.nativeSessionForkFraming);
  const descriptor = await readPiSessionPath(file, null);
  // The fixture is an unchanged copy of the source named by its persisted handle.
  const source = { ...descriptor, file: framing.sourceNativeHandle };
  const transcript = readPiTranscript(await readFile(file, "utf8"));
  const store = new InMemoryAgentTimelineStore();
  store.initialize("fixture");
  for await (const event of streamPiHistory(
    "pi",
    transcript.messages,
    transcript.userEntries,
    {},
    undefined,
    undefined,
    transcript.messageEntryIds,
  ))
    if (event.type === "timeline")
      store.append("fixture", event.item, { providerMessageId: event.providerMessageId });
  const rows = store.getRows("fixture");
  const handle = {
    provider: "pi",
    sessionId: framing.sourceSessionId,
    nativeHandle: framing.sourceNativeHandle,
    metadata: { nativeSessionForkFraming: framing },
  };
  for (const [entryId, expected] of [
    ["60fbe3ff", "9324f41d"],
    ["d4f9ca96", "d4f9ca96"],
    ["bca8feaa", "bca8feaa"],
  ]) {
    const row = rows.find((candidate) => candidate.providerMessageId === entryId);
    if (!row) throw Error("Missing captured native row");
    const target = resolveNativeForkTarget({
      rows,
      boundary: { cursor: { epoch: "fixture", seq: row.seq } },
      leafEntryId: null,
      source: handle,
    });
    expect(resolvePiForkTarget(source, target)).toEqual({ targetEntryId: expected });
  }
  const selected = rows.find((row) => row.providerMessageId === "60fbe3ff")!;
  const input = {
    rows,
    boundary: { cursor: { epoch: "fixture", seq: selected.seq } },
    leafEntryId: null,
    source: handle,
  };
  expect(() =>
    resolveNativeForkTarget({ ...input, source: { ...handle, sessionId: "another-session" } }),
  ).toThrowError(expect.objectContaining({ code: "boundary_mismatch" }));
  const target = resolveNativeForkTarget(input);
  expect(() => resolvePiForkTarget({ ...source, file: "another-file" }, target)).toThrowError(
    expect.objectContaining({ code: "boundary_mismatch" }),
  );
  expect(() =>
    resolvePiForkTarget({ ...source, path: source.path.slice(0, -1) }, target),
  ).toThrowError(expect.objectContaining({ code: "boundary_mismatch" }));
  const rewind = await readPiSessionPath(file, "60fbe3ff");
  const rewindSource = { ...rewind, file: framing.sourceNativeHandle };
  expect(() => resolvePiForkTarget(rewindSource, target)).toThrowError(
    expect.objectContaining({ code: "boundary_mismatch" }),
  );
  expect(resolvePiForkTarget(rewindSource, { kind: "latest", leafEntryId: "60fbe3ff" })).toEqual({
    targetEntryId: "60fbe3ff",
  });
  expect(() =>
    resolvePiForkTarget(source, {
      kind: "turn",
      entryId: "60fbe3ff",
      framing: {
        ...framing,
        boundaries: [...framing.boundaries, { entryId: "off-branch", kind: "trigger" }],
      },
    }),
  ).toThrowError(expect.objectContaining({ code: "boundary_mismatch" }));
  expect(() =>
    resolvePiForkTarget(source, {
      kind: "turn",
      entryId: "60fbe3ff",
      framing: { ...framing, boundaries: [{ entryId: "16177708", kind: "unknown" }] },
    }),
  ).toThrowError(expect.objectContaining({ code: "boundary_mismatch" }));
  expect(() =>
    resolveNativeForkTarget({
      ...input,
      source: { ...handle, metadata: { nativeSessionForkFraming: { ...framing, valid: false } } },
    }),
  ).toThrowError(expect.objectContaining({ code: "boundary_mismatch" }));
});

test("rebinds validated observed framing only to copied branch ancestry, preserving subsequent fork cuts", async () => {
  const saved = JSON.parse(
    await readFile(
      new URL("./fixtures/session-fork/observed-framing-persistence.json", import.meta.url),
      "utf8",
    ),
  );
  const framing = NativeSessionForkFramingSchema.parse(saved.metadata.nativeSessionForkFraming);
  const original = await readPiSessionPath(
    fileURLToPath(
      new URL("./fixtures/session-fork/observed-framing-session.jsonl", import.meta.url),
    ),
    null,
  );
  const source = { ...original, file: framing.sourceNativeHandle };
  const handle = {
    provider: "pi",
    sessionId: source.header.id,
    nativeHandle: source.file,
    metadata: { nativeSessionForkFraming: framing },
  };
  const cut = source.path.findIndex((entry) => entry.id === "d4f9ca96");
  const branch = {
    file: "/isolated/branch.jsonl",
    header: { ...source.header, id: "new-native-id" },
    path: source.path.slice(0, cut + 1),
  };
  const rebound = rebindPiForkFraming(source, handle, branch);
  expect(rebound).toMatchObject({
    sourceSessionId: "new-native-id",
    sourceNativeHandle: branch.file,
    observedLeafId: "d4f9ca96",
    valid: true,
  });
  expect(rebound?.boundaries.some((boundary) => boundary.entryId === "79a44f31")).toBe(false);
  expect(
    resolvePiForkTarget(branch, { kind: "turn", entryId: "60fbe3ff", framing: rebound }),
  ).toEqual({ targetEntryId: "9324f41d" });
  expect(
    rebindPiForkFraming(
      source,
      {
        ...handle,
        metadata: { nativeSessionForkFraming: { ...framing, observedLeafId: "stale" } },
      },
      branch,
    ),
  ).toBeUndefined();
  expect(
    rebindPiForkFraming(
      source,
      {
        ...handle,
        metadata: {
          nativeSessionForkFraming: {
            ...framing,
            boundaries: [...framing.boundaries, framing.boundaries[0]],
          },
        },
      },
      branch,
    ),
  ).toBeUndefined();
  expect(handle.metadata.nativeSessionForkFraming).toEqual(framing);
});

test("running-source transaction resolves only an earlier cut with a proven next trigger inside covered active ancestry", async () => {
  const saved = JSON.parse(
    await readFile(
      new URL("./fixtures/session-fork/observed-framing-persistence.json", import.meta.url),
      "utf8",
    ),
  );
  const framing = NativeSessionForkFramingSchema.parse(saved.metadata.nativeSessionForkFraming);
  const original = await readPiSessionPath(
    fileURLToPath(
      new URL("./fixtures/session-fork/observed-framing-session.jsonl", import.meta.url),
    ),
    null,
  );
  const source = {
    ...original,
    file: framing.sourceNativeHandle,
    path: [
      ...original.path,
      {
        id: "in-flight-tool-assistant",
        parentId: original.path.at(-1)!.id,
        type: "message",
        role: "assistant",
      },
    ],
  };
  const target = { kind: "turn" as const, entryId: "60fbe3ff", framing };
  expect(() => resolvePiForkTarget(source, target)).toThrowError(
    expect.objectContaining({ code: "boundary_mismatch" }),
  );
  expect(() => resolvePiSessionForkTransaction(source, target, false)).toThrowError(
    expect.objectContaining({ code: "boundary_mismatch" }),
  );
  const transaction = resolvePiSessionForkTransaction(source, target, true);
  expect(transaction.targetEntryId).toBe("9324f41d");
  expect(transaction.framingSource.path).toEqual(original.path);
  for (const invalid of [
    { ...target, entryId: "bca8feaa" },
    { ...target, framing: { ...framing, observedLeafId: "off-branch" } },
    { ...target, framing: { ...framing, sourceSessionId: "another-native-session" } },
    { ...target, framing: { ...framing, sourceNativeHandle: "another-file" } },
    {
      ...target,
      framing: {
        ...framing,
        boundaries: framing.boundaries.map((boundary) =>
          boundary.entryId === "16177708"
            ? { entryId: boundary.entryId, kind: "unknown" as const }
            : boundary,
        ),
      },
    },
  ])
    expect(() => resolvePiSessionForkTransaction(source, invalid, true)).toThrowError(
      expect.objectContaining({ code: "boundary_mismatch" }),
    );
  expect(() =>
    resolvePiSessionForkTransaction({ ...source, path: source.path.slice(0, 5) }, target, true),
  ).toThrowError(expect.objectContaining({ code: "boundary_mismatch" }));
});

test("inherited ownership requires a valid destination marker on active ancestry and its native parent header", async () => {
  const original = await readPiSessionPath(fixture, null);
  const source = {
    ...original,
    header: { ...original.header, parentSession: "/original/source.jsonl" },
  };
  const marker = source.path[4]!.id;
  const origin = { sourceNativeHandle: "/original/source.jsonl", inheritedLeafEntryId: marker };
  expect([...resolvePiInheritedForkEntries(source, origin)]).toEqual(
    source.path.slice(0, 5).map((entry) => entry.id),
  );
  for (const corrupt of [
    {},
    { ...origin, inheritedLeafEntryId: "off-branch" },
    { ...origin, sourceNativeHandle: "/unrelated/source.jsonl" },
  ]) {
    expect(() => resolvePiInheritedForkEntries(source, corrupt)).toThrowError(
      expect.objectContaining({ code: "boundary_mismatch" }),
    );
  }
  expect(() =>
    resolvePiInheritedForkEntries({ ...source, path: source.path.slice(0, 3) }, origin),
  ).toThrowError(expect.objectContaining({ code: "boundary_mismatch" }));
});

describe("Pi native session fork provenance with non-message tails", () => {
  const trailingCustomSessionFile = fileURLToPath(
    new URL("./fixtures/session-fork/trailing-custom-framing-session.jsonl", import.meta.url),
  );
  const trailingCustomPersistenceFile = fileURLToPath(
    new URL("./fixtures/session-fork/trailing-custom-framing-persistence.json", import.meta.url),
  );

  async function loadTrailingCustomFixture() {
    const [sessionBytes, savedBytes] = await Promise.all([
      readFile(trailingCustomSessionFile, "utf8"),
      readFile(trailingCustomPersistenceFile, "utf8"),
    ]);
    const saved = JSON.parse(savedBytes);
    const framing = NativeSessionForkFramingSchema.parse(saved.metadata.nativeSessionForkFraming);
    const descriptor = await readPiSessionPath(trailingCustomSessionFile, null);
    const source = { ...descriptor, file: framing.sourceNativeHandle };
    const transcript = readPiTranscript(sessionBytes);
    const store = new InMemoryAgentTimelineStore();
    store.initialize("trailing-custom-fixture");
    for await (const event of streamPiHistory(
      "pi",
      transcript.messages,
      transcript.userEntries,
      {},
      undefined,
      undefined,
      transcript.messageEntryIds,
    )) {
      if (event.type === "timeline") {
        store.append("trailing-custom-fixture", event.item, {
          providerMessageId: event.providerMessageId,
        });
      }
    }
    const rows = store.getRows("trailing-custom-fixture");
    const handle = {
      provider: "pi",
      sessionId: framing.sourceSessionId,
      nativeHandle: framing.sourceNativeHandle,
      metadata: { nativeSessionForkFraming: structuredClone(framing) },
    };
    return { sessionBytes, savedBytes, framing, source, rows, handle };
  }

  test("AC1: resolves earlier and latest turns when non-message entries follow observedLeafId", async () => {
    const { sessionBytes, framing, source, rows, handle } = await loadTrailingCustomFixture();

    const turn1Row = rows.find((row) => row.providerMessageId === "e1000007");
    const turn2Row = rows.find((row) => row.providerMessageId === "e1000013");
    if (!turn1Row || !turn2Row) throw new Error("Missing expected turn rows in fixture");

    const turn1Target = resolveNativeForkTarget({
      rows,
      boundary: { cursor: { epoch: "trailing-custom-fixture", seq: turn1Row.seq } },
      leafEntryId: null,
      source: handle,
    });
    const turn2Target = resolveNativeForkTarget({
      rows,
      boundary: { cursor: { epoch: "trailing-custom-fixture", seq: turn2Row.seq } },
      leafEntryId: null,
      source: handle,
    });

    expect(resolvePiForkTarget(source, turn1Target)).toEqual({ targetEntryId: "e1000010" });
    expect(resolvePiForkTarget(source, turn2Target)).toEqual({ targetEntryId: "e1000015" });
    expect(resolvePiSessionForkTransaction(source, turn1Target, false)).toEqual({
      targetEntryId: "e1000010",
      framingSource: source,
    });
    expect(resolvePiSessionForkTransaction(source, turn2Target, false)).toEqual({
      targetEntryId: "e1000015",
      framingSource: source,
    });

    // Additional non-message tail entry types allowed after observedLeafId.
    const extraNonMessageTypes = [
      "model_change",
      "thinking_level_change",
      "label",
      "session_info",
      "compaction",
    ];
    let parentId = source.path.at(-1)!.id;
    const extendedPath = [...source.path];
    for (const [index, entryType] of extraNonMessageTypes.entries()) {
      const id = `tail-nonmsg-${index}`;
      extendedPath.push({ id, parentId, type: entryType });
      parentId = id;
    }
    const extendedSource = { ...source, path: extendedPath };
    expect(resolvePiForkTarget(extendedSource, turn1Target)).toEqual({ targetEntryId: "e1000010" });
    expect(resolvePiForkTarget(extendedSource, turn2Target)).toEqual({ targetEntryId: parentId });

    // AC5: source immutability
    expect(handle.metadata.nativeSessionForkFraming).toEqual(framing);
    expect(await readFile(trailingCustomSessionFile, "utf8")).toBe(sessionBytes);
  });

  test("AC2: rebinds provenance on trailing non-message source and supports second-generation forks", async () => {
    const { framing, source, handle } = await loadTrailingCustomFixture();

    const earlierCut = source.path.findIndex((entry) => entry.id === "e1000010");
    const earlierBranch = {
      file: "/isolated/branch-earlier.jsonl",
      header: { ...source.header, id: "branch-earlier-id" },
      path: source.path.slice(0, earlierCut + 1),
    };
    const reboundEarlier = rebindPiForkFraming(source, handle, earlierBranch);
    expect(reboundEarlier).toMatchObject({
      sourceSessionId: "branch-earlier-id",
      sourceNativeHandle: earlierBranch.file,
      observedLeafId: "e1000010",
      valid: true,
    });
    expect(reboundEarlier?.boundaries.map((b) => b.entryId)).toEqual([
      "e1000004",
      "e1000005",
      "e1000006",
    ]);
    expect(
      resolvePiForkTarget(earlierBranch, {
        kind: "turn",
        entryId: "e1000007",
        framing: reboundEarlier,
      }),
    ).toEqual({ targetEntryId: "e1000010" });

    const cloneBranch = {
      file: "/isolated/branch-clone.jsonl",
      header: { ...source.header, id: "branch-clone-id" },
      path: [...source.path],
    };
    const reboundClone = rebindPiForkFraming(source, handle, cloneBranch);
    expect(reboundClone).toMatchObject({
      sourceSessionId: "branch-clone-id",
      sourceNativeHandle: cloneBranch.file,
      observedLeafId: "e1000015",
      valid: true,
    });
    expect(reboundClone?.boundaries).toEqual(framing.boundaries);
    expect(
      resolvePiForkTarget(cloneBranch, {
        kind: "turn",
        entryId: "e1000007",
        framing: reboundClone,
      }),
    ).toEqual({ targetEntryId: "e1000010" });
    expect(
      resolvePiForkTarget(cloneBranch, {
        kind: "turn",
        entryId: "e1000013",
        framing: reboundClone,
      }),
    ).toEqual({ targetEntryId: "e1000015" });
    expect(handle.metadata.nativeSessionForkFraming).toEqual(framing);
  });

  test("AC3: running-source transaction handles non-message tails and in-flight message prefixes", async () => {
    const { framing, source } = await loadTrailingCustomFixture();
    const earlierTarget = { kind: "turn" as const, entryId: "e1000007", framing };
    const latestTarget = { kind: "turn" as const, entryId: "e1000013", framing };

    // (a) Only non-message entries follow observedLeafId while running: uses full framingSource.
    const txEarlier = resolvePiSessionForkTransaction(source, earlierTarget, true);
    expect(txEarlier.targetEntryId).toBe("e1000010");
    expect(txEarlier.framingSource).toBe(source);

    const txLatest = resolvePiSessionForkTransaction(source, latestTarget, true);
    expect(txLatest.targetEntryId).toBe("e1000015");
    expect(txLatest.framingSource).toBe(source);

    // (b) In-flight message or custom_message after non-message tail: uses covered prefix up to observedLeafId.
    const coveredIndex = source.path.findIndex((entry) => entry.id === framing.observedLeafId);
    const coveredPrefix = source.path.slice(0, coveredIndex + 1);
    for (const trailingEntry of [
      { id: "in-flight-msg", parentId: source.path.at(-1)!.id, type: "message", role: "assistant" },
      { id: "in-flight-custom-msg", parentId: source.path.at(-1)!.id, type: "custom_message" },
    ]) {
      const runningSource = { ...source, path: [...source.path, trailingEntry] };
      const txPrefix = resolvePiSessionForkTransaction(runningSource, earlierTarget, true);
      expect(txPrefix.targetEntryId).toBe("e1000010");
      expect(txPrefix.framingSource.path).toEqual(coveredPrefix);
      // selected === covered
      expect(() => resolvePiSessionForkTransaction(runningSource, latestTarget, true)).toThrowError(
        expect.objectContaining({ code: "boundary_mismatch" }),
      );
      // selected > covered
      expect(() =>
        resolvePiSessionForkTransaction(
          runningSource,
          { kind: "turn", entryId: trailingEntry.id, framing },
          true,
        ),
      ).toThrowError(expect.objectContaining({ code: "boundary_mismatch" }));
    }
  });

  test("AC4: preserves fail-closed rejection for unobserved messages and invalid coverage", async () => {
    const { framing, source, handle } = await loadTrailingCustomFixture();
    const target = { kind: "turn" as const, entryId: "e1000007", framing };

    // Unobserved message (user, assistant, toolResult) or custom_message after observedLeafId when idle.
    for (const trailing of [
      { id: "unobserved-user", parentId: source.path.at(-1)!.id, type: "message", role: "user" },
      {
        id: "unobserved-assistant",
        parentId: source.path.at(-1)!.id,
        type: "message",
        role: "assistant",
      },
      {
        id: "unobserved-tool",
        parentId: source.path.at(-1)!.id,
        type: "message",
        role: "toolResult",
      },
      { id: "unobserved-custom-msg", parentId: source.path.at(-1)!.id, type: "custom_message" },
    ]) {
      const badSource = { ...source, path: [...source.path, trailing] };
      expect(() => resolvePiForkTarget(badSource, target)).toThrowError(
        expect.objectContaining({ code: "boundary_mismatch" }),
      );
      expect(() => resolvePiSessionForkTransaction(badSource, target, false)).toThrowError(
        expect.objectContaining({ code: "boundary_mismatch" }),
      );
      expect(
        rebindPiForkFraming(badSource, handle, {
          file: "/isolated/branch.jsonl",
          header: { ...source.header, id: "branch-id" },
          path: badSource.path,
        }),
      ).toBeUndefined();
    }

    // observedLeafId missing from active ancestry (truncated or off-branch).
    const truncated = { ...source, path: source.path.slice(0, 8) };
    expect(() => resolvePiForkTarget(truncated, target)).toThrowError(
      expect.objectContaining({ code: "boundary_mismatch" }),
    );
    expect(
      rebindPiForkFraming(
        source,
        {
          ...handle,
          metadata: { nativeSessionForkFraming: { ...framing, observedLeafId: "off-branch" } },
        },
        source,
      ),
    ).toBeUndefined();

    // selected <= start
    expect(() =>
      resolvePiForkTarget(source, { kind: "turn", entryId: "e1000002", framing }),
    ).toThrowError(expect.objectContaining({ code: "boundary_mismatch" }));

    // Discriminating selected > covered: selected entry is a non-message entry after observedLeafId
    // with no unobserved messages anywhere in the suffix.
    expect(() =>
      resolvePiForkTarget(source, { kind: "turn", entryId: "e1000014", framing }),
    ).toThrowError(expect.objectContaining({ code: "boundary_mismatch" }));

    // Discriminating observedLeafId: null with only a non-message suffix (no unobserved messages).
    const nonMessageOnlySource = {
      ...source,
      path: [
        { id: "nm-1", parentId: null, type: "model_change" },
        { id: "nm-2", parentId: "nm-1", type: "thinking_level_change" },
        { id: "nm-3", parentId: "nm-2", type: "custom" },
      ],
    };
    expect(() =>
      resolvePiForkTarget(nonMessageOnlySource, {
        kind: "turn",
        entryId: "nm-2",
        framing: {
          ...framing,
          startEntryId: null,
          observedLeafId: null,
          boundaries: [],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "boundary_mismatch" }));

    // Discriminating rebind start > covered: startEntryId sits on the non-message tail after observedLeafId
    // with no unobserved messages and valid empty boundaries.
    expect(
      rebindPiForkFraming(
        source,
        {
          ...handle,
          metadata: {
            nativeSessionForkFraming: {
              ...framing,
              startEntryId: "e1000014",
              observedLeafId: "e1000013",
              boundaries: [],
            },
          },
        },
        source,
      ),
    ).toBeUndefined();
  });
});
