import { useMutation } from "@tanstack/react-query";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import { useCallback, useMemo, type RefObject } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Minus } from "lucide-react-native";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import { AgentStreamView, type AgentStreamViewHandle } from "@/agent-stream/view";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
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
import type { Theme } from "@/styles/theme";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem } from "@/types/stream";
import { BtwPill } from "./pill";
import type { BtwCommand } from "./send";

const iconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedMinus = withUnistyles(Minus);
const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();
const EMPTY_ITEMS: StreamItem[] = [];
export interface BtwContentProps {
  serverId: string;
  agentId: string;
  thread: ProviderSubagentDescriptorPayload;
  streamViewRef: RefObject<AgentStreamViewHandle | null>;
  onUserScrollIntent(): void;
  compact: boolean;
  draft: string;
  onDraft(text: string): void;
  onHide(): void;
  onCommand(command: BtwCommand): void;
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
export function BtwWindowContent({
  serverId,
  agentId,
  thread,
  streamViewRef,
  onUserScrollIntent,
  compact,
  draft,
  onDraft,
  onHide,
  onCommand,
  pending,
  feedback,
  error,
}: BtwContentProps) {
  const { t } = useTranslation();
  const key = providerSubagentKey(serverId, agentId, thread.id);
  const timeline = useProviderSubagentStore((state) => state.timelines.get(key));
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const older = useMutation({
    mutationFn: () =>
      client
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
  const visibleError = error ?? older.error?.message ?? null;
  const parent = useSessionStore(
    (state) =>
      state.sessions[serverId]?.agents.get(agentId) ??
      state.sessions[serverId]?.agentDetails.get(agentId),
  );
  const streamId = `provider:${encodeURIComponent(agentId)}:${encodeURIComponent(thread.id)}`;
  const context = useMemo<AgentScreenAgent>(
    () => ({
      serverId,
      id: streamId,
      provider: thread.provider,
      status: providerSubagentLifecycleStatus(thread.status),
      cwd: parent?.cwd ?? "",
      workspaceId: parent?.workspaceId,
      projectPlacement: parent?.projectPlacement,
    }),
    [serverId, streamId, thread.provider, thread.status, parent],
  );
  const turnPresentation = useMemo<TurnPresentation>(
    () => ({
      isActive: thread.status === "running",
      isCancelling: false,
      startedAt: null,
      turnId: null,
    }),
    [thread.status],
  );
  const deliveryDisabled = !canDeliverToMain({ pending, status: thread.status, timeline });
  const ask = useCallback(() => onCommand({ kind: "ask", text: draft }), [draft, onCommand]);
  const abort = useCallback(() => onCommand({ kind: "abort" }), [onCommand]);
  const inject = useCallback(() => onCommand({ kind: "inject" }), [onCommand]);
  const summarize = useCallback(() => onCommand({ kind: "summarize" }), [onCommand]);
  const newThread = useCallback(() => onCommand({ kind: "new" }), [onCommand]);
  const clear = useCallback(() => onCommand({ kind: "clear" }), [onCommand]);
  return (
    <View style={styles.content} testID="btw-window" accessibilityLabel={thread.id}>
      <View style={styles.header}>
        {compact ? (
          <BtwPill serverId={serverId} agentId={agentId} header />
        ) : (
          <Text style={styles.title}>{t("btw.title")}</Text>
        )}
        <Text style={styles.question} numberOfLines={1}>
          {thread.title}
        </Text>
        <ToolbarButton label={t("btw.minimize")} testID="btw-minimize" onPress={onHide}>
          <ThemedMinus size={18} uniProps={iconColor} />
        </ToolbarButton>
      </View>
      <Text style={styles.subtitle} testID="btw-subtitle">
        {thread.subtitle}
      </Text>
      <View style={styles.timeline}>
        <AgentStreamView
          ref={streamViewRef}
          onUserScrollIntent={onUserScrollIntent}
          agentId={streamId}
          serverId={serverId}
          context={context}
          streamItems={timeline?.tail ?? EMPTY_ITEMS}
          streamHead={timeline?.head ?? EMPTY_ITEMS}
          turnPresentation={turnPresentation}
          pendingPermissions={EMPTY_PERMISSIONS}
          isAuthoritativeHistoryReady
          readOnly
          reserveTurnFooterSpace={!!timeline && timeline.tail.length + timeline.head.length > 0}
          historyPagination={historyPagination}
        />
      </View>
      {thread.status === "failed" ? (
        <Text style={styles.error} testID="btw-provider-error">
          {thread.description}
        </Text>
      ) : null}
      <View style={styles.footer}>
        <SheetAwareTextInput
          testID="btw-composer"
          accessibilityLabel={t("btw.placeholder")}
          placeholder={t("btw.placeholder")}
          value={draft}
          onChangeText={onDraft}
          multiline
          style={styles.input}
          editable={!pending}
        />
        <View style={styles.actions}>
          <Button
            testID="btw-send"
            disabled={pending || !draft.trim()}
            loading={pending}
            onPress={ask}
          >
            {t("btw.send")}
          </Button>
          {thread.status === "running" ? (
            <Button testID="btw-stop" variant="outline" disabled={pending} onPress={abort}>
              {t("btw.stop")}
            </Button>
          ) : null}
          <Button testID="btw-inject" variant="ghost" disabled={deliveryDisabled} onPress={inject}>
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
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  question: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
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
