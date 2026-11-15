import { describe, expect, it } from "vitest";
import {
  buildAgentDeepLink,
  buildAgentDeepLinkRoute,
  parseAgentDeepLink,
} from "./agent-deep-link.js";

describe("agent deep links", () => {
  it("round-trips an existing agent target", () => {
    const target = { serverId: "server/main", agentId: "agent 123" };

    const link = buildAgentDeepLink(target);

    expect(link).toBe("paseo://h/server%2Fmain/agent/agent%20123");
    expect(buildAgentDeepLinkRoute(target)).toBe("/h/server%2Fmain/agent/agent%20123");
    expect(parseAgentDeepLink(link)).toEqual(target);
  });

  it("round-trips a non-focusing target without changing the route", () => {
    const target = { serverId: "server/main", agentId: "agent 123", focus: false };
    expect(buildAgentDeepLink(target)).toBe("paseo://h/server%2Fmain/agent/agent%20123?focus=0");
    expect(buildAgentDeepLinkRoute(target)).toBe("/h/server%2Fmain/agent/agent%20123");
    expect(parseAgentDeepLink(buildAgentDeepLink(target))).toEqual(target);
    expect(parseAgentDeepLink(buildAgentDeepLink({ ...target, focus: true }))).toEqual({
      serverId: target.serverId,
      agentId: target.agentId,
    });
  });

  it.each([
    "?focus=1",
    "?focus=false",
    "?focus=0&focus=0",
    "?focus=0&x=1",
    "?%66ocus=0",
    "?focus=0#hash",
    "#hash",
    "#",
    "?focus=0#",
  ])("rejects unsupported suffix %s", (suffix) => {
    expect(parseAgentDeepLink(`paseo://h/server/agent/agent-1${suffix}`)).toBeNull();
  });

  it("rejects links outside the exact agent route", () => {
    expect(parseAgentDeepLink("https://h/server/agent/agent-1")).toBeNull();
    expect(parseAgentDeepLink("paseo://app/h/server/agent/agent-1")).toBeNull();
    expect(parseAgentDeepLink("paseo://h/server/agent/agent-1?message=hello")).toBeNull();
    expect(parseAgentDeepLink("paseo://h/server/agent/agent-1/extra")).toBeNull();
  });
});
