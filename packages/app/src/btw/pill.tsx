import { useCallback } from "react";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Text, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { ComposerTrackMark } from "@/composer/tracks";
import { composerPillStyles } from "@/composer/pill-styles";
import { usePaneFocus } from "@/panels/pane-context";
import { useBtwThread } from "./select";
import { btwWindowKey, useBtwWindowStore } from "./window-store";

const PANE_FOCUS_EXEMPT = { "paseo-pane-focus-exempt": "true" };

export function BtwPill({
  serverId,
  agentId,
  header = false,
}: {
  serverId: string;
  agentId: string;
  header?: boolean;
}) {
  const { t } = useTranslation();
  const thread = useBtwThread(serverId, agentId);
  const key = btwWindowKey(serverId, agentId, thread?.id ?? "");
  const { isPaneFocused, focusPane } = usePaneFocus();
  const mode = useBtwWindowStore((state) => state.byThread[key]);
  const open = mode === "open" && (header || isPaneFocused);
  const setMode = useBtwWindowStore((state) => state.setMode);
  const onPress = useCallback(() => {
    if (!header) focusPane();
    setMode(key, open ? "minimized" : "open");
  }, [focusPane, header, key, open, setMode]);
  const style = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      composerPillStyles.body,
      (open || pressed) && composerPillStyles.bodyActive,
    ],
    [open],
  );
  if (!thread) return null;
  const bucket = thread.status === "running" ? "running" : null;
  return (
    <PressHighlight
      testID={header ? "btw-sheet-chip" : "btw-chip"}
      accessibilityRole="button"
      // SplitPane's capture listener must leave focus to this button until activation.
      dataSet={PANE_FOCUS_EXEMPT}
      accessibilityLabel={t(open ? "btw.hide" : "btw.show")}
      aria-expanded={open}
      onPress={onPress}
      style={style}
      highlightStyle={composerPillStyles.bodyActive}
    >
      <ComposerTrackMark bucket={bucket} />
      <Text style={composerPillStyles.label}>{t("btw.label")}</Text>
    </PressHighlight>
  );
}
