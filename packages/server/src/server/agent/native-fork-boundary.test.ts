import { NATIVE_FORK_BOUNDARY_LIMIT } from "./native-fork-framing.js";
import { describe, expect, test } from "vitest";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { resolveNativeForkTarget } from "./native-fork-boundary.js";

const rows: AgentTimelineRow[] = [
  {
    seq: 1,
    timestamp: "",
    providerMessageId: "native-user",
    item: { type: "user_message", messageId: "client-user", text: "Prompt" },
  },
  {
    seq: 2,
    timestamp: "",
    providerMessageId: "native-assistant",
    item: { type: "assistant_message", messageId: "live-response", text: "Response" },
  },
  {
    seq: 5,
    timestamp: "",
    providerMessageId: "native-image-result",
    item: { type: "assistant_message", text: "![Image](file:///image.png)" },
  },
];

describe("resolveNativeForkTarget", () => {
  test("uses the selected native entry rather than the preceding user or response", () => {
    expect(
      resolveNativeForkTarget({
        rows,
        boundary: { cursor: { epoch: "epoch", seq: 5 } },
        leafEntryId: null,
      }),
    ).toEqual({ kind: "turn", entryId: "native-image-result" });
    expect(
      resolveNativeForkTarget({
        rows,
        boundary: { messageId: "live-response" },
        leafEntryId: null,
      }),
    ).toEqual({ kind: "turn", entryId: "native-assistant" });
  });
  test("does not use a response id as a native entry id when identity is missing", () => {
    const unknown = rows.map((row) => ({ ...row, providerMessageId: undefined }));
    expect(() =>
      resolveNativeForkTarget({
        rows: unknown,
        boundary: { cursor: { epoch: "epoch", seq: 5 } },
        leafEntryId: null,
      }),
    ).toThrowError(expect.objectContaining({ code: "boundary_not_found" }));
  });
  test("keeps cursor selection authoritative", () => {
    expect(() =>
      resolveNativeForkTarget({
        rows,
        boundary: { cursor: { epoch: "epoch", seq: 100 }, messageId: "live-response" },
        leafEntryId: null,
      }),
    ).toThrowError(expect.objectContaining({ code: "boundary_not_found" }));
  });
  test("preserves clone and the explicit rewind leaf", () => {
    expect(resolveNativeForkTarget({ rows, boundary: null, leafEntryId: "rewound" })).toEqual({
      kind: "latest",
      leafEntryId: "rewound",
    });
  });
  test("rejects an absent selector", () => {
    expect(() => resolveNativeForkTarget({ rows, boundary: {}, leafEntryId: null })).toThrowError(
      expect.objectContaining({ code: "boundary_not_found" }),
    );
  });
});

test("refuses malformed, incomplete or over-limit persisted provenance without a fallback", () => {
  const base = { rows, boundary: { messageId: "live-response" }, leafEntryId: null };
  const framing = {
    sourceSessionId: "source",
    sourceNativeHandle: "/native",
    startEntryId: null,
    observedLeafId: "leaf",
    valid: true,
    boundaries: [],
  };
  const source = {
    provider: "pi",
    sessionId: "source",
    nativeHandle: "/native",
    metadata: { nativeSessionForkFraming: framing },
  };
  for (const invalid of [
    { ...framing, valid: false },
    { ...framing, boundaries: "bad" },
    {
      ...framing,
      boundaries: Array.from({ length: NATIVE_FORK_BOUNDARY_LIMIT + 1 }, () => ({
        entryId: "id",
        kind: "trigger",
      })),
    },
  ]) {
    expect(() =>
      resolveNativeForkTarget({
        ...base,
        source: { ...source, metadata: { nativeSessionForkFraming: invalid } },
      }),
    ).toThrowError(expect.objectContaining({ code: "boundary_mismatch" }));
  }
});
