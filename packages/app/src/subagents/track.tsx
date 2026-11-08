import type { AgentAddress } from "@getpaseo/protocol/addresses";
import { useHosts } from "@/runtime/host-runtime";
import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Archive, ChevronRight, Unlink } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useProviderIcon } from "@/components/provider-icons";
import { TREE_INDENT_PER_LEVEL } from "@/components/tree-primitives";
import { ComposerTrackActions, ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { mutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import {
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import type { Theme } from "@/styles/theme";
import { useAgentFactsLine } from "@/panels/agent-facts-line";
import { getPanelManifest } from "@/panels/panel-manifest";
import type { ProviderSubagentRow, SubagentRow } from "./select";
import type { SubagentTreeRow } from "./tree";
import { useSheetPanePage } from "@/screens/workspace/sheet-pane";
import type { SheetTab } from "@/stores/workspace-layout-store";
import type { ArchiveFinishedStatus } from "./use-archive-finished";
import {
  buildSubagentPillPresentation,
  buildSubagentRowPresentationData,
  countFinishedSubagents,
} from "./track-presentation";

const ThemedArchive = withUnistyles(Archive);
const ThemedUnlink = withUnistyles(Unlink);
const ThemedChevronRight = withUnistyles(ChevronRight);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export interface SubagentsTrackProps {
  serverId: string;
  rows: SubagentRow[];
  treeRows: SubagentTreeRow[];
  onToggleExpansion: (row: ProviderSubagentRow, expanded: boolean) => void;
  onOpenSubagent: (address: AgentAddress) => void;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  /**
   * The sheet a row opens, or null when it opens as a tab. A sheet replaces the list in place and
   * Back returns to it; a tab replaces the list's pane, so choosing it ends the list.
   */
  sheetTabFor: (row: SubagentRow) => SheetTab | null;
  onArchiveSubagent: (address: AgentAddress) => void;
  onArchiveFinished?: () => void;
  archiveFinishedStatus?: ArchiveFinishedStatus;
  onDetachSubagent?: (address: AgentAddress) => void;
}

const IDLE_ARCHIVE_FINISHED_STATUS: ArchiveFinishedStatus = { kind: "idle" };

const ROW_ICON_SIZE = 14;

function useRowPresentation(row: SubagentRow, serverId: string): WorkspaceTabPresentation {
  const icon = useProviderIcon(row.provider, serverId);
  const data = buildSubagentRowPresentationData(row);
  return {
    ...data,
    tooltip: data.label,
    modified: false,
    showCloseButton: getPanelManifest(data.kind).showCloseButton,
    icon,
  };
}

export function SubagentsTrack({
  serverId,
  rows,
  treeRows,
  onToggleExpansion,
  onOpenSubagent,
  onOpenProviderSubagent,
  sheetTabFor,
  onArchiveSubagent,
  onArchiveFinished,
  archiveFinishedStatus = IDLE_ARCHIVE_FINISHED_STATUS,
  onDetachSubagent,
}: SubagentsTrackProps): ReactElement | null {
  const { t } = useTranslation();
  const sheetPanePage = useSheetPanePage();

  const isArchivingFinished = archiveFinishedStatus.kind === "archiving";
  const isArchiveFinishedFailed = archiveFinishedStatus.kind === "failed";
  if (treeRows.length === 0 && !isArchivingFinished && !isArchiveFinishedFailed) {
    return null;
  }

  const pill = buildSubagentPillPresentation(t, rows);
  // Malformed trees can contain only promoted orphans, with no direct children to count.
  const segments = rows.length > 0 ? pill.segments : [{ bucket: null, text: t("subagents.title") }];
  const accessibilityLabel = rows.length > 0 ? pill.accessibilityLabel : t("subagents.title");
  const finishedCount = countFinishedSubagents(rows);
  const showArchiveFinished = finishedCount > 0 || isArchivingFinished || isArchiveFinishedFailed;
  const sheets = treeRows.map(({ row }) => sheetTabFor(row));
  const pages = sheets.flatMap((sheet) => (sheet ? [sheetPanePage(sheet)] : []));

  return (
    <ComposerTrackPill
      pages={pages}
      testID="subagents-track-header"
      segments={segments}
      accessibilityLabel={accessibilityLabel}
      panelTitle={t("subagents.title")}
    >
      {showArchiveFinished && onArchiveFinished ? (
        <ComposerTrackActions divided={rows.length > 0}>
          <ArchiveFinishedRow
            status={archiveFinishedStatus}
            disabled={isArchivingFinished}
            onPress={onArchiveFinished}
          />
        </ComposerTrackActions>
      ) : null}
      <SubagentTreeRows
        serverId={serverId}
        treeRows={treeRows}
        onToggleExpansion={onToggleExpansion}
        onOpenSubagent={onOpenSubagent}
        onOpenProviderSubagent={onOpenProviderSubagent}
        sheetTabFor={sheetTabFor}
        onArchiveSubagent={onArchiveSubagent}
        onDetachSubagent={onDetachSubagent}
      />
    </ComposerTrackPill>
  );
}

export type SubagentTreeRowsProps = Pick<
  SubagentsTrackProps,
  | "serverId"
  | "treeRows"
  | "onToggleExpansion"
  | "onOpenSubagent"
  | "onOpenProviderSubagent"
  | "sheetTabFor"
  | "onArchiveSubagent"
  | "onDetachSubagent"
>;

export function SubagentTreeRows({
  serverId,
  treeRows,
  onToggleExpansion,
  onOpenSubagent,
  onOpenProviderSubagent,
  sheetTabFor,
  onArchiveSubagent,
  onDetachSubagent,
}: SubagentTreeRowsProps): ReactElement {
  return (
    <>
      {treeRows.map((treeRow) => (
        <SubagentsTrackRow
          key={
            treeRow.row.kind === "paseo"
              ? `${treeRow.row.address.serverId}:${treeRow.row.id}`
              : treeRow.row.id
          }
          treeRow={treeRow}
          onToggleExpansion={onToggleExpansion}
          serverId={serverId}
          onOpenSubagent={onOpenSubagent}
          onOpenProviderSubagent={onOpenProviderSubagent}
          sheetTabId={sheetTabFor(treeRow.row)?.tab.tabId ?? null}
          onArchiveSubagent={onArchiveSubagent}
          onDetachSubagent={onDetachSubagent}
        />
      ))}
    </>
  );
}

/**
 * Bulk archive, as a row above the list rather than an icon next to the count. The pill has no
 * header to hang an icon off, and a destructive-ish action reads better with its name attached.
 */
function ArchiveFinishedRow({
  status,
  disabled,
  onPress,
}: {
  status: ArchiveFinishedStatus;
  disabled: boolean;
  onPress: () => void;
}): ReactElement {
  const { t } = useTranslation();

  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <ThemedArchive
          size={ROW_ICON_SIZE}
          uniProps={active ? foregroundColorMapping : foregroundMutedColorMapping}
        />
        <Text style={styles.rowLabel} numberOfLines={1}>
          {t("subagents.archiveFinishedAction")}
        </Text>
        {status.kind === "archiving" ? (
          <Text style={styles.rowTrailing} testID="subagents-track-archive-progress">
            {status.completedCount}/{status.totalCount}
          </Text>
        ) : null}
        {status.kind === "failed" ? (
          <Text style={styles.rowTrailing} testID="subagents-track-archive-failed">
            {t("subagents.archiveFinishedRetry", {
              failed: status.failedCount,
              total: status.totalCount,
            })}
          </Text>
        ) : null}
      </>
    ),
    [status, t],
  );

  return (
    <ComposerTrackRow
      accessibilityLabel={t("subagents.archiveFinishedAction")}
      testID="subagents-track-archive-finished"
      disabled={disabled}
      // Progress and the retry count land on this row, so the panel is where the result of
      // pressing it shows up. Dismissing would hide the thing the press produces.
      closeOnSelect={false}
      onPress={onPress}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

interface SubagentsTrackRowProps {
  serverId: string;
  treeRow: SubagentTreeRow;
  onToggleExpansion: (row: ProviderSubagentRow, expanded: boolean) => void;
  onOpenSubagent: (address: AgentAddress) => void;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  /** The sheet page the row opens in place of the list, when it opens in a sheet. */
  sheetTabId: string | null;
  onArchiveSubagent: (address: AgentAddress) => void;
  onDetachSubagent?: (address: AgentAddress) => void;
}

function SubagentsTrackRow({
  serverId,
  treeRow,
  onToggleExpansion,
  onOpenSubagent,
  onOpenProviderSubagent,
  sheetTabId,
  onArchiveSubagent,
  onDetachSubagent,
}: SubagentsTrackRowProps): ReactElement {
  const { t } = useTranslation();
  const { row, depth, disclosure, hiddenDescendantCount } = treeRow;
  const isCompact = useIsCompactFormFactor();
  const rowServerId = row.kind === "paseo" ? row.address.serverId : serverId;
  const hostLabel = useHosts().find((host) => host.serverId === rowServerId)?.label ?? rowServerId;
  const presentation = useRowPresentation(row, rowServerId);
  const displayLabel =
    presentation.titleState === "loading" ? t("common.states.loading") : presentation.label;
  const handlePress = useCallback(() => {
    if (row.kind === "provider") {
      onOpenProviderSubagent(row.parentAgentId, row.id);
    } else {
      onOpenSubagent(row.address);
    }
  }, [onOpenProviderSubagent, onOpenSubagent, row]);
  const handleArchivePress = useCallback(() => {
    if (row.kind === "paseo") onArchiveSubagent(row.address);
  }, [onArchiveSubagent, row]);
  const handleDetachPress = useCallback(() => {
    if (row.kind === "paseo") onDetachSubagent?.(row.address);
  }, [onDetachSubagent, row]);
  const handleToggleExpansion = useCallback(() => {
    if (row.kind === "provider" && disclosure) {
      onToggleExpansion(row, !disclosure.expanded);
    }
  }, [disclosure, onToggleExpansion, row]);
  const actionsAlwaysVisible = isNative || isCompact;
  const disclosureLabel = disclosure?.expanded
    ? t("subagents.collapseRow")
    : t("subagents.expandRow");
  const renderDisclosure = useCallback(() => {
    if (!disclosure) return null;
    return (
      <ToolbarButton
        label={disclosureLabel}
        tooltipSide="top"
        compact={isCompact}
        onPress={handleToggleExpansion}
        testID={`subagents-track-disclosure-${row.id}`}
      >
        <ThemedChevronRight
          size={paneContentToolbarIconSize(isCompact)}
          uniProps={mutedIconColorMapping}
          style={disclosure.expanded ? styles.chevronExpanded : styles.chevronCollapsed}
        />
      </ToolbarButton>
    );
  }, [disclosure, disclosureLabel, handleToggleExpansion, isCompact, row.id]);

  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <WorkspaceTabIcon presentation={presentation} backdrop={active ? "surface2" : "surface1"} />
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {displayLabel}
          </Text>
          {row.kind === "paseo" ? (
            <>
              <SubagentFacts rowId={row.id} text={rowServerId !== serverId ? hostLabel : ""} />
              <PaseoSubagentFacts serverId={rowServerId} agentId={row.id} />
            </>
          ) : (
            <SubagentFacts rowId={row.id} text={presentation.subtitle} />
          )}
          {hiddenDescendantCount > 0 ? (
            <Text
              style={styles.rowFacts}
              numberOfLines={1}
              testID={`subagents-track-more-${row.id}`}
            >
              {t("subagents.moreDescendants", { count: hiddenDescendantCount })}
            </Text>
          ) : null}
        </View>
        {row.kind === "paseo" ? (
          <SubagentRowActions
            rowId={row.id}
            displayLabel={displayLabel}
            compact={isCompact}
            visible={actionsAlwaysVisible || active}
            onDetachPress={onDetachSubagent ? handleDetachPress : undefined}
            onArchivePress={handleArchivePress}
          />
        ) : null}
      </>
    ),
    [
      actionsAlwaysVisible,
      displayLabel,
      handleArchivePress,
      handleDetachPress,
      hiddenDescendantCount,
      t,
      isCompact,
      onDetachSubagent,
      presentation,
      row.kind,
      row.id,
      serverId,
      rowServerId,
      hostLabel,
    ],
  );

  return (
    <ComposerTrackRow
      accessibilityLabel={displayLabel}
      testID={`subagents-track-row-${row.id}`}
      leadingInset={depth * TREE_INDENT_PER_LEVEL}
      trailing={disclosure ? renderDisclosure : undefined}
      opensPage={sheetTabId ?? undefined}
      onPress={handlePress}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

/** The same facts line the agent's sheet shows when it opens without its composer. */
function PaseoSubagentFacts({ serverId, agentId }: { serverId: string; agentId: string }) {
  const text = useAgentFactsLine(serverId, agentId);
  return <SubagentFacts rowId={agentId} text={text} />;
}

function SubagentFacts({ rowId, text }: { rowId: string; text: string | null }) {
  if (!text) return null;
  return (
    <Text style={styles.rowFacts} numberOfLines={1} testID={`subagents-track-row-facts-${rowId}`}>
      {text}
    </Text>
  );
}

function SubagentRowActions({
  rowId,
  displayLabel,
  compact,
  visible,
  onDetachPress,
  onArchivePress,
}: {
  rowId: string;
  displayLabel: string;
  compact: boolean;
  visible: boolean;
  onDetachPress?: () => void;
  onArchivePress: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const iconSize = paneContentToolbarIconSize(compact);
  return (
    <View
      style={visible ? styles.actionClusterVisible : styles.actionClusterHidden}
      pointerEvents={visible ? "auto" : "none"}
    >
      {onDetachPress ? (
        <SubagentActionButton
          label={t("subagents.detachAction", { label: displayLabel })}
          tooltipLabel={t("subagents.detachTooltip")}
          compact={compact}
          onPress={onDetachPress}
          testID={`subagents-track-detach-${rowId}`}
        >
          <ThemedUnlink size={iconSize} uniProps={mutedIconColorMapping} />
        </SubagentActionButton>
      ) : null}
      <SubagentActionButton
        label={t("subagents.archiveAction", { label: displayLabel })}
        tooltipLabel={t("subagents.archiveTooltip")}
        compact={compact}
        onPress={onArchivePress}
        testID={`subagents-track-archive-${rowId}`}
      >
        <ThemedArchive size={iconSize} uniProps={mutedIconColorMapping} />
      </SubagentActionButton>
    </View>
  );
}

/** The standard icon action, with a tooltip that names the action without repeating the row. */
function SubagentActionButton({
  label,
  tooltipLabel,
  compact,
  onPress,
  testID,
  children,
}: {
  label: string;
  tooltipLabel: string;
  compact: boolean;
  onPress: () => void;
  testID: string;
  children: ReactNode;
}): ReactElement {
  const tooltip = useMemo(
    () => <Text style={styles.tooltipText}>{tooltipLabel}</Text>,
    [tooltipLabel],
  );
  return (
    <ToolbarButton
      label={label}
      tooltip={tooltip}
      tooltipSide="top"
      compact={compact}
      onPress={onPress}
      testID={testID}
    >
      {children}
    </ToolbarButton>
  );
}

const styles = StyleSheet.create((theme) => ({
  // `flexBasis: "auto"` rather than `flex: 1`: a zero-basis label contributes nothing to the row's
  // intrinsic width, so the panel measures itself at its floor and truncates every label at once.
  rowLabel: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  // Title over facts. The facts sit under the title rather than beside it, so a long task name
  // keeps the row's full width and neither line truncates the other.
  rowText: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
  },
  rowTitle: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  rowFacts: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  // Progress on the archive row. It shrinks twice as fast as the label, so a long retry count
  // gives way first instead of squeezing the thing that names the row.
  rowTrailing: {
    flexShrink: 2,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  actionClusterVisible: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 1,
  },
  actionClusterHidden: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 0,
  },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  chevronCollapsed: {
    transform: [{ rotate: "0deg" }],
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
