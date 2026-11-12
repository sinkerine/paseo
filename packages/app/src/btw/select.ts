import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import { useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import equal from "fast-deep-equal";
import { useProviderSubagentStore } from "@/subagents/provider-store";

interface PresentationRow {
  presentation?: string | null;
}
export function selectBtwThread<T extends PresentationRow>(rows: readonly T[]): T | null {
  return rows.find((row) => row.presentation === "side_conversation") ?? null;
}
export function useBtwThread(serverId: string, agentId: string) {
  const select = useMemo(() => {
    let descriptors: ReturnType<typeof useProviderSubagentStore.getState>["descriptors"] | null =
      null;
    let thread: ProviderSubagentDescriptorPayload | null = null;
    const prefix = `${serverId}\0${agentId}\0`;
    return (state: ReturnType<typeof useProviderSubagentStore.getState>) => {
      if (descriptors === state.descriptors) return thread;
      descriptors = state.descriptors;
      thread = null;
      for (const [key, descriptor] of descriptors) {
        if (key.startsWith(prefix) && descriptor.presentation === "side_conversation") {
          thread = descriptor;
          break;
        }
      }
      return thread;
    };
  }, [serverId, agentId]);
  return useStoreWithEqualityFn(useProviderSubagentStore, select, equal);
}
