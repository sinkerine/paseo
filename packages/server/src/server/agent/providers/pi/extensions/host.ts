import { stat } from "node:fs/promises";
import type { Logger } from "pino";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentStreamEvent,
} from "../../../agent-sdk-types.js";
import type { PiAgentMessage } from "../rpc-types.js";
import { mapPiChildSession, PiChildSessionFollower } from "./child-session.js";
import type {
  PiExtension,
  PiChildSessionFile,
  PiExtensionCustomMapping,
  PiExtensionDialog,
  PiExtensionDialogMapping,
  PiExtensionSession,
  PiExtensionToolCall,
  PiExtensionToolMapping,
  PiExtensionUiReply,
} from "./contract.js";

export type PiExtensionOutput<T> = T & {
  events: AgentStreamEvent[];
  hydration: Promise<AgentStreamEvent[]>;
};
export type PiExtensionEventOutput = PiExtensionOutput<
  PiExtensionToolMapping | PiExtensionCustomMapping
>;

interface PiExtensionOutOfBandCommandOutput {
  complete(): PiExtensionEventOutput | undefined;
  fail(error: Error): PiExtensionEventOutput | undefined;
}

interface Session {
  id: string;
  adapter: PiExtensionSession;
  outOfBandCommands: readonly string[];
}

interface Follower {
  reader: PiChildSessionFollower;
  file: string;
  lifetime?: "conversation";
  /** Reads run in order so a final read cannot overtake a tick. */
  pending: Promise<void>;
}

export class PiExtensionHost {
  private readonly sessions: Session[] = [];
  private remainingHydrationBytes: number;
  private readonly followers = new Map<string, Follower>();
  private readonly parked = new Map<string, Follower>();
  private onFollowEvent?: (event: AgentStreamEvent) => void;
  private followTimer?: ReturnType<typeof setInterval>;
  private pollingExtensions = false;
  private closed = false;
  private readonly warnedNotifications = new Set<string>();

  constructor(
    extensions: readonly PiExtension[],
    private readonly logger?: Pick<Logger, "warn">,
    hydrationByteBudget = Number.POSITIVE_INFINITY,
    private readonly readChildSession: typeof mapPiChildSession = mapPiChildSession,
  ) {
    this.remainingHydrationBytes = hydrationByteBudget;
    for (const extension of extensions) {
      const adapter = this.safe(extension.id, "createSession", () => extension.createSession());
      if (adapter)
        this.sessions.push({
          id: extension.id,
          adapter,
          outOfBandCommands: extension.outOfBandCommands ?? [],
        });
    }
  }

  /** Live sessions follow child files and adapter polls; replay hosts read each file once. */
  follow(onEvent: (event: AgentStreamEvent) => void): void {
    this.onFollowEvent = onEvent;
    this.followTimer ??= setInterval(() => {
      for (const [id, follower] of this.followers) void this.readFollower(id, follower);
      void this.pollExtensions();
    }, 250);
  }

  close(): void {
    this.closed = true;
    if (this.followTimer) clearInterval(this.followTimer);
    this.followTimer = undefined;
    this.onFollowEvent = undefined;
    this.followers.clear();
    this.parked.clear();
  }

  private readFollower(id: string, follower: Follower, drain = false): Promise<void> {
    follower.pending = follower.pending
      .then(async () => {
        let reading = true;
        do {
          const events = await follower.reader.readNew();
          if (this.followers.get(id) !== follower && this.parked.get(id) !== follower) return;
          for (const event of events) {
            this.onFollowEvent?.({ type: "provider_subagent", provider: "pi", event });
          }
          reading = drain && follower.reader.hasMore;
        } while (reading);
        return undefined;
      })
      .catch((error) => {
        this.logger?.warn(
          { err: error, operation: "follow", childId: id },
          "Pi child follow failed",
        );
      });
    return follower.pending;
  }

  private async pollExtensions(): Promise<void> {
    if (this.pollingExtensions || !this.onFollowEvent) return;
    this.pollingExtensions = true;
    try {
      for (const { id, adapter } of this.sessions) {
        const mapping = this.safe(id, "poll", () => adapter.poll?.());
        if (!mapping) continue;
        const output = this.prepare(id, mapping);
        for (const event of output.events) this.onFollowEvent?.(event);
        for (const event of await output.hydration) this.onFollowEvent?.(event);
      }
    } finally {
      this.pollingExtensions = false;
    }
  }

  private safe<T>(id: string, operation: string, call: () => T): T | undefined {
    try {
      return call();
    } catch (error) {
      if (operation !== "mapRuntimeNotification" || !this.warnedNotifications.has(id)) {
        this.logger?.warn(
          { err: error, extensionId: id, operation },
          "Pi extension adapter failed",
        );
        if (operation === "mapRuntimeNotification") this.warnedNotifications.add(id);
      }
      return undefined;
    }
  }

  beginOutOfBandCommand(commandName: string): PiExtensionOutOfBandCommandOutput | undefined {
    if (this.closed) return undefined;
    for (const { id, adapter, outOfBandCommands } of this.sessions) {
      if (!outOfBandCommands.includes(commandName)) continue;
      const command = this.safe(id, "beginOutOfBandCommand", () =>
        adapter.beginOutOfBandCommand?.(commandName),
      );
      if (!command) return undefined;
      return {
        complete: () => {
          if (this.closed) return undefined;
          const mapping = this.safe(id, "commandCompletion", () => command.complete?.());
          return mapping ? this.safe(id, "prepare", () => this.prepare(id, mapping)) : undefined;
        },
        fail: (error) => {
          if (this.closed) return undefined;
          const mapping = this.safe(id, "commandFailure", () => command.fail(error));
          return mapping ? this.safe(id, "prepare", () => this.prepare(id, mapping)) : undefined;
        },
      };
    }
    return undefined;
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    if (this.closed) return;
    for (const { id, adapter } of this.sessions) {
      const mapping = this.safe(id, "replay", () => adapter.replay?.());
      if (!mapping) continue;
      for (const event of mapping.subagents) {
        if (this.closed) return;
        yield { type: "provider_subagent", provider: "pi", event };
      }
      for (const child of mapping.childSessions ?? []) {
        if (this.closed) return;
        if (child.lifetime !== "conversation") {
          yield* await this.readChildren({ subagents: [], childSessions: [child] });
          continue;
        }
        yield* this.readConversationHistory(child);
      }
    }
  }

  private async *readConversationHistory(
    child: PiChildSessionFile,
  ): AsyncGenerator<AgentStreamEvent> {
    const size = await stat(child.file).then(
      (info) => info.size,
      () => 0,
    );
    // A history read ends at its initial file size even if the live conversation keeps appending.
    const reader = new PiChildSessionFollower(
      child.id,
      child.file,
      undefined,
      "conversation",
      size,
      child.projection,
    );
    do {
      const events = await reader.readNew();
      for (const event of events) {
        if (this.closed) return;
        yield { type: "provider_subagent", provider: "pi", event };
      }
    } while (reader.hasMore && !this.closed);
  }

  mapToolCall(call: PiExtensionToolCall): PiExtensionOutput<PiExtensionToolMapping> | undefined {
    for (const { id, adapter } of this.sessions) {
      const mapping = this.safe(id, "mapToolCall", () => adapter.mapToolCall?.(call));
      if (mapping) {
        const prepared = this.safe(id, "prepare", () => this.prepare(id, mapping));
        if (prepared) return prepared;
      }
    }
    return undefined;
  }

  mapCustomMessage(
    message: Extract<PiAgentMessage, { role: "custom" }>,
  ): PiExtensionOutput<PiExtensionCustomMapping> | undefined {
    for (const { id, adapter } of this.sessions) {
      const mapping = this.safe(id, "mapCustomMessage", () => adapter.mapCustomMessage?.(message));
      if (mapping) {
        const prepared = this.safe(id, "prepare", () => this.prepare(id, mapping));
        if (prepared) return prepared;
      }
    }
    return undefined;
  }

  mapRuntimeNotification(message: string): PiExtensionOutput<PiExtensionCustomMapping> | undefined {
    for (const { id, adapter } of this.sessions) {
      let failed = false;
      const mapping = this.safe(id, "mapRuntimeNotification", () => {
        try {
          return adapter.mapRuntimeNotification?.(message);
        } catch (error) {
          failed = true;
          throw error;
        }
      });
      // A recognized but invalid bridge payload must not become a generic chat notification.
      if (failed) return { subagents: [], events: [], hydration: Promise.resolve([]) };
      if (mapping) {
        const prepared = this.safe(id, "prepare", () => this.prepare(id, mapping));
        if (prepared) return prepared;
      }
    }
    return undefined;
  }

  private prepare<T extends PiExtensionToolMapping | PiExtensionCustomMapping>(
    id: string,
    mapping: T,
  ): PiExtensionOutput<T> {
    const events: AgentStreamEvent[] = [
      ...("timeline" in mapping ? (mapping.timeline ?? []) : []).map(
        (item): AgentStreamEvent => ({ type: "timeline", provider: "pi", item }),
      ),
      ...(mapping.subagents ?? []).map(
        (event): AgentStreamEvent => ({ type: "provider_subagent", provider: "pi", event }),
      ),
    ];
    const hydration = (
      this.onFollowEvent ? this.followChildren(mapping) : this.readChildren(mapping)
    ).catch((error): AgentStreamEvent[] => {
      this.logger?.warn(
        { err: error, extensionId: id, operation: "hydrate" },
        "Pi extension adapter failed",
      );
      return [];
    });
    return { ...mapping, events, hydration };
  }

  private async followChildren(
    mapping: PiExtensionToolMapping | PiExtensionCustomMapping,
  ): Promise<AgentStreamEvent[]> {
    for (const event of mapping.subagents ?? []) {
      if (event.type !== "remove") continue;
      this.followers.delete(event.id);
      this.parked.delete(event.id);
    }
    for (const { id, file, lifetime, projection } of mapping.childSessions ?? []) {
      const parked = this.parked.get(id);
      const reusable = parked?.lifetime === "conversation" ? parked : undefined;
      const previous = this.followers.get(id) ?? reusable;
      this.parked.delete(id);
      const follower =
        previous?.file === file
          ? previous
          : {
              reader: new PiChildSessionFollower(
                id,
                file,
                undefined,
                lifetime,
                undefined,
                projection,
              ),
              file,
              lifetime,
              pending: Promise.resolve(),
            };
      this.followers.set(id, follower);
    }
    const finished = (mapping.subagents ?? []).flatMap((event) =>
      event.type === "upsert" && event.status && event.status !== "running" ? [event.id] : [],
    );
    const ids = new Set([...(mapping.childSessions ?? []).map(({ id }) => id), ...finished]);
    const reads = [...ids].flatMap((id) => {
      const follower = this.followers.get(id);
      return follower ? [this.readFollower(id, follower, finished.includes(id))] : [];
    });
    for (const id of finished) {
      const follower = this.followers.get(id);
      if (!follower) continue;
      // Retiring readers remain owned through their final read, without scheduling new ticks.
      this.parked.set(id, follower);
      this.followers.delete(id);
      if (follower.lifetime !== "conversation") {
        void follower.pending.then(() => {
          if (this.parked.get(id) === follower) this.parked.delete(id);
          return undefined;
        });
      }
    }
    await Promise.all(reads);
    return [];
  }

  private async readChildren(
    mapping: PiExtensionToolMapping | PiExtensionCustomMapping,
  ): Promise<AgentStreamEvent[]> {
    const groups = await Promise.all(
      (mapping.childSessions ?? []).map(async ({ id, file, projection }) => {
        // Charge the transcript's size, not the per-file cap, or eight small children exhaust 16 MiB.
        const size = await stat(file).then(
          (stats) => stats.size,
          () => 0,
        );
        const bytes = Math.min(this.remainingHydrationBytes, 2 * 1024 * 1024, size);
        if (bytes <= 0) return [];
        this.remainingHydrationBytes -= bytes;
        return (await this.readChildSession(id, file, bytes, projection)).map(
          (event): AgentStreamEvent => ({ type: "provider_subagent", provider: "pi", event }),
        );
      }),
    );
    return groups.flat();
  }

  onToolStart(call: PiExtensionToolCall, provider = "pi"): AgentPermissionRequest | undefined {
    let request: AgentPermissionRequest | undefined;
    for (const { id, adapter } of this.sessions) {
      const candidate = this.safe(id, "onToolStart", () => adapter.onToolStart?.(call, provider));
      request ??= candidate;
    }
    return request;
  }

  onToolEnd(call: PiExtensionToolCall): void {
    for (const { id, adapter } of this.sessions) {
      this.safe(id, "onToolEnd", () => adapter.onToolEnd?.(call));
    }
  }

  mapDialog(dialog: PiExtensionDialog, provider: string): PiExtensionDialogMapping | undefined {
    for (const { id, adapter } of this.sessions) {
      const mapping = this.safe(id, "mapDialog", () => adapter.mapDialog?.(dialog, provider));
      if (mapping) return mapping;
    }
    return undefined;
  }

  respondToPermission(
    request: AgentPermissionRequest,
    response: AgentPermissionResponse,
  ): PiExtensionUiReply | undefined {
    for (const { id, adapter } of this.sessions) {
      const mapped = this.safe(id, "respondToPermission", () =>
        adapter.respondToPermission?.(request, response),
      );
      if (mapped) return mapped;
    }
    return undefined;
  }
}
