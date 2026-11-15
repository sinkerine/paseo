import type { z } from "zod";
import type { PersistStorage, StateStorage } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { WorkspaceLayoutPersistedStateSchema } from "./workspace-layout-storage";

export const WORKSPACE_LAYOUT_PERSIST_VERSION = 2;
export type WorkspaceLayoutPersistedState = z.infer<typeof WorkspaceLayoutPersistedStateSchema>;
const slices = [
  "layoutByWorkspace",
  "pinnedAgentIdsByWorkspace",
  "splitSizesByWorkspace",
  "explorerSidebarWidthByWorkspace",
  "explorerPaneIdByWorkspace",
  "sidePaneIdByWorkspace",
  "pullRequestTabAutoOpenedByWorkspace",
] as const;

interface Envelope {
  state: WorkspaceLayoutPersistedState;
  version?: number;
}
function decode(raw: string | null): Envelope | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("state" in value)) return null;
    if (Object.keys(value).some((key) => key !== "state" && key !== "version")) return null;
    const state = WorkspaceLayoutPersistedStateSchema.safeParse(value.state);
    const version = "version" in value ? value.version : undefined;
    if (
      !state.success ||
      (version !== undefined &&
        (typeof version !== "number" || !Number.isInteger(version) || version < 0))
    )
      return null;
    return { state: state.data, version };
  } catch {
    return null;
  }
}
function workspaceKeys(state: WorkspaceLayoutPersistedState): Set<string> {
  return new Set(slices.flatMap((slice) => Object.keys(state[slice] ?? {})));
}

function sameWorkspace(
  a: WorkspaceLayoutPersistedState,
  b: WorkspaceLayoutPersistedState,
  key: string,
): boolean {
  return slices.every(
    (slice) => JSON.stringify(a[slice]?.[key]) === JSON.stringify(b[slice]?.[key]),
  );
}
function replaceWorkspace(
  state: WorkspaceLayoutPersistedState,
  source: WorkspaceLayoutPersistedState,
  key: string,
): WorkspaceLayoutPersistedState {
  const next = { ...state };
  for (const slice of slices) {
    const values: Record<string, unknown> = { ...state[slice] };
    const value = source[slice]?.[key];
    if (value === undefined) delete values[key];
    else values[key] = value;
    Object.assign(next, { [slice]: values });
  }
  return next;
}

export function createWorkspaceLayoutPersistStorage(
  backingStorage: StateStorage,
): PersistStorage<WorkspaceLayoutPersistedState> & {
  setHydratedBaseline(state: WorkspaceLayoutPersistedState): void;
  setWorkspaceBaseline(key: string, state: WorkspaceLayoutPersistedState): void;
  syncWorkspace(
    name: string,
    key: string,
    current: () => WorkspaceLayoutPersistedState,
    accept: (state: WorkspaceLayoutPersistedState) => void,
  ): Promise<void>;
} {
  let baseline: WorkspaceLayoutPersistedState = { layoutByWorkspace: {} };
  let pending: Promise<void> | null = null;
  let revision = 0;
  const mergedStorage: StateStorage = {
    getItem(name) {
      const accept = (raw: string | null) => {
        baseline = decode(raw)?.state ?? { layoutByWorkspace: {} };
        return raw;
      };
      const raw = backingStorage.getItem(name);
      return raw instanceof Promise ? raw.then(accept) : accept(raw);
    },
    setItem(name, raw) {
      revision++;
      // The validated adapter has already accepted this window's projection.
      const projection = decode(raw)!;
      const commit = (): void | Promise<void> => {
        const merge = (latestRaw: string | null): void | Promise<void> => {
          const latest = decode(latestRaw);
          let envelope = projection;
          if (latest?.version === WORKSPACE_LAYOUT_PERSIST_VERSION) {
            const currentKeys = workspaceKeys(projection.state);
            const previousKeys = workspaceKeys(baseline);
            const changed = [...currentKeys].filter((key) =>
              slices.some(
                (slice) =>
                  JSON.stringify(projection.state[slice]?.[key]) !==
                  JSON.stringify(baseline[slice]?.[key]),
              ),
            );
            const purged = [...previousKeys].filter((key) => !currentKeys.has(key));
            const state = { ...latest.state };
            for (const slice of slices) {
              const values: Record<string, unknown> = { ...latest.state[slice] };
              for (const key of [...changed, ...purged]) {
                const value = projection.state[slice]?.[key];
                if (value === undefined) delete values[key];
                else values[key] = value;
              }
              Object.assign(state, { [slice]: values });
            }
            envelope = { state, version: projection.version };
          }
          const written = backingStorage.setItem(name, JSON.stringify(envelope));
          if (written instanceof Promise)
            return written.then(() => {
              baseline = projection.state;
              return undefined;
            });
          baseline = projection.state;
        };
        const latest = backingStorage.getItem(name);
        return latest instanceof Promise ? latest.then(merge) : merge(latest);
      };
      const result = pending ? pending.then(commit, commit) : commit();
      if (result instanceof Promise) {
        pending = result;
        const clear = () => {
          if (pending === result) pending = null;
        };
        void result.then(clear, clear);
      }
      return result;
    },
    removeItem(name) {
      baseline = { layoutByWorkspace: {} };
      return backingStorage.removeItem(name);
    },
  };
  return {
    ...createValidatedPersistStorage(mergedStorage, WorkspaceLayoutPersistedStateSchema, {
      skipUnchanged: true,
    }),
    async syncWorkspace(name, key, current, accept) {
      // A read must observe all this window's writes. If another write starts while reading,
      // retry behind it instead of applying a snapshot that predates the local mutation.
      for (;;) {
        if (pending) await pending.catch(() => undefined);
        const before = revision;
        const latest = decode(await backingStorage.getItem(name));
        if (before !== revision) continue;
        if (latest?.version !== WORKSPACE_LAYOUT_PERSIST_VERSION) return;
        if (!sameWorkspace(WorkspaceLayoutPersistedStateSchema.parse(current()), baseline, key))
          return;
        if (!sameWorkspace(latest.state, baseline, key)) accept(latest.state);
        return;
      }
    },
    setWorkspaceBaseline(key, state) {
      baseline = replaceWorkspace(baseline, WorkspaceLayoutPersistedStateSchema.parse(state), key);
    },
    // Hydration restores focus and derives explorer keys before the window can edit a layout.
    setHydratedBaseline(state) {
      baseline = WorkspaceLayoutPersistedStateSchema.parse(state);
    },
  };
}
