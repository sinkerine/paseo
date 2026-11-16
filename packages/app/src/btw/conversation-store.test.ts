import { beforeEach, expect, test, vi } from "vitest";
import {
  btwConversationKey,
  EMPTY_BTW_CONVERSATION,
  useBtwConversationStore,
} from "./conversation-store";

const key = btwConversationKey("host", "parent");
const question = { kind: "ask", text: "draft line 1\nASCII line 2" } as const;
beforeEach(() => useBtwConversationStore.setState({ byParent: {} }));

test("accept clears the submitted ask and a parent-scoped pending guard suppresses duplicates", async () => {
  const store = useBtwConversationStore.getState();
  store.edit(key, question.text);
  let finish = () => {};
  const send = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = store.dispatch({ key, command: question, after: null, send, submittedAt: 100 });
  expect(pending).not.toBeNull();
  expect(useBtwConversationStore.getState().byParent[key].pending).toBe(true);
  expect(store.dispatch({ key, command: question, after: null, send })).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
  finish();
  await expect(pending).resolves.toEqual({ ok: true });
  expect(useBtwConversationStore.getState().byParent[key]).toMatchObject({
    pending: false,
    accepted: true,
    error: null,
    draft: { text: "" },
  });
});

test("reject keeps draft and error until an explicit retry without resending", async () => {
  const store = useBtwConversationStore.getState();
  store.edit(key, question.text);
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error("Host disconnected"))
    .mockResolvedValueOnce(undefined);
  await expect(store.dispatch({ key, command: question, after: null, send })).resolves.toEqual({
    ok: false,
    error: "Host disconnected",
  });
  expect(useBtwConversationStore.getState().byParent[key]).toMatchObject({
    pending: false,
    accepted: false,
    error: "Host disconnected",
    draft: { text: question.text },
  });
  expect(send).toHaveBeenCalledTimes(1);
  await store.dispatch({ key, command: question, after: null, send });
  expect(useBtwConversationStore.getState().byParent[key]).toMatchObject({
    error: null,
    draft: { text: "" },
  });
  expect(send).toHaveBeenCalledTimes(2);
});

test("parents are isolated", async () => {
  const store = useBtwConversationStore.getState();
  const other = btwConversationKey("host", "other");
  expect(btwConversationKey("a_b", "c")).not.toBe(btwConversationKey("a", "b_c"));
  expect(btwConversationKey("other-host", "parent")).not.toBe(key);
  store.edit(key, question.text);
  store.edit(other, "other draft");
  let finish = () => {};
  const pending = store.dispatch({
    key,
    command: question,
    after: null,
    send: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  const send = vi.fn(async () => {});
  await store.dispatch({
    key: other,
    command: { kind: "ask", text: "other draft" },
    after: null,
    send,
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(useBtwConversationStore.getState().byParent[key].pending).toBe(true);
  expect(useBtwConversationStore.getState().byParent[key].draft.text).toBe(question.text);
  finish();
  await pending;
});

test("observeThread recovers an accepted ask on late provider rejection without a second send", async () => {
  const store = useBtwConversationStore.getState();
  const send = vi.fn(async () => {});
  store.edit(key, question.text);
  await store.dispatch({ key, command: question, after: null, send, submittedAt: 0 });
  store.observeThread(key, {
    threadId: "thread",
    status: "failed",
    updatedAt: "2026-01-01",
    items: [],
  });
  expect(useBtwConversationStore.getState().byParent[key].draft.text).toBe(question.text);
  expect(send).toHaveBeenCalledTimes(1);
  expect(EMPTY_BTW_CONVERSATION).toMatchObject({
    pending: false,
    error: null,
    accepted: false,
    draft: { threadId: null, text: "" },
  });
});

test("a locally rejected ask never resurrects text cleared before later provider failure", async () => {
  const store = useBtwConversationStore.getState();
  store.edit(key, question.text);
  const send = vi.fn(async () => {
    throw new Error("Host disconnected");
  });
  await store.dispatch({ key, command: question, after: null, send, submittedAt: 0 });
  store.edit(key, "");
  store.observeThread(key, {
    threadId: "thread",
    status: "failed",
    updatedAt: "2026-01-04",
    items: [],
  });
  expect(useBtwConversationStore.getState().byParent[key].draft).toMatchObject({
    text: "",
    submitted: null,
  });
  expect(send).toHaveBeenCalledTimes(1);
});

test("rejected Stop retains the accepted question for later provider failure", async () => {
  const store = useBtwConversationStore.getState();
  store.observeThread(key, {
    threadId: "thread",
    status: "running",
    updatedAt: "2026-01-01",
    items: [],
  });
  store.edit(key, "Q1");
  await store.dispatch({
    key,
    command: { kind: "ask", text: "Q1" },
    after: { epoch: "epoch", seq: 0 },
    send: async () => {},
    submittedAt: 0,
  });
  await store.dispatch({
    key,
    command: { kind: "abort" },
    after: null,
    send: async () => {
      throw new Error("offline");
    },
  });
  store.observeThread(key, {
    threadId: "thread",
    status: "failed",
    updatedAt: "2026-01-04",
    items: [],
  });
  expect(useBtwConversationStore.getState().byParent[key].draft.text).toBe("Q1");
});

test.each(["completed", "replaced"] as const)(
  "rejected Stop never revives a question already %s while pending",
  async (transition) => {
    const store = useBtwConversationStore.getState();
    store.observeThread(key, {
      threadId: "thread",
      status: "running",
      updatedAt: "2026-01-01",
      items: [],
    });
    store.edit(key, "Q1");
    await store.dispatch({
      key,
      command: { kind: "ask", text: "Q1" },
      after: { epoch: "epoch", seq: 0 },
      send: async () => {},
      submittedAt: 0,
    });
    let reject = (_error: Error) => {};
    const pending = store.dispatch({
      key,
      command: { kind: "abort" },
      after: null,
      send: () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    });
    store.observeThread(key, {
      threadId: transition === "replaced" ? "new-thread" : "thread",
      status: "completed",
      updatedAt: "2026-01-04",
      items: [
        {
          kind: "user_message",
          id: "q",
          text: "Q1",
          timestamp: new Date("2026-01-02"),
          timelineCursor: { epoch: "epoch", seq: 1 },
        },
        {
          kind: "assistant_message",
          id: "a",
          text: "Answer",
          timestamp: new Date("2026-01-02"),
          timelineCursor: { epoch: "epoch", seq: 2 },
        },
      ],
    });
    store.edit(key, "Newer draft");
    reject(new Error("offline"));
    await pending;
    store.observeThread(key, {
      threadId: transition === "replaced" ? "new-thread" : "thread",
      status: "failed",
      updatedAt: "2026-01-05",
      items: [],
    });
    expect(useBtwConversationStore.getState().byParent[key].draft).toMatchObject({
      text: "Newer draft",
      submitted: null,
    });
  },
);

test("rejected ask preserves newer edits and authoritative completion while pending", async () => {
  const store = useBtwConversationStore.getState();
  store.edit(key, "Q1");
  let reject = (_error: Error) => {};
  const pending = store.dispatch({
    key,
    command: { kind: "ask", text: "Q1" },
    after: null,
    submittedAt: 0,
    send: () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  });
  store.edit(key, "Newer draft");
  store.observeThread(key, {
    threadId: "thread",
    status: "completed",
    updatedAt: "2026-01-04",
    items: [
      { kind: "user_message", id: "q", text: "Q1", timestamp: new Date("2026-01-02") },
      { kind: "assistant_message", id: "a", text: "Answer", timestamp: new Date("2026-01-02") },
    ],
  });
  reject(new Error("offline"));
  await pending;
  expect(useBtwConversationStore.getState().byParent[key].draft).toMatchObject({
    text: "Newer draft",
    submitted: null,
  });
});
