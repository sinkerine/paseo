import { readFile, stat } from "node:fs/promises";
import type { Command } from "commander";
import { importProjectIconFromUrl } from "@getpaseo/client/project-icon";
import type { ProjectIconSource } from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions } from "../../output/index.js";

export async function projectIconSource(source: string): Promise<ProjectIconSource> {
  if (/^https?:\/\//i.test(source)) {
    return importProjectIconFromUrl(source, (input, init) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
    );
  }
  const metadata = await stat(source);
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > 512 * 1024) {
    throw new Error("Icon must be a nonempty image file of 512 KB or smaller.");
  }
  const bytes = await readFile(source);
  if (bytes.length > 512 * 1024) throw new Error("Icon must be 512 KB or smaller.");
  return { type: "upload", data: bytes.toString("base64") };
}

function output(data: Record<string, unknown>) {
  return {
    type: "single" as const,
    data,
    schema: {
      idField: () => String(data.projectId),
      columns: [],
      renderHuman: () => JSON.stringify(data, null, 2),
    },
  };
}

export async function runProjectIcon(
  projectId: string,
  source: string | undefined,
  operation: "get" | "set" | "reset",
  options: CommandOptions,
) {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.projectCustomIcon !== true) {
      throw new Error(
        "This host does not support custom project icons. Update the host and retry.",
      );
    }
    if (operation === "get") {
      const result = await client.getProjectIcon(projectId);
      if (result.error) throw new Error(result.error);
      return output({ projectId, icon: result.icon });
    }
    let icon: ProjectIconSource = { type: "automatic" };
    if (operation === "set") {
      if (!source) throw new Error("Provide an image file or website/image URL.");
      icon = await projectIconSource(source);
    }
    await client.setProjectIcon(projectId, icon);
    return output({ projectId, status: operation === "reset" ? "automatic" : "saved" });
  } finally {
    await client.close();
  }
}

export async function runIconGetCommand(
  projectId: string,
  options: CommandOptions,
  _command: Command,
) {
  return runProjectIcon(projectId, undefined, "get", options);
}
export async function runIconSetCommand(
  projectId: string,
  source: string,
  options: CommandOptions,
  _command: Command,
) {
  return runProjectIcon(projectId, source, "set", options);
}
export async function runIconResetCommand(
  projectId: string,
  options: CommandOptions,
  _command: Command,
) {
  return runProjectIcon(projectId, undefined, "reset", options);
}
