import type { ProviderSubagentRow, SubagentRow } from "./select";

export interface SubagentTreeRow {
  row: SubagentRow;
  /** 0 for the owner's direct children. */
  depth: number;
  /** Present when the row has visible children and is within the depth cap. */
  disclosure?: { expanded: boolean };
  /** Descendant count shown as "N more" when the depth cap hides children. */
  hiddenDescendantCount: number;
}

export interface LayoutSubagentTreeParams {
  rows: readonly SubagentRow[];
  /** Subagent id → user override, projected from descriptor keys for this host and agent. */
  expansion: ReadonlyMap<string, boolean>;
  ownerSubagentId: string | null;
  maxDepth: number;
}

export const SUBAGENT_TREE_MAX_DEPTH = 3;

interface PendingTreeRow {
  row: SubagentRow;
  depth: number;
}

interface SubtreeSummary {
  count: number;
  running: boolean;
}

function providerChildren(
  params: LayoutSubagentTreeParams,
): Map<string | null, ProviderSubagentRow[]> {
  const providers = new Map<string, ProviderSubagentRow>();
  for (const row of params.rows) {
    if (row.kind === "provider" && row.id !== params.ownerSubagentId) providers.set(row.id, row);
  }
  const sortedProviders = [...providers.values()];
  sortedProviders.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  const parents = new Map<string, string | null>();
  for (const row of sortedProviders) {
    const hasParent = row.parentSubagentId !== null && providers.has(row.parentSubagentId);
    parents.set(row.id, hasParent ? row.parentSubagentId : null);
  }
  breakParentCycles(parents);

  const children = new Map<string | null, ProviderSubagentRow[]>();
  for (const row of sortedProviders) {
    const parent = parents.get(row.id) ?? null;
    const siblings = children.get(parent) ?? [];
    siblings.push(row);
    children.set(parent, siblings);
  }
  return children;
}

export function layoutSubagentTree(params: LayoutSubagentTreeParams): SubagentTreeRow[] {
  const children = providerChildren(params);
  const summaries = summarizeSubtrees(children);
  const roots = mergeRoots(params.rows, children.get(null) ?? []);
  const rootEntries: PendingTreeRow[] = roots.map((row) => ({ row, depth: 0 }));
  const pending = rootEntries.toReversed();
  const laidOut: SubagentTreeRow[] = [];
  while (pending.length > 0) {
    const next = pending.pop();
    if (!next) break;
    const { row, depth } = next;
    const descendants = row.kind === "provider" ? (children.get(row.id) ?? []) : [];
    const summary = row.kind === "provider" ? summaries.get(row.id) : undefined;
    const atCap = depth + 1 >= params.maxDepth;
    const hasChildren = descendants.length > 0;
    const expanded =
      params.expansion.get(row.id) ?? descendants.some((child) => summaries.get(child.id)?.running);
    const treeRow: SubagentTreeRow = { row, depth, hiddenDescendantCount: 0 };
    if (hasChildren && atCap) treeRow.hiddenDescendantCount = (summary?.count ?? 1) - 1;
    if (hasChildren && !atCap) treeRow.disclosure = { expanded };
    laidOut.push(treeRow);
    if (!expanded || atCap) continue;
    for (const child of descendants.toReversed()) pending.push({ row: child, depth: depth + 1 });
  }
  return laidOut;
}

function breakParentCycles(parents: Map<string, string | null>): void {
  const visited = new Set<string>();
  for (const id of parents.keys()) {
    const path = new Set<string>();
    let current: string | null = id;
    while (current !== null && !visited.has(current)) {
      path.add(current);
      const parent: string | null = parents.get(current) ?? null;
      if (parent !== null && path.has(parent)) {
        parents.set(current, null);
        break;
      }
      current = parent;
    }
    for (const ancestor of path) visited.add(ancestor);
  }
}

function summarizeSubtrees(
  children: ReadonlyMap<string | null, readonly ProviderSubagentRow[]>,
): Map<string, SubtreeSummary> {
  const ordered: ProviderSubagentRow[] = [];
  const pending = [...(children.get(null) ?? [])];
  while (pending.length > 0) {
    const row = pending.pop();
    if (!row) break;
    ordered.push(row);
    pending.push(...(children.get(row.id) ?? []));
  }
  const summaries = new Map<string, SubtreeSummary>();
  for (const row of ordered.toReversed()) {
    let count = 1;
    let running = row.status === "running";
    for (const child of children.get(row.id) ?? []) {
      const summary = summaries.get(child.id);
      count += summary?.count ?? 0;
      running ||= summary?.running ?? false;
    }
    summaries.set(row.id, { count, running });
  }
  return summaries;
}

function mergeRoots(
  rows: readonly SubagentRow[],
  providerRoots: readonly ProviderSubagentRow[],
): SubagentRow[] {
  const roots: SubagentRow[] = [];
  const pending = [...providerRoots];
  for (const row of rows) {
    if (row.kind !== "paseo") continue;
    while (pending[0] && pending[0].createdAt.getTime() < row.createdAt.getTime()) {
      const provider = pending.shift();
      if (provider) roots.push(provider);
    }
    roots.push(row);
  }
  roots.push(...pending);
  return roots;
}
