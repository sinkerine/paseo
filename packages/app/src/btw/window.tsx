import { useCallback, useEffect, useRef, useState, useReducer } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSessionStore } from "@/stores/session-store";
import {
  observeProviderSubagentTimeline,
  providerSubagentKey,
  useProviderSubagentStore,
} from "@/subagents/provider-store";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import { useBtwThread } from "./select";
import { useSendBtwCommand, type BtwCommand } from "./send";
import { btwWindowKey, useBtwWindowStore } from "./window-store";
import { BtwFloatingCard } from "./floating-card";
import { BtwSheet } from "./sheet";
import { findBtwSubmittedQuestionIndex, reduceBtwDraft } from "./draft";
import { BtwWindowContent } from "./window-content";
import type { AgentStreamViewHandle } from "@/agent-stream/view";

export function BtwWindow({
  isComposerFullscreen = false,
  ...props
}: {
  serverId: string;
  agentId: string;
  isPaneFocused: boolean;
  isComposerFullscreen?: boolean;
}) {
  const thread = useBtwThread(props.serverId, props.agentId);
  return thread ? (
    <BtwThreadWindow
      key={btwWindowKey(props.serverId, props.agentId, thread.id)}
      {...props}
      thread={thread}
      isComposerFullscreen={isComposerFullscreen}
    />
  ) : null;
}
function BtwThreadWindow({
  serverId,
  agentId,
  isPaneFocused,
  isComposerFullscreen,
  thread,
}: {
  serverId: string;
  agentId: string;
  isPaneFocused: boolean;
  isComposerFullscreen: boolean;
  thread: ProviderSubagentDescriptorPayload;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const key = btwWindowKey(serverId, agentId, thread.id);
  const mode = useBtwWindowStore((state) => state.byThread[key]);
  const discover = useBtwWindowStore((state) => state.discover);
  const setMode = useBtwWindowStore((state) => state.setMode);
  const hide = useCallback(() => setMode(key, "minimized"), [key, setMode]);
  const [draft, updateDraft] = useReducer(reduceBtwDraft, {
    text: "",
    submitted: null,
    failed: thread.status === "failed",
  });
  const editDraft = useCallback((text: string) => updateDraft({ type: "edit", text }), []);
  const timelineKey = providerSubagentKey(serverId, agentId, thread.id);
  const timeline = useProviderSubagentStore((state) => state.timelines.get(timelineKey));
  useEffect(() => {
    updateDraft({
      type: "thread",
      status: thread.status,
      updatedAt: thread.updatedAt,
      items: [...(timeline?.tail ?? []), ...(timeline?.head ?? [])],
    });
  }, [thread.status, thread.updatedAt, timeline]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const send = useSendBtwCommand(serverId, agentId);
  const admitting = useRef(false);
  const pendingSendLanding = useRef(false);
  const cancelSendLanding = useCallback(() => {
    pendingSendLanding.current = false;
  }, []);
  const streamViewRef = useRef<AgentStreamViewHandle>(null);
  const action = useMutation({
    mutationFn: send,
    retry: false,
    onSuccess: (_result, command) => {
      updateDraft({ type: "accepted", command });
    },
    onError: cancelSendLanding,
    onSettled: () => {
      admitting.current = false;
    },
  });
  // RPC acceptance precedes Pi's question row. Land once when that exact local ask arrives.
  useEffect(() => {
    const submitted = draft.submitted;
    if (!pendingSendLanding.current || !submitted || !timeline) return;
    const rejected = thread.status === "failed" || thread.status === "canceled";
    if (rejected && Date.parse(thread.updatedAt) >= submitted.submittedAt) {
      cancelSendLanding();
      return;
    }
    const index = findBtwSubmittedQuestionIndex(submitted, [...timeline.tail, ...timeline.head]);
    if (index < 0) return;
    cancelSendLanding();
    streamViewRef.current?.scrollToBottom("message-sent");
  }, [draft.submitted, timeline, thread.status, thread.updatedAt, cancelSendLanding]);
  const { mutate } = action;
  const dispatch = useCallback(
    (command: BtwCommand) => {
      if (admitting.current) return;
      admitting.current = true;
      pendingSendLanding.current = command.kind === "ask";
      const current = useProviderSubagentStore.getState().timelines.get(timelineKey);
      const after = current?.epoch ? { epoch: current.epoch, seq: current.lastSeq } : null;
      updateDraft({ type: "submit", command, after, submittedAt: Date.now() });
      mutate(command);
    },
    [mutate, timelineKey],
  );
  useEffect(() => {
    discover(key);
  }, [discover, key]);
  // Minimize changes presentation only; the mounted owner continues observing the same thread.
  useEffect(() => {
    if (!client || thread.hasTimeline === false) return;
    setHistoryError(null);
    return observeProviderSubagentTimeline({
      client,
      serverId,
      parentAgentId: agentId,
      subagentId: thread.id,
      limit: TIMELINE_FETCH_PAGE_SIZE,
      reportError: (error) =>
        setHistoryError(error instanceof Error ? error.message : String(error)),
    });
  }, [client, serverId, agentId, thread.id, thread.hasTimeline]);
  const visible = mode === "open" && isPaneFocused && !isComposerFullscreen;
  const content = (
    <BtwWindowContent
      serverId={serverId}
      agentId={agentId}
      thread={thread}
      streamViewRef={streamViewRef}
      onUserScrollIntent={cancelSendLanding}
      compact={compact}
      draft={draft.text}
      onDraft={editDraft}
      onHide={hide}
      onCommand={dispatch}
      pending={action.isPending}
      error={action.error?.message ?? historyError}
      feedback={action.isSuccess ? t("btw.accepted") : null}
    />
  );
  return compact ? (
    <BtwSheet visible={visible} onHide={hide}>
      {content}
    </BtwSheet>
  ) : (
    <BtwFloatingCard visible={visible} onHide={hide}>
      {content}
    </BtwFloatingCard>
  );
}
