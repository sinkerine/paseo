import {
  NativeSessionForkError,
  type NativeSessionForkTarget,
  type AgentPersistenceHandle,
} from "./agent-sdk-types.js";
import type { AgentTimelineCursor, AgentTimelineRow } from "./agent-timeline-store-types.js";
import { NativeSessionForkFramingSchema } from "./native-fork-framing.js";

interface NativeForkBoundaryInput {
  rows: readonly AgentTimelineRow[];
  boundary: { cursor?: AgentTimelineCursor; messageId?: string } | null;
  leafEntryId: string | null;
  source?: AgentPersistenceHandle;
}

export function resolveNativeForkTarget(input: NativeForkBoundaryInput): NativeSessionForkTarget {
  const { rows, boundary, leafEntryId, source } = input;
  if (boundary === null) return { kind: "latest", leafEntryId };
  const cursor = boundary.cursor;
  const row = cursor
    ? rows.find((entry) => entry.seq === cursor.seq)
    : rows.findLast(
        (entry) => "messageId" in entry.item && entry.item.messageId === boundary.messageId,
      );
  if (!row || (!cursor && !boundary.messageId) || !row.providerMessageId) {
    throw new NativeSessionForkError(
      "boundary_not_found",
      "The selected response has no proven native entry identity.",
    );
  }
  const raw = source?.metadata?.nativeSessionForkFraming;
  if (raw === undefined) return { kind: "turn", entryId: row.providerMessageId };
  const parsed = NativeSessionForkFramingSchema.safeParse(raw);
  if (
    !parsed.success ||
    !parsed.data.valid ||
    parsed.data.sourceSessionId !== source?.sessionId ||
    parsed.data.sourceNativeHandle !== source?.nativeHandle
  ) {
    throw new NativeSessionForkError(
      "boundary_mismatch",
      "The stored native run provenance does not match the source session.",
    );
  }
  return { kind: "turn", entryId: row.providerMessageId, framing: parsed.data };
}
