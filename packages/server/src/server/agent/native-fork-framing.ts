import { z } from "zod";

export const NATIVE_FORK_BOUNDARY_LIMIT = 4096;

export const NativeSessionForkFramingSchema = z.object({
  sourceSessionId: z.string(),
  sourceNativeHandle: z.string(),
  startEntryId: z.string().nullable(),
  observedLeafId: z.string().nullable(),
  valid: z.boolean(),
  boundaries: z
    .array(z.object({ entryId: z.string(), kind: z.enum(["trigger", "unknown"]) }))
    .max(NATIVE_FORK_BOUNDARY_LIMIT),
});

export type NativeSessionForkFraming = z.infer<typeof NativeSessionForkFramingSchema>;

interface NativeForkObservedEntry {
  id: string;
  type: string;
}

export function hasNoUnobservedNativeMessages(
  framing: NativeSessionForkFraming,
  ancestry: readonly NativeForkObservedEntry[],
): boolean {
  const covered =
    framing.observedLeafId === null
      ? -1
      : ancestry.findIndex((entry) => entry.id === framing.observedLeafId);
  if (framing.observedLeafId !== null && covered < 0) return false;
  return !ancestry
    .slice(covered + 1)
    .some((entry) => entry.type === "message" || entry.type === "custom_message");
}
