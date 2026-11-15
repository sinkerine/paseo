import type { Command } from "commander";
import { resolveCallerAgentId } from "../../utils/caller-agent.js";
import { connectToDaemon } from "../../utils/client.js";
import type { AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";
import { openDesktopWithAgent } from "../open.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

interface OpenAgentResult {
  agentId: string;
  serverId: string;
  status: "opened";
}

const openAgentSchema: OutputSchema<OpenAgentResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "SERVER ID", field: "serverId" },
    { header: "STATUS", field: "status" },
  ],
};

export interface OpenAgentCommandOptions extends CommandOptions {
  server?: string;
  focus?: boolean;
}

export function resolveOpenFocusMode(input: {
  explicitFocus: boolean | undefined;
  hasCallerAgent: boolean;
}): boolean {
  return input.explicitFocus !== undefined ? input.explicitFocus : !input.hasCallerAgent;
}

export function addOpenOptions(command: Command): Command {
  return command
    .description("Open an existing agent in Paseo Desktop")
    .argument("<agent-id>", "Existing agent ID")
    .option("--server <server-id>", "Server ID (defaults to the local daemon)")
    .option("--focus", "Focus Paseo Desktop and switch to the agent tab")
    .option(
      "--no-focus",
      "Open the agent tab without focusing a window or switching the active tab",
    );
}

function toOpenError(err: unknown): CommandError {
  if (err && typeof err === "object" && "code" in err) {
    return err as CommandError;
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "OPEN_FAILED", message: `Failed to open agent: ${message}` };
}

async function resolveAgentTarget(
  agentId: string,
  options: OpenAgentCommandOptions,
): Promise<AgentDeepLinkTarget> {
  const env = process.env;
  const withFocus = (target: AgentDeepLinkTarget, hasCallerAgent: boolean): AgentDeepLinkTarget =>
    resolveOpenFocusMode({ explicitFocus: options.focus, hasCallerAgent })
      ? target
      : { ...target, focus: false };
  const explicitServerId = typeof options.server === "string" ? options.server.trim() : "";
  if (explicitServerId) {
    return withFocus({ serverId: explicitServerId, agentId }, Boolean(env.PASEO_AGENT_ID?.trim()));
  }

  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const serverId = client.getLastServerInfoMessage()?.serverId.trim();
    if (!serverId) {
      const error: CommandError = {
        code: "SERVER_ID_UNAVAILABLE",
        message: "The daemon did not report a server ID.",
      };
      throw error;
    }

    const [fetchResult, callerAgentId] = await Promise.all([
      client.fetchAgent({ agentId }),
      resolveCallerAgentId(client, env),
    ]);
    if (!fetchResult) {
      const error: CommandError = {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentId}`,
        details: 'Use "paseo ls" to list available agents',
      };
      throw error;
    }
    return withFocus({ serverId, agentId: fetchResult.agent.id }, Boolean(callerAgentId));
  } catch (err) {
    throw toOpenError(err);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runOpenCommand(
  agentIdArg: string,
  options: OpenAgentCommandOptions,
  _command: Command,
): Promise<SingleResult<OpenAgentResult>> {
  const agentId = agentIdArg.trim();
  if (!agentId) {
    const error: CommandError = {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required.",
    };
    throw error;
  }

  const target = await resolveAgentTarget(agentId, options);
  await openDesktopWithAgent(target);

  return {
    type: "single",
    data: { agentId: target.agentId, serverId: target.serverId, status: "opened" },
    schema: openAgentSchema,
  };
}
