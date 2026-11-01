export const daemonConfigQueryRoot = ["daemon-config"] as const;

export function daemonConfigQueryKey(serverId: string | null) {
  return [...daemonConfigQueryRoot, serverId] as const;
}
