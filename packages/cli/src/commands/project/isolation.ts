import type { Command } from "commander";
import type { ProjectIsolation } from "@getpaseo/protocol/messages";
import type {
  CommandError,
  CommandOptions,
  SingleResult,
  OutputSchema,
} from "../../output/index.js";
import { buildDaemonConnectionCommandError, connectToDaemon } from "../../utils/client.js";

export type ProjectIsolationCommandIntent =
  | { kind: "get" }
  | { kind: "set"; defaultIsolation: ProjectIsolation | null };

interface ProjectIsolationResult {
  projectId: string;
  defaultIsolation: ProjectIsolation | null;
}

const schema: OutputSchema<ProjectIsolationResult> = {
  idField: "projectId",
  columns: [
    { header: "PROJECT ID", field: "projectId", width: 20 },
    { header: "ISOLATION", field: (row) => row.defaultIsolation ?? "-", width: 12 },
  ],
};

export function resolveProjectIsolationIntent(input: {
  isolation?: string;
  reset?: boolean;
}): ProjectIsolationCommandIntent {
  if (input.reset && input.isolation !== undefined) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--reset cannot be combined with an isolation value",
    } satisfies CommandError;
  }
  if (input.reset) return { kind: "set", defaultIsolation: null };
  if (input.isolation === undefined) return { kind: "get" };
  if (input.isolation === "local" || input.isolation === "worktree") {
    return { kind: "set", defaultIsolation: input.isolation };
  }
  throw {
    code: "INVALID_OPTIONS",
    message: "Isolation must be local or worktree",
  } satisfies CommandError;
}

export async function runIsolationCommand(
  projectId: string,
  isolation: string | undefined,
  options: CommandOptions & { reset?: boolean },
  _command: Command,
): Promise<SingleResult<ProjectIsolationResult>> {
  const intent = resolveProjectIsolationIntent({ isolation, reset: options.reset });
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    throw buildDaemonConnectionCommandError({ target: options.daemonTarget, error });
  });
  try {
    if (intent.kind === "set") {
      const applied = await client.setProjectIsolation(projectId, intent.defaultIsolation);
      return { type: "single", data: { projectId, ...applied }, schema };
    }
    const { projects } = await client.listProjects();
    const project = projects.find((entry) => entry.projectId === projectId);
    if (!project)
      throw { code: "PROJECT_NOT_FOUND", message: "Project not found" } satisfies CommandError;
    return {
      type: "single",
      data: { projectId, defaultIsolation: project.projectDefaultIsolation ?? null },
      schema,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
