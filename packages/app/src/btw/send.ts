import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useCallback } from "react";
import { useSessionStore } from "@/stores/session-store";

export type BtwCommand =
  | { kind: "ask"; text: string }
  | { kind: "abort" }
  | { kind: "inject"; instructions?: string }
  | { kind: "summarize"; instructions?: string }
  | { kind: "new"; text?: string }
  | { kind: "clear" };
export function btwCommandText(command: BtwCommand): string {
  switch (command.kind) {
    case "ask":
      return `/btw ${command.text}`;
    case "new":
      return `/btw:new${command.text ? ` ${command.text}` : ""}`;
    case "inject":
    case "summarize":
      return `/btw:${command.kind}${command.instructions ? ` ${command.instructions}` : ""}`;
    case "abort":
    case "clear":
      return `/btw:${command.kind}`;
  }
}
interface BtwCommandInput {
  client: Pick<DaemonClient, "sendAgentMessage"> | null;
  agentId: string;
  command: BtwCommand;
}
export async function sendBtwCommand({ client, agentId, command }: BtwCommandInput): Promise<void> {
  if (!client) throw new Error("Host disconnected");
  // An empty id explicitly omits the main-chat breadcrumb.
  await client.sendAgentMessage(agentId, btwCommandText(command), { messageId: "" });
}
export function useSendBtwCommand(serverId: string, agentId: string) {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  return useCallback(
    (command: BtwCommand) => sendBtwCommand({ client, agentId, command }),
    [agentId, client],
  );
}
