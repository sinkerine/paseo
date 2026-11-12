import path from "node:path";
import { z } from "zod";
import type { PiExtension, PiExtensionCustomMapping } from "../contract.js";

export const PI_BTW_MARKER = "PASEO_PI_BTW";
export const piBtwRuntimeBridge = `
  let btwContext;
  pi.events.on("pi-btw:thread", (event) => {
    if (!btwContext) return;
    const parentSessionId = btwContext.sessionManager.getSessionId();
    const owner = event.type === "state" ? event.thread?.parentSessionId : event.parentSessionId;
    if (owner !== parentSessionId) return;
    btwContext.ui.notify("${PI_BTW_MARKER} " + JSON.stringify({ parentSessionId, event }), "info");
  });
  pi.on("session_start", (_event, ctx) => {
    btwContext = ctx;
    pi.events.emit("pi-btw:sync", {});
  });
  pi.registerCommand("paseo_btw_sync", {
    description: "Synchronize Paseo BTW state",
    handler: async (_args, ctx) => {
      btwContext = ctx;
      pi.events.emit("pi-btw:sync", {});
    },
  });
  pi.on("session_shutdown", () => { btwContext = undefined; });
`;

const BoundarySchema = z.object({
  kind: z.enum(["turn_end", "none"]),
  parentLeafEntryId: z.string().nullable(),
  parentTurnIndex: z.number().int().nonnegative().nullable(),
  messageCount: z.number().int().nonnegative(),
  prefixDigest: z.string().regex(/^[a-f0-9]{64}$/),
  pinnedAt: z.string().datetime(),
});
const CacheSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
  api: z.string(),
  thinkingLevel: z.string(),
  requestSessionId: z.string(),
  sharesParentPrefix: z.boolean(),
  reason: z.enum(["model_override", "tangent", "unverified_serialization"]).nullable(),
});
const ThreadSchema = z.object({
  version: z.literal(1),
  parentSessionId: z.string().min(1),
  threadId: z.string().min(1),
  mode: z.enum(["contextual", "tangent"]),
  status: z.enum(["idle", "running", "failed", "aborted"]),
  title: z.string().max(80),
  sessionFile: z.string().nullable(),
  resumable: z.boolean(),
  revision: z.number().int().nonnegative(),
  boundary: BoundarySchema,
  parentAhead: z.number().int().nonnegative(),
  cache: CacheSchema,
  lastUsage: z
    .object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cacheRead: z.number().nonnegative(),
      cacheWrite: z.number().nonnegative(),
      at: z.string().datetime(),
    })
    .nullable(),
  error: z.string().nullable(),
  updatedAt: z.string().datetime(),
});
const EnvelopeSchema = z.object({
  parentSessionId: z.string().min(1),
  event: z.discriminatedUnion("type", [
    z.object({ type: z.literal("state"), thread: ThreadSchema }),
    z.object({
      type: z.literal("closed"),
      version: z.literal(1),
      parentSessionId: z.string(),
      threadId: z.string(),
      reason: z.enum(["cleared", "replaced"]),
    }),
  ]),
});
const STATUS = {
  running: "running",
  idle: "completed",
  failed: "failed",
  aborted: "canceled",
} as const;

function subtitle(thread: z.infer<typeof ThreadSchema>): string {
  const parts = ["Read-only"];
  const turn = thread.boundary.parentTurnIndex;
  if (turn !== null) {
    parts.push(`pinned turn ${turn}`);
    if (thread.parentAhead > 0) parts.push(`next turn ${turn + thread.parentAhead}`);
  }
  const usage = thread.lastUsage;
  if (usage) {
    const total = usage.input + usage.cacheRead + usage.cacheWrite;
    if (total > 0) parts.push(`cache ${Math.round((100 * usage.cacheRead) / total)}%`);
  }
  return parts.join(" · ");
}

function validateSessionFile(thread: z.infer<typeof ThreadSchema>): void {
  const file = thread.sessionFile;
  const parentSessionId = thread.parentSessionId;
  if (file) {
    const segments = path.normalize(file).split(path.sep);
    const suffix = segments.slice(-5, -1);
    if (
      !path.isAbsolute(file) ||
      !file.endsWith(".jsonl") ||
      suffix.join("/") !== `btw/sessions/${parentSessionId}/${thread.threadId}`
    ) {
      throw new Error("Invalid pi-btw child session file");
    }
  }
}

interface CommandFailure {
  message: string;
  timestamp: string;
}
function threadMapping(
  thread: z.infer<typeof ThreadSchema>,
  failure: CommandFailure | null,
): PiExtensionCustomMapping {
  const file = thread.sessionFile;
  return {
    subagents: [
      {
        type: "upsert",
        id: `btw:${thread.threadId}`,
        title: thread.title,
        description: failure ? failure.message : thread.error,
        status: failure ? "failed" : STATUS[thread.status],
        hasTimeline: file !== null,
        subtitle: subtitle(thread),
        presentation: "side_conversation",
        timestamp: failure ? failure.timestamp : thread.updatedAt,
      },
    ],
    childSessions: file
      ? [{ id: `btw:${thread.threadId}`, file, lifetime: "conversation", projection: "pi-btw" }]
      : [],
  };
}

export const piBtw: PiExtension = {
  id: "pi-btw",
  runtimeBridge: piBtwRuntimeBridge,
  outOfBandCommands: [
    "btw",
    "side",
    "btw:new",
    "btw:tangent",
    "btw:abort",
    "btw:inject",
    "btw:summarize",
    "btw:clear",
    "btw:model",
    "btw:thinking",
    "btw:status",
  ],
  createSession() {
    let owner: string | undefined;
    let active: string | undefined;
    let latest: z.infer<typeof ThreadSchema> | undefined;
    let commandFailure: CommandFailure | null = null;
    let activeTarget: { threadId: string } | undefined;
    const revisions = new Map<string, number>();
    const files = new Map<string, string | null>();
    const closed = new Set<string>();
    return {
      replay: () => (latest ? threadMapping(latest, commandFailure) : undefined),
      beginOutOfBandCommand() {
        const target = activeTarget;
        if (!target) return undefined;
        return {
          complete() {
            if (activeTarget !== target || !commandFailure || !latest) return undefined;
            commandFailure = null;
            return threadMapping(latest, null);
          },
          fail(error) {
            if (activeTarget !== target) return undefined;
            commandFailure = { message: error.message, timestamp: new Date().toISOString() };
            return {
              subagents: [
                {
                  type: "upsert",
                  id: `btw:${target.threadId}`,
                  status: "failed",
                  description: error.message,
                  timestamp: commandFailure.timestamp,
                },
              ],
            };
          },
        };
      },
      mapRuntimeNotification(message) {
        if (!message.startsWith(`${PI_BTW_MARKER} `)) return undefined;
        // The host catches this once and logs a bounded warning, without echoing payload content.
        let input: unknown;
        try {
          input = JSON.parse(message.slice(PI_BTW_MARKER.length + 1));
        } catch {
          throw new Error("Malformed pi-btw notification");
        }
        const parsed = EnvelopeSchema.safeParse(input);
        if (!parsed.success) throw new Error("Unsupported pi-btw notification");
        const { parentSessionId, event } = parsed.data;
        const eventOwner =
          event.type === "state" ? event.thread.parentSessionId : event.parentSessionId;
        if (eventOwner !== parentSessionId || (owner && owner !== parentSessionId)) {
          throw new Error("pi-btw session ownership mismatch");
        }
        owner = parentSessionId;
        if (event.type === "closed") {
          closed.add(event.threadId);
          if (active === event.threadId) {
            active = undefined;
            activeTarget = undefined;
            latest = undefined;
            commandFailure = null;
          }
          return { subagents: [{ type: "remove", id: `btw:${event.threadId}` }] };
        }
        const thread = event.thread;
        if (
          closed.has(thread.threadId) ||
          thread.revision <= (revisions.get(thread.threadId) ?? -1)
        ) {
          return { subagents: [] };
        }
        const file = thread.sessionFile;
        validateSessionFile(thread);
        if (files.has(thread.threadId) && files.get(thread.threadId) !== file) {
          throw new Error("pi-btw child session identity changed");
        }
        revisions.set(thread.threadId, thread.revision);
        files.set(thread.threadId, file);
        const mapping = threadMapping(thread, null);
        if (active && active !== thread.threadId) {
          closed.add(active);
          mapping.subagents.unshift({ type: "remove", id: `btw:${active}` });
        }
        if (active !== thread.threadId) activeTarget = { threadId: thread.threadId };
        active = thread.threadId;
        latest = thread;
        commandFailure = null;
        return mapping;
      },
    };
  },
};
