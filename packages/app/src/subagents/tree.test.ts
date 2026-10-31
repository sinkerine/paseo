import { describe, expect, it } from "vitest";
import type { PaseoSubagentRow, ProviderSubagentRow, SubagentRow } from "./select";
import { layoutSubagentTree, SUBAGENT_TREE_MAX_DEPTH } from "./tree";

function providerRow(
  id: string,
  parentSubagentId: string | null = null,
  overrides: Partial<ProviderSubagentRow> = {},
): ProviderSubagentRow {
  return {
    kind: "provider",
    id,
    parentAgentId: "agent",
    parentSubagentId,
    provider: "pi",
    title: id,
    description: null,
    subtitle: null,
    status: "completed",
    requiresAttention: false,
    createdAt: new Date("2026-10-30T10:00:00Z"),
    ...overrides,
  };
}

function layout(rows: readonly SubagentRow[], expansion: ReadonlyMap<string, boolean> = new Map()) {
  return layoutSubagentTree({
    rows,
    expansion,
    ownerSubagentId: null,
    maxDepth: SUBAGENT_TREE_MAX_DEPTH,
  });
}

describe("layoutSubagentTree", () => {
  it("renders depth-first with provider siblings ordered by creation time", () => {
    const root = providerRow("root");
    const later = providerRow("later", "root", { createdAt: new Date("2026-10-30T10:02:00Z") });
    const earlier = providerRow("earlier", "root", { createdAt: new Date("2026-10-30T10:01:00Z") });
    const leaf = providerRow("leaf", "earlier");
    expect(
      layout(
        [later, root, leaf, earlier],
        new Map([
          ["root", true],
          ["earlier", true],
        ]),
      ),
    ).toEqual([
      { row: root, depth: 0, disclosure: { expanded: true }, hiddenDescendantCount: 0 },
      { row: earlier, depth: 1, disclosure: { expanded: true }, hiddenDescendantCount: 0 },
      { row: leaf, depth: 2, hiddenDescendantCount: 0 },
      { row: later, depth: 1, hiddenDescendantCount: 0 },
    ]);
  });

  it("keeps Paseo rows at depth zero in their input order alongside provider trees", () => {
    const paseo: PaseoSubagentRow = {
      kind: "paseo",
      address: { serverId: "server", agentId: "managed" },
      id: "managed",
      provider: "pi",
      title: "Managed",
      description: null,
      subtitle: null,
      status: "idle",
      turn: { phase: "idle", cancellationRequestId: null },
      requiresAttention: false,
      createdAt: new Date("2026-10-30T10:00:00Z"),
    };
    const first = { ...paseo, id: "first", createdAt: new Date("2026-10-30T10:03:00Z") };
    const second = { ...paseo, id: "second", createdAt: new Date("2026-10-30T09:00:00Z") };
    const root = providerRow("root");
    const child = providerRow("first", "root", { status: "running" });
    expect(
      layout([first, root, child, second]).map(({ row, depth }) => [row.kind, row.id, depth]),
    ).toEqual([
      ["provider", "root", 0],
      ["provider", "first", 1],
      ["paseo", "first", 0],
      ["paseo", "second", 0],
    ]);
  });

  it("preserves flat managed-first order when managed and provider timestamps are equal", () => {
    const managed: PaseoSubagentRow = {
      kind: "paseo",
      address: { serverId: "server", agentId: "managed" },
      id: "managed",
      provider: "pi",
      title: "Managed",
      description: null,
      subtitle: null,
      status: "idle",
      turn: { phase: "idle", cancellationRequestId: null },
      requiresAttention: false,
      createdAt: new Date("2026-10-30T10:00:00Z"),
    };
    const provider = providerRow("provider");
    const rows = [managed, provider];

    expect(layout(rows)).toEqual([
      { row: managed, depth: 0, hiddenDescendantCount: 0 },
      { row: provider, depth: 0, hiddenDescendantCount: 0 },
    ]);
  });

  it("expands only ancestors of running descendants by default", () => {
    const root = providerRow("root", null, { status: "running" });
    const finished = providerRow("finished", "root");
    const finishedLeaf = providerRow("finished-leaf", "finished");
    const active = providerRow("active", "root");
    const runningLeaf = providerRow("running-leaf", "active", { status: "running" });
    expect(layout([root, finished, finishedLeaf, active, runningLeaf])).toEqual([
      { row: root, depth: 0, disclosure: { expanded: true }, hiddenDescendantCount: 0 },
      { row: finished, depth: 1, disclosure: { expanded: false }, hiddenDescendantCount: 0 },
      { row: active, depth: 1, disclosure: { expanded: true }, hiddenDescendantCount: 0 },
      { row: runningLeaf, depth: 2, hiddenDescendantCount: 0 },
    ]);
    expect(layout([root, finished])).toEqual([
      { row: root, depth: 0, disclosure: { expanded: false }, hiddenDescendantCount: 0 },
    ]);
  });

  it("lets explicit collapse and expand override running defaults", () => {
    const root = providerRow("root");
    const running = providerRow("running", "root", { status: "running" });
    expect(layout([root, running], new Map([["root", false]]))).toEqual([
      { row: root, depth: 0, disclosure: { expanded: false }, hiddenDescendantCount: 0 },
    ]);
    const completed = providerRow("completed", "root");
    expect(layout([root, completed], new Map([["root", true]]))).toEqual([
      { row: root, depth: 0, disclosure: { expanded: true }, hiddenDescendantCount: 0 },
      { row: completed, depth: 1, hiddenDescendantCount: 0 },
    ]);
  });

  it("counts every visible descendant beyond the third level without a disclosure", () => {
    const root = providerRow("root");
    const group = providerRow("group", "root");
    const capped = providerRow("capped", "group");
    const hidden = providerRow("hidden", "capped");
    const deeper = providerRow("deeper", "hidden", { status: "running" });
    const sibling = providerRow("sibling", "capped");
    expect(SUBAGENT_TREE_MAX_DEPTH).toBe(3);
    expect(layout([root, group, capped, hidden, deeper, sibling])).toEqual([
      { row: root, depth: 0, disclosure: { expanded: true }, hiddenDescendantCount: 0 },
      { row: group, depth: 1, disclosure: { expanded: true }, hiddenDescendantCount: 0 },
      { row: capped, depth: 2, hiddenDescendantCount: 3 },
    ]);
    expect(
      layoutSubagentTree({
        rows: [root, group, capped],
        expansion: new Map([["root", true]]),
        ownerSubagentId: null,
        maxDepth: 1,
      }),
    ).toEqual([{ row: root, depth: 0, hiddenDescendantCount: 2 }]);
  });

  it("attaches rows with missing parents at depth zero and retains known ancestry", () => {
    const orphan = providerRow("orphan", "missing");
    const child = providerRow("child", "orphan", { status: "running" });
    expect(layout([child, orphan])).toEqual([
      { row: orphan, depth: 0, disclosure: { expanded: true }, hiddenDescendantCount: 0 },
      { row: child, depth: 1, hiddenDescendantCount: 0 },
    ]);
  });

  it("treats children of the provider owner as depth zero and excludes the owner", () => {
    const owner = providerRow("owner", "outside");
    const child = providerRow("child", "owner");
    const leaf = providerRow("leaf", "child", { status: "running" });
    expect(
      layoutSubagentTree({
        rows: [owner, child, leaf],
        expansion: new Map(),
        ownerSubagentId: "owner",
        maxDepth: 3,
      }),
    ).toEqual([
      { row: child, depth: 0, disclosure: { expanded: true }, hiddenDescendantCount: 0 },
      { row: leaf, depth: 1, hiddenDescendantCount: 0 },
    ]);
  });

  it("breaks cycles and renders each provider row once", () => {
    const a = providerRow("a", "b", { status: "running" });
    const b = providerRow("b", "a", { status: "running" });
    const self = providerRow("self", "self");
    expect(layout([a, b, self])).toEqual([
      { row: b, depth: 0, disclosure: { expanded: true }, hiddenDescendantCount: 0 },
      { row: a, depth: 1, hiddenDescendantCount: 0 },
      { row: self, depth: 0, hiddenDescendantCount: 0 },
    ]);
  });

  it("handles an empty track", () => {
    expect(layout([])).toEqual([]);
  });
});
