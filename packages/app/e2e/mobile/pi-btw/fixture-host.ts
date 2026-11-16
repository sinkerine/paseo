import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createBtwRuntime } from "../../../../server/src/server/daemon-e2e/fixtures/pi-btw-stub/runtime";
import { startIsolatedHostDaemon } from "../../support/helpers/isolated-host-daemon";
import { connectDaemonClient } from "../../support/helpers/daemon-client-loader";

async function main() {
  const destination = process.argv[2];
  if (!destination) throw new Error("Usage: fixture-host.ts <fixture.json>");
  if (process.env.AGENT_JOB_ACTIVE !== "1")
    throw new Error("Native fixture requires owning Android E2E admission");
  const stopped = new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
  const runtime = await createBtwRuntime(false);
  try {
    const serverId = `btw-native-${randomUUID()}`;
    const daemon = await startIsolatedHostDaemon(serverId, {
      config: runtime.daemonConfig,
      environment: { ...runtime.environment, NODE_ENV: "development" },
    });
    try {
      const client = await connectDaemonClient<DaemonClient>({
        clientIdPrefix: "btw-native",
        port: daemon.port,
      });
      try {
        const cwd = await mkdtemp(path.join(runtime.root, "workspace-"));
        const created = await client.createWorkspace({ source: { kind: "directory", path: cwd } });
        if (!created.workspace)
          throw new Error(created.error ?? "Failed to create fixture workspace");
        const agent = await client.createAgent({
          provider: "pi",
          model: runtime.model,
          cwd,
          workspaceId: created.workspace.id,
          title: "BTW native fixture",
        });
        await client.sendAgentMessage(agent.id, "PARENT_A", { messageId: "" });
        await client.waitForFinish(agent.id, 60000);
        await client.sendAgentMessage(agent.id, "/btw NATIVE_BASELINE", { messageId: "" });
        await waitForCompletedBtw(client, agent.id);
        await writeFile(
          destination,
          JSON.stringify(
            {
              serverId,
              port: daemon.port,
              agentId: agent.id,
              workspaceId: created.workspace.id,
              paseoHome: daemon.paseoHome,
              revision: runtime.revision,
            },
            null,
            2,
          ),
        );
        await stopped;
      } finally {
        runtime.stub?.release("btw");
        runtime.stub?.release("parent");
        await client.close();
      }
    } finally {
      await daemon.close();
    }
  } finally {
    await runtime.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});

async function waitForCompletedBtw(client: DaemonClient, agentId: string) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const rows = await client.listProviderSubagents(agentId);
    const thread = rows.subagents.find((row) => row.presentation === "side_conversation");
    if (thread?.status === "completed") return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Fixture BTW thread did not complete");
}
