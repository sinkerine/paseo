import type { ConnectionState, DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";

export function btwTestConnection(rows: ProviderSubagentDescriptorPayload[] = []) {
  const listeners = new Set<(state: ConnectionState) => void>();
  let state: ConnectionState = { status: "disconnected" };
  const calls: string[] = [];
  let read: DaemonClient["listProviderSubagents"] = async (parentAgentId) => ({
    requestId: "list",
    parentAgentId,
    subagents: rows,
    error: null,
  });
  const client: Pick<DaemonClient, "subscribeConnectionStatus" | "listProviderSubagents"> = {
    subscribeConnectionStatus(listener) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    listProviderSubagents(parentAgentId) {
      calls.push(parentAgentId);
      return read(parentAgentId);
    },
  };
  return {
    client,
    calls,
    listeners,
    setRead(next: DaemonClient["listProviderSubagents"]) {
      read = next;
    },
    status(next: ConnectionState) {
      state = next;
      for (const listener of listeners) listener(state);
    },
  };
}
