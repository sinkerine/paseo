import { useCallback } from "react";
import { Text, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ComposerTrackMark } from "@/composer/tracks";
import { composerPillStyles } from "@/composer/pill-styles";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useBtwThread } from "./select";
import { selectBtwTab, toggleBtwTab } from "./tab";

const PANE_FOCUS_EXEMPT = { "paseo-pane-focus-exempt": "true" };
export function BtwPill({
  serverId,
  workspaceId,
  agentId,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
}) {
  const { t } = useTranslation();
  const thread = useBtwThread(serverId, agentId);
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const open = useWorkspaceLayoutStore((state) =>
    workspaceKey ? selectBtwTab(state, workspaceKey, agentId)?.visible === true : false,
  );
  const onPress = useCallback(
    () => toggleBtwTab({ workspaceKey, agentId }),
    [workspaceKey, agentId],
  );
  const style = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      composerPillStyles.body,
      (open || pressed) && composerPillStyles.bodyActive,
    ],
    [open],
  );
  if (!thread) return null;
  return (
    <PressHighlight
      testID="btw-chip"
      accessibilityRole="button"
      dataSet={PANE_FOCUS_EXEMPT}
      accessibilityLabel={t(open ? "btw.hide" : "btw.show")}
      aria-expanded={open}
      onPress={onPress}
      style={style}
      highlightStyle={composerPillStyles.bodyActive}
    >
      <ComposerTrackMark bucket={thread.status === "running" ? "running" : null} />
      <Text style={composerPillStyles.label}>{t("btw.label")}</Text>
    </PressHighlight>
  );
}
