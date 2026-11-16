import { btwConversationKey } from "./conversation-store";
import { useAppSettings } from "@/hooks/use-settings";
import { isWeb } from "@/constants/platform";
import {
  handleComposerEnterKey,
  resolveComposerSubmitOnEnter,
  type WebTextInputKeyPressEvent,
} from "@/composer/input/enter-key";
import { focusBtwComposerInput, type BtwComposerInputRef } from "./selection-target";
import { useMutation } from "@tanstack/react-query";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import { useCallback, useMemo, useRef, useEffect, type RefObject } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import { AgentStreamView, type AgentStreamViewHandle } from "@/agent-stream/view";
import { Button } from "@/components/ui/button";
import { SheetAwareTextInput } from "@/components/ui/text-input/sheet-aware";
import { useSessionStore } from "@/stores/session-store";
import {
  loadOlderProviderSubagentTimeline,
  providerSubagentKey,
  providerSubagentLifecycleStatus,
  useProviderSubagentStore,
  type ProviderSubagentTimelineState,
} from "@/subagents/provider-store";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import type { TurnPresentation } from "@/timeline/turn-liveness";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem } from "@/types/stream";
import { PaneSubtitle } from "@/panels/pane-subtitle";
import type { BtwCommand } from "./send";

const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();
const EMPTY_ITEMS: StreamItem[] = [];
const EMPTY_STREAM = { tail: EMPTY_ITEMS, head: EMPTY_ITEMS };
export interface BtwPanelContentProps {
  serverId: string;
  agentId: string;
  thread: ProviderSubagentDescriptorPayload | null;
  streamViewRef: RefObject<AgentStreamViewHandle | null>;
  onUserScrollIntent(): void;
  compact: boolean;
  selectionTarget: RefObject<View | null>;
  draft: string;
  onDraft(text: string): void;
  onCommand(command: BtwCommand): void;
  pendingComposerFocus?: boolean;
  onComposerFocusHandled?: () => void;
  pending: boolean;
  feedback: string | null;
  error: string | null;
}
function hasConversationText(item: StreamItem): boolean {
  return (item.kind === "user_message" || item.kind === "assistant_message") && !!item.text.trim();
}
function canDeliverToMain({
  pending,
  status,
  timeline,
}: {
  pending: boolean;
  status: ProviderSubagentDescriptorPayload["status"];
  timeline: ProviderSubagentTimelineState | undefined;
}): boolean {
  if (pending || status === "running" || !timeline) return false;
  return timeline.tail.some(hasConversationText) || timeline.head.some(hasConversationText);
}
type BtwThreadProps = Pick<BtwPanelContentProps, "serverId" | "agentId" | "thread">;
function useBtwTimeline({ serverId, agentId, thread }: BtwThreadProps) {
  const key = thread ? providerSubagentKey(serverId, agentId, thread.id) : null;
  const timeline = useProviderSubagentStore((state) =>
    key ? state.timelines.get(key) : undefined,
  );
  const stream = timeline ?? EMPTY_STREAM;
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const older = useMutation({
    mutationKey: ["btw-history", serverId, agentId, thread?.id ?? null],
    mutationFn: () =>
      client && thread
        ? loadOlderProviderSubagentTimeline({
            client,
            serverId,
            parentAgentId: agentId,
            subagentId: thread.id,
            limit: TIMELINE_FETCH_PAGE_SIZE,
          })
        : Promise.resolve(false),
    retry: false,
  });
  const progressKey =
    timeline?.epoch && timeline.cursor ? `${timeline.epoch}:${timeline.cursor.startSeq}` : null;
  const historyPagination = useMemo(
    () => ({
      hasOlder: timeline?.hasOlder === true,
      isLoadingOlder: older.isPending,
      progressKey,
      onLoadOlder: older.mutateAsync,
    }),
    [timeline?.hasOlder, older.isPending, older.mutateAsync, progressKey],
  );
  return { timeline, stream, historyPagination, olderError: older.error?.message ?? null };
}
function useBtwStream({ serverId, agentId, thread }: BtwThreadProps) {
  const parent = useSessionStore(
    (state) =>
      state.sessions[serverId]?.agents.get(agentId) ??
      state.sessions[serverId]?.agentDetails.get(agentId),
  );
  const streamId = thread
    ? `provider:${encodeURIComponent(agentId)}:${encodeURIComponent(thread.id)}`
    : "";
  const provider = thread?.provider;
  const status = thread?.status;
  const context = useMemo<AgentScreenAgent | null>(
    () =>
      provider !== undefined && status !== undefined
        ? {
            serverId,
            id: streamId,
            provider,
            status: providerSubagentLifecycleStatus(status),
            cwd: parent?.cwd ?? "",
            workspaceId: parent?.workspaceId,
            projectPlacement: parent?.projectPlacement,
          }
        : null,
    [serverId, streamId, provider, status, parent],
  );
  const turnPresentation = useMemo<TurnPresentation>(
    () => ({
      isActive: thread?.status === "running",
      isCancelling: false,
      startedAt: null,
      turnId: null,
    }),
    [thread?.status],
  );
  return { streamId, context, turnPresentation };
}

export function BtwPanelContent({
  serverId,
  agentId,
  thread,
  streamViewRef,
  onUserScrollIntent,
  compact,
  selectionTarget,
  pendingComposerFocus,
  onComposerFocusHandled,
  draft,
  onDraft,
  onCommand,
  pending,
  feedback,
  error,
}: BtwPanelContentProps) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const inputRef = useRef<BtwComposerInputRef>(null);
  useEffect(() => {
    if (!pendingComposerFocus || !inputRef.current) return;
    focusBtwComposerInput(inputRef.current);
    onComposerFocusHandled?.();
  }, [pendingComposerFocus, onComposerFocusHandled]);
  const { timeline, stream, historyPagination, olderError } = useBtwTimeline({
    serverId,
    agentId,
    thread,
  });
  const { streamId, context, turnPresentation } = useBtwStream({ serverId, agentId, thread });
  const composerOwnership = useMemo(
    () => ({ chatComposerOwner: btwConversationKey(serverId, agentId) }),
    [serverId, agentId],
  );
  const visibleError = error ?? olderError;
  const deliveryDisabled =
    !thread || !canDeliverToMain({ pending, status: thread.status, timeline });
  const ask = useCallback(() => onCommand({ kind: "ask", text: draft }), [draft, onCommand]);
  const canAsk = !pending && draft.trim() !== "";
  const handleComposerKeyPress = useCallback(
    (event: WebTextInputKeyPressEvent) => {
      // BTW has no queue; modifier sends use the same ask dispatch as the button.
      handleComposerEnterKey(event, {
        submitOnEnter: resolveComposerSubmitOnEnter(compact),
        sendShortcut: settings.sendShortcut,
        isAgentRunning: false,
        onQueue: undefined,
        canSubmit: canAsk,
        onDefaultSend: ask,
        onAlternateSend: ask,
      });
    },
    [compact, settings.sendShortcut, canAsk, ask],
  );
  const abort = useCallback(() => onCommand({ kind: "abort" }), [onCommand]);
  const inject = useCallback(() => onCommand({ kind: "inject" }), [onCommand]);
  const summarize = useCallback(() => onCommand({ kind: "summarize" }), [onCommand]);
  const newThread = useCallback(() => onCommand({ kind: "new" }), [onCommand]);
  const clear = useCallback(() => onCommand({ kind: "clear" }), [onCommand]);
  return (
    <View
      style={styles.content}
      dataSet={composerOwnership}
      testID="btw-panel"
      accessibilityLabel={thread?.id ?? ""}
    >
      {thread?.subtitle ? <PaneSubtitle text={thread.subtitle} testID="btw-subtitle" /> : null}
      <View ref={selectionTarget} style={styles.timeline}>
        {thread && context ? (
          <AgentStreamView
            key={streamId}
            ref={streamViewRef}
            onUserScrollIntent={onUserScrollIntent}
            agentId={streamId}
            serverId={serverId}
            context={context}
            streamItems={stream.tail}
            streamHead={stream.head}
            turnPresentation={turnPresentation}
            pendingPermissions={EMPTY_PERMISSIONS}
            isAuthoritativeHistoryReady
            readOnly
            reserveTurnFooterSpace={!!timeline && timeline.tail.length + timeline.head.length > 0}
            historyPagination={historyPagination}
          />
        ) : (
          <Text style={styles.empty} testID="btw-empty">
            {t("btw.empty")}
          </Text>
        )}
      </View>
      {thread?.status === "failed" ? (
        <Text style={styles.error} testID="btw-provider-error">
          {thread.description}
        </Text>
      ) : null}
      <View style={styles.footer}>
        <SheetAwareTextInput
          ref={inputRef}
          testID="btw-composer"
          accessibilityLabel={t("btw.placeholder")}
          placeholder={t("btw.placeholder")}
          value={draft}
          onChangeText={onDraft}
          onKeyPress={isWeb ? handleComposerKeyPress : undefined}
          multiline
          style={styles.input}
          editable={!pending}
        />
        <View style={styles.actions}>
          <Button testID="btw-send" disabled={!canAsk} loading={pending} onPress={ask}>
            {t("btw.send")}
          </Button>
          {thread ? (
            <>
              {thread.status === "running" ? (
                <Button testID="btw-stop" variant="outline" disabled={pending} onPress={abort}>
                  {t("btw.stop")}
                </Button>
              ) : null}
              <Button
                testID="btw-inject"
                variant="ghost"
                disabled={deliveryDisabled}
                onPress={inject}
              >
                {t("btw.inject")}
              </Button>
              <Button
                testID="btw-summarize"
                variant="ghost"
                disabled={deliveryDisabled}
                onPress={summarize}
              >
                {t("btw.summarize")}
              </Button>
              <Button testID="btw-new" variant="ghost" disabled={pending} onPress={newThread}>
                {t("btw.newThread")}
              </Button>
              <Button testID="btw-clear" variant="ghost" disabled={pending} onPress={clear}>
                {t("btw.clear")}
              </Button>
            </>
          ) : null}
        </View>
        <Text
          style={visibleError ? styles.error : styles.feedback}
          testID="btw-action-feedback"
          accessibilityLiveRegion="polite"
        >
          {visibleError ?? feedback ?? " "}
        </Text>
      </View>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  content: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  empty: {
    padding: theme.spacing[3],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.content,
  },
  timeline: { flex: 1, minHeight: 0 },
  footer: { padding: theme.spacing[3], gap: theme.spacing[2] },
  input: {
    minHeight: 44,
    maxHeight: 100,
    padding: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
  },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[1] },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
  },
  feedback: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
