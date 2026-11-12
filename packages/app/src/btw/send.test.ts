/** @vitest-environment jsdom */
import { expect, test, vi } from "vitest";
import { btwCommandText, useSendBtwCommand } from "./send";
import { useSessionStore } from "@/stores/session-store";
import { renderHook } from "@testing-library/react";

vi.mock("@/stores/session-store", () => ({ useSessionStore: vi.fn() }));
test("every window action encodes exactly one command, preserving multiline Unicode questions", () => {
  expect([
    btwCommandText({ kind: "ask", text: "Why 日本語?\nsecond line" }),
    btwCommandText({ kind: "abort" }),
    btwCommandText({ kind: "inject" }),
    btwCommandText({ kind: "summarize", instructions: "Be brief" }),
    btwCommandText({ kind: "new" }),
    btwCommandText({ kind: "new", text: "Next" }),
    btwCommandText({ kind: "clear" }),
  ]).toEqual([
    "/btw Why 日本語?\nsecond line",
    "/btw:abort",
    "/btw:inject",
    "/btw:summarize Be brief",
    "/btw:new",
    "/btw:new Next",
    "/btw:clear",
  ]);
});
test("window sends suppress the main timeline breadcrumb and propagate failures without resending", async () => {
  const sendAgentMessage = vi.fn().mockRejectedValue(new Error("Disconnected"));
  vi.mocked(useSessionStore).mockReturnValue({ sendAgentMessage });
  const { result } = renderHook(() => useSendBtwCommand("host", "owner"));
  await expect(result.current({ kind: "ask", text: "Question" })).rejects.toThrow("Disconnected");
  expect(sendAgentMessage).toHaveBeenCalledExactlyOnceWith("owner", "/btw Question", {
    messageId: "",
  });
});
