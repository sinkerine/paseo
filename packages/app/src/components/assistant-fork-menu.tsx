import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Split } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ICON_SIZE, type Theme } from "@/styles/theme";

export type AssistantForkTarget = "tab" | "workspace";

interface AssistantForkMenuProps {
  onCopyChat: (target: AssistantForkTarget) => Promise<void> | void;
  onForkSession?: () => Promise<void>;
  forkSessionDisabledReason?: string;
  testID?: string;
}

const ThemedSplit = withUnistyles(Split);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export const AssistantForkMenu = memo(function AssistantForkMenu({
  onCopyChat,
  onForkSession,
  forkSessionDisabledReason,
  testID = "assistant-fork-menu",
}: AssistantForkMenuProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<AssistantForkTarget | "session" | null>(null);
  const isLocked = pendingTarget !== null;
  const pending = useRef(false);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && pendingTarget !== null) return;
      setIsOpen(next);
    },
    [pendingTarget],
  );

  const handleSelect = useCallback(
    (target: AssistantForkTarget | "session") => async () => {
      if (pending.current) return;
      if (target === "session" && forkSessionDisabledReason) return;
      pending.current = true;
      setPendingTarget(target);
      try {
        if (target === "session") await onForkSession?.();
        else await onCopyChat(target);
      } finally {
        pending.current = false;
        setPendingTarget(null);
        setIsOpen(false);
      }
    },
    [onCopyChat, onForkSession, forkSessionDisabledReason],
  );

  const triggerStyle = useCallback(
    () => [styles.trigger, isLocked ? styles.triggerDisabled : null],
    [isLocked],
  );

  const tooltipContent = useMemo(
    () => (
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{t("message.actions.forkMenu")}</Text>
      </TooltipContent>
    ),
    [t],
  );

  const forkIcon = useMemo(
    () => <ThemedSplit size={ICON_SIZE.sm} uniProps={foregroundColorMapping} />,
    [],
  );

  return (
    <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
      <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <View style={styles.triggerSlot} collapsable={false}>
            <DropdownMenuTrigger
              accessibilityLabel={t("message.actions.forkMenu")}
              accessibilityRole="button"
              disabled={isLocked}
              style={triggerStyle}
              testID={`${testID}-trigger`}
            >
              {({ hovered, open }) => (
                <ThemedSplit
                  size={ICON_SIZE.sm}
                  uniProps={hovered || open ? foregroundColorMapping : foregroundMutedColorMapping}
                />
              )}
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        {tooltipContent}
      </Tooltip>
      <DropdownMenuContent align="start" minWidth={220} side="bottom" testID={`${testID}-content`}>
        {onForkSession ? (
          <>
            <DropdownMenuLabel>{t("message.actions.forkSessionSection")}</DropdownMenuLabel>
            <DropdownMenuItem
              closeOnSelect={false}
              disabled={isLocked || Boolean(forkSessionDisabledReason)}
              tooltip={forkSessionDisabledReason}
              leading={forkIcon}
              onSelect={handleSelect("session")}
              status={pendingTarget === "session" ? "pending" : undefined}
              testID={`${testID}-fork-session`}
            >
              {t("message.actions.forkSessionFromHere")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuLabel>{t("message.actions.copyChatSection")}</DropdownMenuLabel>
        <DropdownMenuItem
          closeOnSelect={false}
          disabled={isLocked}
          leading={forkIcon}
          onSelect={handleSelect("tab")}
          status={pendingTarget === "tab" ? "pending" : undefined}
          testID={`${testID}-new-tab`}
        >
          {t("message.actions.copyChatToNewTab")}
        </DropdownMenuItem>
        <DropdownMenuItem
          closeOnSelect={false}
          disabled={isLocked}
          leading={forkIcon}
          onSelect={handleSelect("workspace")}
          status={pendingTarget === "workspace" ? "pending" : undefined}
          testID={`${testID}-new-workspace`}
        >
          {t("message.actions.copyChatToNewWorkspace")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const styles = StyleSheet.create((theme) => ({
  trigger: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  triggerDisabled: {
    opacity: theme.opacity[50],
  },
  triggerSlot: {
    alignSelf: "center",
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
