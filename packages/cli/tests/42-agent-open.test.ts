#!/usr/bin/env npx tsx

import assert from "node:assert";
import { createHostClient } from "@getpaseo/client/node";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runPaseoCli, startTestDaemon } from "./helpers/test-daemon.ts";

console.log("=== Agent Open Command Tests ===\n");

if (process.platform !== "linux") {
  console.log("Skipped: the fake Desktop app is a Linux AppImage path.");
  process.exit(0);
}

const daemon = await startTestDaemon({ env: { PASEO_NODE_ENV: "development" } });

// runPaseoCli sets HOME to the daemon's home, where the CLI looks for
// ~/Applications/Paseo.AppImage on Linux. The fake app records its launch.
const launchRecord = join(daemon.paseoHome, "desktop-launches.txt");
const fakeDesktop = join(daemon.paseoHome, "Applications", "Paseo.AppImage");
await mkdir(join(daemon.paseoHome, "Applications"), { recursive: true });
await writeFile(fakeDesktop, `#!/bin/sh\necho "$@" >> "${launchRecord}"\n`);
await chmod(fakeDesktop, 0o755);

async function waitForLaunches(count: number): Promise<string[]> {
  let launches: string[] = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    launches = (await readFile(launchRecord, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean);
    if (launches.length === count) return launches;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return launches;
}

try {
  for (const focusArgs of [[], ["--no-focus"], ["--focus"]]) {
    console.log(`Unknown agent ${focusArgs.join(" ")} fails without opening Desktop`);
    const result = await runPaseoCli(daemon, [
      "agent",
      "open",
      "does-not-exist",
      ...focusArgs,
      "--host",
      `127.0.0.1:${daemon.port}`,
      "--json",
    ]);
    assert.notStrictEqual(result.exitCode, 0);
    assert.strictEqual(JSON.parse(result.stderr).error.code, "AGENT_NOT_FOUND");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(existsSync(launchRecord), false, "missing agent must never launch Desktop");
  }
  const client = createHostClient(`127.0.0.1:${daemon.port}`, {
    clientId: "agent-open-integration",
    clientType: "cli",
    reconnect: { enabled: false },
  });
  await client.connect();
  try {
    const created = await client.createWorkspace({
      source: { kind: "directory", path: daemon.workDir },
    });
    assert.ok(created.workspace, created.error ?? "workspace creation failed");
    const agent = await client.createAgent({
      provider: "mock",
      model: "e2e-fast-stream",
      modeId: "load-test",
      cwd: daemon.workDir,
      workspaceId: created.workspace.id,
      title: "Open focus target",
    });
    const serverId = client.getLastServerInfoMessage()!.serverId;
    const cases = [
      { args: [], env: {}, focus: true },
      { args: [], env: { PASEO_AGENT_ID: agent.id }, focus: false },
      { args: [], env: { PASEO_AGENT_ID: "missing-caller" }, focus: true },
      { args: [], env: { PASEO_WORKSPACE_ID: created.workspace.id }, focus: true },
      { args: ["--no-focus"], env: {}, focus: false },
      { args: ["--focus"], env: { PASEO_AGENT_ID: agent.id }, focus: true },
      { args: ["--server", serverId], env: { PASEO_AGENT_ID: "offline-caller" }, focus: false },
    ];
    let expectedLaunches = 0;
    for (const entry of cases) {
      const result = await runPaseoCli(
        daemon,
        ["agent", "open", agent.id, ...entry.args, "--host", `127.0.0.1:${daemon.port}`, "--json"],
        { env: entry.env },
      );
      assert.strictEqual(result.exitCode, 0, result.stderr);
      assert.deepStrictEqual(JSON.parse(result.stdout), {
        agentId: agent.id,
        serverId,
        status: "opened",
      });
      expectedLaunches++;
      const launches = await waitForLaunches(expectedLaunches);
      assert.strictEqual(launches.length, expectedLaunches);
      assert.strictEqual(
        launches.at(-1),
        `paseo://h/${serverId}/agent/${agent.id}${entry.focus ? "" : "?focus=0"}`,
      );
      console.log(
        `✓ ${entry.args.join(" ") || "default"} ${JSON.stringify(entry.env)} focus=${entry.focus}`,
      );
    }
    await client.removeProject(created.workspace.projectId);
  } finally {
    await client.close();
  }
} finally {
  await daemon.stop();
}

console.log("=== All agent open tests passed ===");
