import type { View } from "react-native";
import { useBtwSelectionTarget } from "./selection-target";
import { revealBtwTab } from "./tab";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
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
  providerSubagentKey,
  providerSubagentLifecycleStatus,
  useProviderSubagentStore,
} from "@/subagents/provider-store";
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
import { observeBtwPanelReads } from "./panel-reads";

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
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(target.kind === "btw", "BtwPanel requires a BTW target");
  const agentId = target.agentId;
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const thread = useBtwThread(serverId, agentId);
  const key = btwConversationKey(serverId, agentId);
  const conversation = useBtwConversation(key);
  const selectionTarget = useRef<View>(null);
  const insert = useCallback(
    (text: string) => {
      if (!useBtwConversationStore.getState().insert(key, text)) return false;
      revealBtwTab({
        workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
        agentId,
      });
      return true;
    },
    [key, serverId, workspaceId, agentId],
  );
  useBtwSelectionTarget({
    target: thread && !compact ? selectionTarget : undefined,
    onInsert: insert,
  });
  const clearComposerFocus = useCallback(
    () => useBtwConversationStore.getState().clearComposerFocus(key),
    [key],
  );
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
    if (!client) return;
    return observeBtwPanelReads({
      client,
      serverId,
      agentId,
      threadId,
      hasTimeline,
      reportError: setHistoryError,
    });
  }, [client, serverId, agentId, threadId, hasTimeline]);
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
      selectionTarget={selectionTarget}
      pendingComposerFocus={conversation.pendingComposerFocus}
      onComposerFocusHandled={clearComposerFocus}
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
