import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  observeProviderSubagentTimeline,
  providerSubagentKey,
  useProviderSubagentStore,
} from "@/subagents/provider-store";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import { createBtwThreadSelector } from "./select";
import { refreshBtwOnConnect } from "./refresh-on-connect";

interface BtwPanelReadInput {
  client: Pick<
    DaemonClient,
    "subscribeConnectionStatus" | "listProviderSubagents" | "fetchProviderSubagentTimeline"
  >;
  serverId: string;
  agentId: string;
  threadId: string | null;
  hasTimeline: boolean;
  reportError(error: string | null): void;
}

/** A standalone retained tab owns its reads even while the parent pane is closed. */
export function observeBtwPanelReads({
  client,
  serverId,
  agentId,
  threadId,
  hasTimeline,
  reportError,
}: BtwPanelReadInput): () => void {
  let active = true;
  function fail(error: unknown) {
    if (active) reportError(error instanceof Error ? error.message : String(error));
  }
  reportError(null);
  const key = threadId ? providerSubagentKey(serverId, agentId, threadId) : null;
  const unsubscribe = useProviderSubagentStore.subscribe((state, previous) => {
    const timeline = key ? state.timelines.get(key) : undefined;
    const changed = key && timeline !== previous.timelines.get(key);
    if (changed && timeline && !timeline.needsRefresh) reportError(null);
  });
  let timelineGeneration = 0;
  let stopTimeline = () => {};
  function startTimeline() {
    if (!threadId || !hasTimeline) return;
    stopTimeline();
    const current = ++timelineGeneration;
    stopTimeline = observeProviderSubagentTimeline({
      client,
      serverId,
      parentAgentId: agentId,
      subagentId: threadId,
      limit: TIMELINE_FETCH_PAGE_SIZE,
      reportError: (error) => {
        if (timelineGeneration === current) fail(error);
      },
    });
  }
  startTimeline();
  const select = createBtwThreadSelector(serverId, agentId);
  const stopRefresh = refreshBtwOnConnect(
    client,
    serverId,
    agentId,
    (reason) => {
      const current = select(useProviderSubagentStore.getState());
      if (!current || current.hasTimeline === false) reportError(null);
      else if (reason === "reconnect" && current.id === threadId) startTimeline();
    },
    fail,
  );
  return () => {
    active = false;
    timelineGeneration++;
    stopTimeline();
    stopRefresh();
    unsubscribe();
  };
}
