export interface BtwDiscovery {
  baseline(threadId: string | null): void;
  observe(threadId: string | null): boolean;
}

/** The first successful list is a baseline; later IDs open once for this mounted parent. */
export function createBtwDiscovery(): BtwDiscovery {
  let initialized = false;
  const seen = new Set<string>();
  return {
    baseline(threadId) {
      if (initialized) return;
      if (threadId) seen.add(threadId);
      initialized = true;
    },
    observe(threadId) {
      if (!initialized || !threadId || seen.has(threadId)) return false;
      seen.add(threadId);
      return true;
    },
  };
}
