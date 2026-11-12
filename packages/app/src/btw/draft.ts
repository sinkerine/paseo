import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import type { StreamItem, TimelinePosition } from "@/types/stream";
import type { BtwCommand } from "./send";

export interface BtwDraftState {
  text: string;
  submitted: {
    text: string;
    accepted: boolean;
    after: TimelinePosition | null;
    submittedAt: number;
  } | null;
  failed: boolean;
}
export type BtwDraftAction =
  | { type: "edit"; text: string }
  | { type: "submit"; command: BtwCommand; after: TimelinePosition | null; submittedAt: number }
  | { type: "accepted"; command: BtwCommand }
  | {
      type: "thread";
      status: ProviderSubagentDescriptorPayload["status"];
      updatedAt: string;
      items: readonly StreamItem[];
    };

function reconcilesSubmission(
  state: BtwDraftState,
  action: Extract<BtwDraftAction, { type: "thread" }>,
) {
  const submitted = state.submitted;
  if (!submitted || (action.status !== "completed" && action.status !== "canceled")) return false;
  const index = action.items.findIndex((item) => {
    if (item.kind !== "user_message" || item.text.trim() !== submitted.text.trim()) return false;
    if (!submitted.after) return item.timestamp.getTime() >= submitted.submittedAt;
    return (
      item.timelineCursor?.epoch === submitted.after.epoch &&
      item.timelineCursor.seq > submitted.after.seq
    );
  });
  const question = action.items[index];
  if (!question || Date.parse(action.updatedAt) < question.timestamp.getTime()) return false;
  const following = action.items.slice(index + 1);
  if (action.status === "canceled") return !following.some((item) => item.kind === "user_message");
  const nextQuestion = following.findIndex((item) => item.kind === "user_message");
  const reply = nextQuestion < 0 ? following : following.slice(0, nextQuestion);
  return reply.some((item) => item.kind === "assistant_message");
}

/** Daemon acceptance precedes Pi command admission; retain the question until its own result reconciles. */
export function reduceBtwDraft(state: BtwDraftState, action: BtwDraftAction): BtwDraftState {
  switch (action.type) {
    case "edit":
      return { ...state, text: action.text };
    case "submit":
      return {
        ...state,
        submitted:
          action.command.kind === "ask"
            ? {
                text: action.command.text,
                accepted: false,
                after: action.after,
                submittedAt: action.submittedAt,
              }
            : null,
      };
    case "accepted": {
      if (action.command.kind !== "ask" || state.submitted?.text !== action.command.text)
        return state;
      const submitted = { ...state.submitted, accepted: true };
      const text = state.failed ? state.text || submitted.text : "";
      return { ...state, submitted, text };
    }
    case "thread":
      return reduceThreadDraft(state, action);
  }
}

function reduceThreadDraft(
  state: BtwDraftState,
  action: Extract<BtwDraftAction, { type: "thread" }>,
): BtwDraftState {
  if (action.status === "failed") {
    const text = state.failed ? state.text : state.text || state.submitted?.text || "";
    return { ...state, failed: true, text };
  }
  const reconciled = reconcilesSubmission(state, action);
  const clearAnsweredQuestion = reconciled && state.text === state.submitted?.text;
  return {
    ...state,
    failed: state.failed && state.submitted !== null && !reconciled,
    text: clearAnsweredQuestion ? "" : state.text,
    submitted: reconciled ? null : state.submitted,
  };
}
