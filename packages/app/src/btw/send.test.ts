import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "vitest";
import { btwCommandText, sendBtwCommand } from "./send";
test("every BTW action encodes exactly one command, preserving multiline ASCII questions", () => {
  expect([
    btwCommandText({ kind: "ask", text: "Why ASCII?\nsecond line" }),
    btwCommandText({ kind: "abort" }),
    btwCommandText({ kind: "inject" }),
    btwCommandText({ kind: "summarize", instructions: "Be brief" }),
    btwCommandText({ kind: "new" }),
    btwCommandText({ kind: "new", text: "Next" }),
    btwCommandText({ kind: "clear" }),
  ]).toEqual([
    "/btw Why ASCII?\nsecond line",
    "/btw:abort",
    "/btw:inject",
    "/btw:summarize Be brief",
    "/btw:new",
    "/btw:new Next",
    "/btw:clear",
  ]);
});
test("sends suppress the main timeline breadcrumb and propagate failures without resending", async () => {
  const calls: unknown[] = [];
  const client = {
    async sendAgentMessage(...args: Parameters<DaemonClient["sendAgentMessage"]>) {
      calls.push(args);
      throw new Error("Disconnected");
    },
  };
  await expect(
    sendBtwCommand({ client, agentId: "owner", command: { kind: "ask", text: "Question" } }),
  ).rejects.toThrow("Disconnected");
  expect(calls).toEqual([["owner", "/btw Question", { messageId: "" }]]);
  await expect(
    sendBtwCommand({ client: null, agentId: "owner", command: { kind: "clear" } }),
  ).rejects.toThrow("Host disconnected");
  expect(calls).toHaveLength(1);
});
