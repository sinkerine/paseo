export interface AgentDeepLinkTarget {
  serverId: string;
  agentId: string;
  focus?: boolean;
}

function normalizeSegment(value: string): string {
  return value.trim();
}

function normalizeAgentDeepLinkTarget(target: AgentDeepLinkTarget): AgentDeepLinkTarget {
  const serverId = normalizeSegment(target.serverId);
  const agentId = normalizeSegment(target.agentId);
  if (!serverId || !agentId) {
    throw new Error("Agent deep links require a server ID and agent ID.");
  }
  return { serverId, agentId };
}

export function buildAgentDeepLinkRoute(
  target: Pick<AgentDeepLinkTarget, "serverId" | "agentId">,
): `/h/${string}/agent/${string}` {
  const { serverId, agentId } = normalizeAgentDeepLinkTarget(target);
  return `/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}`;
}

export function buildAgentDeepLink(target: AgentDeepLinkTarget): string {
  return `paseo:/${buildAgentDeepLinkRoute(target)}${target.focus === false ? "?focus=0" : ""}`;
}

export function parseAgentDeepLink(input: string): AgentDeepLinkTarget | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (
    url.protocol !== "paseo:" ||
    url.hostname !== "h" ||
    url.username ||
    url.password ||
    url.port ||
    (url.search !== "" && url.search !== "?focus=0") ||
    input.includes("#")
  ) {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 3 || segments[1] !== "agent") {
    return null;
  }

  try {
    const serverId = normalizeSegment(decodeURIComponent(segments[0] ?? ""));
    const agentId = normalizeSegment(decodeURIComponent(segments[2] ?? ""));
    return serverId && agentId
      ? { serverId, agentId, ...(url.search === "?focus=0" ? { focus: false } : {}) }
      : null;
  } catch {
    return null;
  }
}
