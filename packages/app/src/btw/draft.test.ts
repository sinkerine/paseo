import { expect, test } from "vitest";
import type { StreamItem } from "@/types/stream";
import { reduceBtwDraft, type BtwDraftAction, type BtwDraftState } from "./draft";

const question = { kind: "ask", text: "Question 日本語" } as const;
function apply(...actions: BtwDraftAction[]) {
  const initial: BtwDraftState = { text: question.text, submitted: null, failed: false };
  return actions.reduce(reduceBtwDraft, initial);
}
test.each([false, true])(
  "recovers a question when failure precedes acceptance: %s",
  (failureFirst) => {
    const failure: BtwDraftAction = {
      type: "thread",
      status: "failed",
      updatedAt: "2026-01-01",
      items: [],
    };
    const acceptance: BtwDraftAction = { type: "accepted", command: question };
    const order = failureFirst ? [failure, acceptance] : [acceptance, failure];
    const state = apply(
      { type: "submit", after: { epoch: "epoch", seq: 2 }, submittedAt: 0, command: question },
      ...order,
    );
    expect(state.text).toBe(question.text);
    expect(state.failed).toBe(true);
  },
);
test("an accepted question clears; a retry clears recovery only after the thread recovers", () => {
  const accepted = apply(
    { type: "submit", after: { epoch: "epoch", seq: 2 }, submittedAt: 0, command: question },
    { type: "accepted", command: question },
  );
  expect(accepted.text).toBe("");
  const retried = apply(
    { type: "submit", after: { epoch: "epoch", seq: 2 }, submittedAt: 0, command: question },
    { type: "accepted", command: question },
    { type: "thread", status: "failed", updatedAt: "2026-01-01", items: [] },
    { type: "submit", after: { epoch: "epoch", seq: 2 }, submittedAt: 0, command: question },
    { type: "accepted", command: question },
    { type: "thread", status: "completed", updatedAt: "2026-01-03", items: [user, answer] },
  );
  expect(retried.text).toBe("");
  expect(retried.failed).toBe(false);
});
test("a late failure never replaces a newer draft or resurrects text for an unrelated action", () => {
  const edited = apply(
    { type: "submit", after: { epoch: "epoch", seq: 2 }, submittedAt: 0, command: question },
    { type: "accepted", command: question },
    { type: "edit", text: "New unsent draft" },
    { type: "thread", status: "failed", updatedAt: "2026-01-01", items: [] },
  );
  expect(edited.text).toBe("New unsent draft");
  const unrelated = apply(
    { type: "submit", after: { epoch: "epoch", seq: 2 }, submittedAt: 0, command: question },
    { type: "accepted", command: question },
    {
      type: "submit",
      after: { epoch: "epoch", seq: 2 },
      submittedAt: 0,
      command: { kind: "inject" },
    },
    { type: "thread", status: "failed", updatedAt: "2026-01-01", items: [] },
  );
  expect(unrelated.text).toBe("");
});

test("later failed-state metadata does not undo an intentional draft clear", () => {
  const state = apply(
    { type: "submit", after: { epoch: "epoch", seq: 2 }, submittedAt: 0, command: question },
    { type: "accepted", command: question },
    { type: "thread", status: "failed", updatedAt: "2026-01-01", items: [] },
    { type: "edit", text: "" },
    { type: "thread", status: "failed", updatedAt: "2026-01-01", items: [] },
  );
  expect(state.text).toBe("");
});

const user: StreamItem = {
  kind: "user_message",
  id: "own",
  text: question.text,
  timestamp: new Date("2026-01-02"),
  timelineCursor: { epoch: "epoch", seq: 3 },
};
const answer: StreamItem = {
  kind: "assistant_message",
  id: "answer",
  text: "Answered",
  timestamp: new Date("2026-01-02"),
  timelineCursor: { epoch: "epoch", seq: 4 },
};
const submit: BtwDraftAction = {
  type: "submit",
  command: question,
  after: { epoch: "epoch", seq: 2 },
  submittedAt: 0,
};
const accepted: BtwDraftAction = { type: "accepted", command: question };
const failure: BtwDraftAction = {
  type: "thread",
  status: "failed",
  updatedAt: "2026-01-04",
  items: [],
};

test.each(["completed", "canceled"] as const)(
  "reconciles the matching %s request before a later unrelated failure",
  (status) => {
    const state = apply(
      submit,
      accepted,
      { type: "thread", status, updatedAt: "2026-01-03", items: [user, answer] },
      failure,
    );
    expect(state.submitted).toBeNull();
    expect(state.text).toBe("");
  },
);
test("terminal metadata for an older identical question does not discard recovery", () => {
  const oldUser = { ...user, timelineCursor: { epoch: "epoch", seq: 1 } };
  const state = apply(
    submit,
    accepted,
    { type: "thread", status: "completed", updatedAt: "2026-01-03", items: [oldUser, answer] },
    failure,
  );
  expect(state.text).toBe(question.text);
});
test("unrelated success, stale idle metadata, and an unanswered matching question retain late rejection recovery", () => {
  for (const items of [[], [user], [{ ...user, text: "Other client's question" }, answer]]) {
    const state = apply(
      submit,
      accepted,
      { type: "thread", status: "completed", updatedAt: "2026-01-03", items },
      failure,
    );
    expect(state.text).toBe(question.text);
  }
  const stale = apply(
    submit,
    accepted,
    { type: "thread", status: "completed", updatedAt: "2026-01-01", items: [user, answer] },
    failure,
  );
  expect(stale.text).toBe(question.text);
});
test("a matching completion before acknowledgement stays cleared when the acknowledgement arrives", () => {
  const state = apply(
    submit,
    { type: "thread", status: "completed", updatedAt: "2026-01-03", items: [user, answer] },
    accepted,
    failure,
  );
  expect(state.submitted).toBeNull();
  expect(state.text).toBe("");
});
test("reconciliation keeps newer edits and canceled questions from other clients do not match", () => {
  const state = apply(
    submit,
    accepted,
    { type: "edit", text: "Next draft" },
    { type: "thread", status: "completed", updatedAt: "2026-01-03", items: [user, answer] },
    failure,
  );
  expect(state.text).toBe("Next draft");
  const canceled = apply(
    submit,
    accepted,
    { type: "thread", status: "canceled", updatedAt: "2026-01-03", items: [] },
    failure,
  );
  expect(canceled.text).toBe(question.text);
});

test("unrelated idle metadata between failure and acknowledgement preserves recovery", () => {
  const state = apply(
    submit,
    failure,
    { type: "thread", status: "completed", updatedAt: "2026-01-03", items: [] },
    accepted,
  );
  expect(state.text).toBe(question.text);
  expect(state.submitted?.text).toBe(question.text);
});
