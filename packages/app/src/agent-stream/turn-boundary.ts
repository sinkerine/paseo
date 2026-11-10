import type { StreamItem, TimelinePosition } from "@/types/stream";

export type AssistantTurnForkBoundary =
  | { boundaryCursor: TimelinePosition; boundaryMessageId?: string }
  | { boundaryCursor?: undefined; boundaryMessageId: string };

export function resolveAssistantTurnForkBoundary(input: {
  items: readonly StreamItem[];
  startIndex: number;
  supportsTimelineCursor: boolean;
}): AssistantTurnForkBoundary | undefined {
  const projected = input.items[input.startIndex];
  const item = projected?.kind === "plugin" ? projected.sourceAssistant : projected;
  if (item?.kind !== "assistant_message" && item?.kind !== "tool_call") {
    return undefined;
  }
  const messageId = item.kind === "assistant_message" ? item.messageId : undefined;
  if (input.supportsTimelineCursor && item.timelineCursor) {
    return {
      boundaryCursor: item.timelineCursor,
      ...(messageId ? { boundaryMessageId: messageId } : {}),
    };
  }
  return messageId ? { boundaryMessageId: messageId } : undefined;
}
