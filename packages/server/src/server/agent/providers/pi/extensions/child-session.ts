import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { limitAgentTimelineItemContent } from "../../../agent-timeline-content.js";
import type { ProviderSubagentInputEvent } from "../../../provider-subagents/store.js";
import { PiHistoryMapper } from "../history-mapper.js";
import type { PiAgentMessage } from "../rpc-types.js";
import { extractTextFromToolResult, type PiToolResult } from "../tool-call-mapper.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 200;
// Contract v1's generated first-question prefix. Strip once, only for an identified pi-btw file.
const BTW_FIRST_QUESTION_PREFIX =
  "<btw>You are a read-only side conversation. The inherited conversation is context, not a task to continue. Answer the question below. Only unchanged Pi read, grep, find and ls tools execute; other tools return errors. Nothing is sent to the main agent unless the user explicitly requests it.</btw>\n\n";

export function outputFileFromToolResult(result: PiToolResult): string | undefined {
  return extractTextFromToolResult(result)?.match(/^Output file:\s*(\S+)$/m)?.[1];
}

/** Reads a finished child transcript once, up to `maxBytes`. */
export function mapPiChildSession(
  id: string,
  file: string,
  maxBytes = MAX_BYTES,
  projection?: "pi-btw",
): Promise<ProviderSubagentInputEvent[]> {
  return new PiChildSessionFollower(id, file, maxBytes, undefined, undefined, projection).readNew();
}

async function mapChildLine(
  mapper: PiHistoryMapper,
  id: string,
  line: string,
  projectMessage: (message: PiAgentMessage) => PiAgentMessage,
): Promise<ProviderSubagentInputEvent[]> {
  let entry: { message?: PiAgentMessage; timestamp?: string };
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  if (!entry.message || typeof entry.message !== "object" || !("role" in entry.message)) return [];
  return (await mapper.mapMessages([projectMessage(entry.message)])).flatMap((mapped) =>
    mapped.type === "timeline"
      ? [
          {
            type: "timeline" as const,
            id,
            item: limitAgentTimelineItemContent(mapped.item),
            ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
          },
        ]
      : [],
  );
}

/** Incrementally reads one append-only child transcript. A partial JSONL row is held until newline. */
export class PiChildSessionFollower {
  private offset = 0;
  private pending = Buffer.alloc(0);
  private skippingOversizedLine = false;
  private readonly mapper = new PiHistoryMapper("pi");
  private items = 0;
  private readonly maxBytes: number;
  private queued: ProviderSubagentInputEvent[] = [];
  private sawUserMessage = false;
  hasMore = false;

  constructor(
    private readonly id: string,
    private readonly file: string,
    maxBytes = MAX_BYTES,
    private readonly lifetime?: "conversation",
    private readonly endOffset = Number.POSITIVE_INFINITY,
    private readonly projection?: "pi-btw",
  ) {
    this.maxBytes = Math.min(maxBytes, MAX_BYTES);
  }

  private projectMessage = (message: PiAgentMessage): PiAgentMessage => {
    if (message.role !== "user") return message;
    const first = !this.sawUserMessage;
    this.sawUserMessage = true;
    if (this.projection !== "pi-btw" || !first) return message;
    const content = message.content;
    if (typeof content === "string") {
      return content.startsWith(BTW_FIRST_QUESTION_PREFIX)
        ? { ...message, content: content.slice(BTW_FIRST_QUESTION_PREFIX.length) }
        : message;
    }
    const leading = content[0];
    if (leading?.type !== "text" || !leading.text.startsWith(BTW_FIRST_QUESTION_PREFIX)) {
      return message;
    }
    return {
      ...message,
      content: [
        { ...leading, text: leading.text.slice(BTW_FIRST_QUESTION_PREFIX.length) },
        ...content.slice(1),
      ],
    };
  };

  async readNew(): Promise<ProviderSubagentInputEvent[]> {
    const conversation = this.lifetime === "conversation";
    if (!conversation && (this.offset >= this.maxBytes || this.items >= MAX_ITEMS)) return [];
    try {
      const handle = await open(this.file, "r");
      try {
        const available = Math.min((await handle.stat()).size, this.endOffset) - this.offset;
        const budget = conversation ? this.maxBytes : this.maxBytes - this.offset;
        const size =
          this.pending.includes(10) || this.queued.length > 0
            ? 0
            : Math.max(0, Math.min(available, budget));
        if (size > 0) {
          const buffer = Buffer.alloc(size);
          const { bytesRead } = await handle.read(buffer, 0, size, this.offset);
          this.offset += bytesRead;
          this.pending = Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]);
        }
        if (this.skippingOversizedLine) {
          const newline = this.pending.indexOf(10);
          if (newline < 0) this.pending = Buffer.alloc(0);
          else {
            this.pending = this.pending.subarray(newline + 1);
            this.skippingOversizedLine = false;
          }
        }
        if (this.pending.length > MAX_BYTES && !this.pending.includes(10)) {
          this.pending = Buffer.alloc(0);
          this.skippingOversizedLine = true;
        }
        const limit = conversation ? MAX_ITEMS : MAX_ITEMS - this.items;
        const events = this.queued.splice(0, limit);
        while (events.length < limit) {
          const newline = this.pending.indexOf(10);
          if (newline < 0) break;
          const lineOffset = this.offset - this.pending.length;
          const bytes = this.pending.subarray(0, newline);
          this.pending = this.pending.subarray(newline + 1);
          if (bytes.length > MAX_BYTES) continue;
          const line = bytes.toString("utf8");
          let mapped = await mapChildLine(this.mapper, this.id, line, this.projectMessage);
          if (conversation) {
            // Live reads and independent history reads must identify the same physical row.
            const digest = createHash("sha256").update(bytes).digest("hex");
            mapped = mapped.map((event, index) => ({
              ...event,
              sourceKey: JSON.stringify([this.file, lineOffset, digest, index]),
            }));
          }
          const remaining = limit - events.length;
          events.push(...mapped.slice(0, remaining));
          this.queued.push(...mapped.slice(remaining));
        }
        this.hasMore = available > size || this.pending.includes(10) || this.queued.length > 0;
        this.items += events.length;
        return events;
      } finally {
        await handle.close();
      }
    } catch {
      this.hasMore = false;
      return [];
    }
  }
}
