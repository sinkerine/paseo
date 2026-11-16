import { create } from "zustand";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import type { StreamItem, TimelinePosition } from "@/types/stream";
import { reduceBtwDraft, type BtwDraftState } from "./draft";
import type { BtwCommand } from "./send";

export function btwConversationKey(serverId: string, agentId: string): string {
  return JSON.stringify([serverId, agentId]);
}
export interface BtwConversation {
  draft: BtwDraftState;
  pending: boolean;
  error: string | null;
  accepted: boolean;
}
export const EMPTY_BTW_CONVERSATION: BtwConversation = {
  draft: { threadId: null, text: "", submitted: null, failed: false },
  pending: false,
  error: null,
  accepted: false,
};
export type BtwDispatchResult = { ok: true } | { ok: false; error: string };
interface ObservedBtwThread {
  threadId: string;
  status: ProviderSubagentDescriptorPayload["status"];
  updatedAt: string;
  items: readonly StreamItem[];
}
interface BtwDispatchInput {
  key: string;
  command: BtwCommand;
  after: TimelinePosition | null;
  send(command: BtwCommand): Promise<void>;
  submittedAt?: number;
}
interface BtwConversationStore {
  byParent: Record<string, BtwConversation>;
  edit(key: string, text: string): void;
  observeThread(key: string, thread: ObservedBtwThread): void;
  dispatch(input: BtwDispatchInput): Promise<BtwDispatchResult> | null;
}
export const useBtwConversationStore = create<BtwConversationStore>((set, get) => {
  function update(key: string, change: (current: BtwConversation) => BtwConversation) {
    set((state) => {
      const current = state.byParent[key] ?? EMPTY_BTW_CONVERSATION;
      const next = change(current);
      return next === current ? state : { byParent: { ...state.byParent, [key]: next } };
    });
  }
  return {
    byParent: {},
    edit(key, text) {
      update(key, (current) => ({
        ...current,
        draft: reduceBtwDraft(current.draft, { type: "edit", text }),
      }));
    },
    observeThread(key, thread) {
      update(key, (current) => {
        const draft = reduceBtwDraft(current.draft, { type: "thread", ...thread });
        const previous = current.draft;
        if (
          draft.threadId === previous.threadId &&
          draft.text === previous.text &&
          draft.failed === previous.failed &&
          draft.submitted === previous.submitted
        )
          return current;
        return { ...current, draft };
      });
    },
    dispatch(input) {
      if (get().byParent[input.key]?.pending) return null;
      update(input.key, (current) => ({
        ...current,
        // Only asks need optimistic tracking for provider failure before acknowledgement.
        draft:
          input.command.kind === "ask"
            ? reduceBtwDraft(current.draft, {
                type: "submit",
                command: input.command,
                after: input.after,
                submittedAt: input.submittedAt ?? Date.now(),
              })
            : current.draft,
        pending: true,
        error: null,
        accepted: false,
      }));
      const submitted = get().byParent[input.key].draft.submitted;
      async function deliver(): Promise<BtwDispatchResult> {
        try {
          await input.send(input.command);
          update(input.key, (current) => ({
            ...current,
            pending: false,
            accepted: true,
            draft: reduceBtwDraft(
              current.draft,
              input.command.kind === "ask"
                ? { type: "accepted", command: input.command }
                : { type: "submit", command: input.command, after: input.after, submittedAt: 0 },
            ),
          }));
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          update(input.key, (current) => ({
            ...current,
            pending: false,
            error: message,
            accepted: false,
            // Observations may already have reconciled or replaced this attempt.
            draft:
              input.command.kind === "ask" && current.draft.submitted === submitted
                ? { ...current.draft, submitted: null }
                : current.draft,
          }));
          return { ok: false, error: message };
        }
      }
      return deliver();
    },
  };
});
export function useBtwConversation(key: string): BtwConversation {
  return useBtwConversationStore((state) => state.byParent[key] ?? EMPTY_BTW_CONVERSATION);
}
