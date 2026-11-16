import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { refreshProviderSubagents } from "@/subagents/provider-store";

/** Reconnect keeps the client instance; retire callbacks from earlier connection attempts. */
export function refreshBtwOnConnect(
  client: Pick<DaemonClient, "subscribeConnectionStatus" | "listProviderSubagents">,
  serverId: string,
  agentId: string,
  onSuccess: (reason: "mount" | "reconnect") => void,
  onError: (error: unknown) => void,
): () => void {
  let generation = 0;
  let initial = true;
  const unsubscribe = client.subscribeConnectionStatus((state) => {
    const current = ++generation;
    if (!initial && state.status !== "connected") return;
    const reason = initial ? "mount" : "reconnect";
    initial = false;
    void refreshProviderSubagents(client, serverId, agentId).then(
      () => {
        if (generation === current) onSuccess(reason);
        return undefined;
      },
      (error: unknown) => {
        if (generation === current) onError(error);
      },
    );
  });
  return () => {
    generation++;
    unsubscribe();
  };
}
