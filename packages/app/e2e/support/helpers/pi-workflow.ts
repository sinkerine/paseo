import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";
import { launchAgent, type AgentHandle } from "./rewind-flow";
import { submitMessageWithButton } from "./composer";

const execute = promisify(execFile);
const fixture = path.resolve(
  __dirname,
  "../../../../server/src/server/daemon-e2e/fixtures/pi-scripted-workflow",
);

export interface PiWorkflowRuntime {
  root: string;
  gate: string;
  daemonConfig: Record<string, unknown>;
  environment: Record<string, string>;
  close(): Promise<void>;
}

export async function createPiWorkflowRuntime(): Promise<PiWorkflowRuntime> {
  const piBinary =
    process.env.PASEO_PI_BINARY ??
    "/nix/store/c4r897xqjdxf7z2ck7l1gm6ii06r7mlg-pi-coding-agent-1.0.4/bin/pi";
  const subagentsPackage =
    process.env.PASEO_PI_SUBAGENTS_PACKAGE ??
    "/nix/store/4ia9lbk20dlh7friq4w824siwzfpnyg0-pi-subagents-0.71.0/lib/node_modules/pi-subagents";
  // Inherited Pi child context can redirect the historical binary to the active runtime.
  const preserved = new Set([
    "PI_SKIP_VERSION_CHECK",
    "PI_TELEMETRY",
    "PI_GOAL_QUOTA_URL",
    "PI_CODING_AGENT_DIR",
    "PI_SUBAGENTS_TEMP_ROOT",
  ]);
  const inherited = Object.keys(process.env).filter(
    (key) => key.startsWith("PI_") && !preserved.has(key),
  );
  const command = ["env", ...inherited.flatMap((key) => ["-u", key]), piBinary];
  const version = await execute("env", [...command.slice(1), "--version"]);
  expect(version.stdout.trim(), "NEEDS_CONTEXT: scripted fixture requires Pi 1.0.4").toBe("1.0.4");
  const metadata = JSON.parse(await readFile(path.join(subagentsPackage, "package.json"), "utf8"));
  expect(metadata.version, "NEEDS_CONTEXT: scripted fixture requires pi-subagents 0.71.0").toBe(
    "0.71.0",
  );
  const root = await mkdtemp(path.join(tmpdir(), "paseo-pi-workflow-browser-"));
  const piAgent = path.join(root, "pi-agent");
  const subagentsTmp = path.join(root, "subagents-tmp");
  const gate = path.join(root, "gate");
  try {
    await mkdir(piAgent);
    await mkdir(subagentsTmp);
    await cp(path.join(fixture, "agents"), path.join(piAgent, "agents"), { recursive: true });
    const settings = (await readFile(path.join(fixture, "settings.json"), "utf8"))
      .replace('"__PI_SUBAGENTS_PACKAGE__"', () => JSON.stringify(subagentsPackage))
      .replace('"__SCRIPTED_WORKFLOW_PACKAGE__"', () => JSON.stringify(fixture));
    await writeFile(path.join(piAgent, "settings.json"), settings);
    const environment = {
      PATH: `${path.dirname(piBinary)}${path.delimiter}${process.env.PATH}`,
      PI_CODING_AGENT_DIR: piAgent,
      PI_SUBAGENTS_TEMP_ROOT: subagentsTmp,
      PASEO_SCRIPTED_GATE: gate,
    };
    return {
      root,
      gate,
      environment,
      daemonConfig: {
        version: 1,
        agents: { idleRuntimeCleanup: false, providers: { pi: { command, env: environment } } },
      },
      async close() {
        const { stdout } = await execute("ps", ["-eo", "pid=,args="]);
        const leftovers = stdout.split("\n").filter((line) => line.includes(root));
        for (const line of leftovers) {
          const match = /^\s*(\d+)\s+/.exec(line);
          if (!match) throw new Error(`Unparseable isolated process: ${line}`);
          try {
            process.kill(Number(match[1]), "SIGKILL");
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
          }
        }
        await rm(root, { recursive: true, force: true });
        expect(leftovers, "Isolated Pi processes must stop with the worker daemon").toEqual([]);
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function launchPiWorkflow(
  page: Page,
  runtime: PiWorkflowRuntime,
): Promise<AgentHandle> {
  const cwd = await mkdtemp(path.join(runtime.root, "work-"));
  const handle = await launchAgent({
    page,
    cwd,
    provider: "pi",
    mode: "full-access",
    providerConfig: { model: "paseo-scripted/workflow" },
  });
  await submitMessageWithButton(page, "RUN_WORKFLOW");
  await expect(page.getByTestId("user-message").filter({ hasText: "RUN_WORKFLOW" })).toBeVisible();
  return handle;
}

export async function releasePiWorkflow(runtime: PiWorkflowRuntime): Promise<void> {
  await writeFile(runtime.gate, "open\n");
}
