import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessagesSquare } from "lucide-react-native";
import invariant from "tiny-invariant";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelDescriptorContext } from "@/panels/panel-registry";
import { useSessionStore } from "@/stores/session-store";
import { deriveSubagentStatusBucket } from "@/subagents";
import {
  observeProviderSubagentTimeline,
  providerSubagentKey,
  providerSubagentLifecycleStatus,
  useProviderSubagentStore,
} from "@/subagents/provider-store";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import type { AgentStreamViewHandle } from "@/agent-stream/view";
import { useBtwThread } from "./select";
import { useSendBtwCommand, type BtwCommand } from "./send";
import {
  btwConversationKey,
  useBtwConversation,
  useBtwConversationStore,
} from "./conversation-store";
import { findBtwSubmittedQuestionIndex } from "./draft";
import { BtwPanelContent } from "./panel-content";
import { selectBtwThread } from "./select";
import { refreshBtwOnConnect } from "./refresh-on-connect";

function useBtwDescriptor(
  target: { kind: "btw"; agentId: string },
  context: PanelDescriptorContext,
) {
  const { t } = useTranslation();
  const thread = useBtwThread(context.serverId, target.agentId);
  return {
    label: t("btw.label"),
    subtitle: thread?.title || t("btw.title"),
    tooltip: t("btw.title"),
    titleState: "ready" as const,
    icon: MessagesSquare,
    statusBucket: thread
      ? deriveSubagentStatusBucket(providerSubagentLifecycleStatus(thread.status))
      : null,
  };
}
function BtwPanel() {
  const { serverId, target } = usePaneContext();
  invariant(target.kind === "btw", "BtwPanel requires a BTW target");
  const agentId = target.agentId;
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const thread = useBtwThread(serverId, agentId);
  const key = btwConversationKey(serverId, agentId);
  const conversation = useBtwConversation(key);
  const threadId = thread?.id ?? null;
  const hasTimeline = thread?.hasTimeline !== false;
  const timelineKey = threadId ? providerSubagentKey(serverId, agentId, threadId) : null;
  const timeline = useProviderSubagentStore((state) =>
    timelineKey ? state.timelines.get(timelineKey) : undefined,
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const streamViewRef = useRef<AgentStreamViewHandle>(null);
  const pendingSendLanding = useRef(false);
  const cancelSendLanding = useCallback(() => {
    pendingSendLanding.current = false;
  }, []);
  const send = useSendBtwCommand(serverId, agentId);
  useEffect(() => {
    if (!thread) return;
    useBtwConversationStore.getState().observeThread(key, {
      threadId: thread.id,
      status: thread.status,
      updatedAt: thread.updatedAt,
      items: [...(timeline?.tail ?? []), ...(timeline?.head ?? [])],
    });
  }, [key, thread, timeline]);
  useEffect(() => {
    setHistoryError(null);
    if (!client || !threadId || !hasTimeline) return;
    return observeProviderSubagentTimeline({
      client,
      serverId,
      parentAgentId: agentId,
      subagentId: threadId,
      limit: TIMELINE_FETCH_PAGE_SIZE,
      reportError: (error) =>
        setHistoryError(error instanceof Error ? error.message : String(error)),
    });
  }, [client, serverId, agentId, threadId, hasTimeline]);
  useEffect(() => {
    // Reconnect can reuse the client; fresh history retires the disconnected read's error.
    if (timeline && !timeline.needsRefresh) setHistoryError(null);
  }, [timeline]);
  useEffect(() => {
    if (!client) return;
    // A restored tab can be mounted while its parent tab is closed or retained inactive.
    return refreshBtwOnConnect(
      client,
      serverId,
      agentId,
      () => {
        const prefix = `${serverId}\0${agentId}\0`;
        const rows = [...useProviderSubagentStore.getState().descriptors]
          .filter(([descriptorKey]) => descriptorKey.startsWith(prefix))
          .map(([, row]) => row);
        const current = selectBtwThread(rows);
        if (!current || current.hasTimeline === false) setHistoryError(null);
      },
      (error) => setHistoryError(error instanceof Error ? error.message : String(error)),
    );
  }, [client, serverId, agentId]);
  // RPC acceptance precedes Pi's question row; only this mounted explicit ask may land once.
  useEffect(() => {
    const submitted = conversation.draft.submitted;
    if (!pendingSendLanding.current || !submitted || !timeline || !thread) return;
    const rejected = thread.status === "failed" || thread.status === "canceled";
    if (rejected && Date.parse(thread.updatedAt) >= submitted.submittedAt) {
      cancelSendLanding();
      return;
    }
    if (findBtwSubmittedQuestionIndex(submitted, [...timeline.tail, ...timeline.head]) < 0) return;
    cancelSendLanding();
    streamViewRef.current?.scrollToBottom("message-sent");
  }, [conversation.draft.submitted, thread, timeline, cancelSendLanding]);
  const dispatch = useCallback(
    (command: BtwCommand) => {
      const current = timelineKey
        ? useProviderSubagentStore.getState().timelines.get(timelineKey)
        : undefined;
      const request = useBtwConversationStore.getState().dispatch({
        key,
        command,
        send,
        after: current?.epoch ? { epoch: current.epoch, seq: current.lastSeq } : null,
      });
      if (!request) return;
      pendingSendLanding.current = command.kind === "ask";
      void request.then((result) => {
        if (!result.ok) cancelSendLanding();
        return undefined;
      });
    },
    [key, send, timelineKey, cancelSendLanding],
  );
  const edit = useCallback(
    (text: string) => useBtwConversationStore.getState().edit(key, text),
    [key],
  );
  return (
    <BtwPanelContent
      serverId={serverId}
      agentId={agentId}
      thread={thread}
      streamViewRef={streamViewRef}
      onUserScrollIntent={cancelSendLanding}
      compact={compact}
      draft={conversation.draft.text}
      onDraft={edit}
      onCommand={dispatch}
      pending={conversation.pending}
      feedback={conversation.accepted ? t("btw.accepted") : null}
      error={conversation.error ?? historyError}
    />
  );
}
export const btwPanelRegistration = definePanel("btw", {
  component: BtwPanel,
  useDescriptor: useBtwDescriptor,
});
