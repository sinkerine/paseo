import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { startBtwHttpStub } from "./http-stub.js";

const execute = promisify(execFile);
export async function createBtwRuntime(live = false) {
  const piBinary = process.env.PASEO_PI_BINARY;
  const producer = process.env.PASEO_PI_BTW_PACKAGE;
  if (!piBinary || !producer)
    throw new Error(
      "NEEDS_CONTEXT: set PASEO_PI_BINARY and PASEO_PI_BTW_PACKAGE to the G1 receipt revision",
    );
  const inherited = Object.keys(process.env).filter(
    (key) =>
      key.startsWith("PI_") &&
      key !== "PI_CODING_AGENT_DIR" &&
      key !== "PI_SKIP_VERSION_CHECK" &&
      key !== "PI_TELEMETRY" &&
      key !== "PI_CACHE_RETENTION",
  );
  const command = ["env", ...inherited.flatMap((key) => ["-u", key]), piBinary];
  const version = await execute(command[0], [...command.slice(1), "--version"]);
  if (version.stdout.trim() !== "1.4.0")
    throw new Error("NEEDS_CONTEXT: BTW verification requires Pi 1.4.0");
  const revision = (await execute("git", ["-C", producer, "rev-parse", "HEAD"])).stdout.trim();
  const root = await mkdtemp(path.join(tmpdir(), "paseo-btw-"));
  const piAgent = path.join(root, "pi-agent");
  const events = path.join(root, "thread-events.jsonl");
  const gate = path.join(root, "parent-gate");
  const stub = live ? null : await startBtwHttpStub();
  try {
    await mkdir(piAgent, { mode: 0o700 });
    const monitor = path.join(root, "monitor.mjs");
    await writeFile(
      monitor,
      `import { appendFileSync } from "node:fs";\nexport default function(pi) { pi.events.on("pi-btw:thread", event => appendFileSync(${JSON.stringify(events)}, JSON.stringify(event) + "\\n")); }\n`,
    );
    let defaults: Record<string, unknown> = {};
    if (live) {
      const source = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi/agent");
      for (const name of ["models.json", "auth.json"]) {
        await copyOptionalConfig(path.join(source, name), path.join(piAgent, name));
      }
      const settings = JSON.parse(await readFile(path.join(source, "settings.json"), "utf8"));
      defaults = {
        defaultProvider: settings.defaultProvider,
        defaultModel: settings.defaultModel,
        defaultThinkingLevel: settings.defaultThinkingLevel,
      };
    } else {
      if (!stub) throw new Error("Missing deterministic HTTP fixture");
      defaults = {
        defaultProvider: "paseo-btw",
        defaultModel: "stub",
        defaultThinkingLevel: "off",
      };
      await writeFile(
        path.join(piAgent, "models.json"),
        JSON.stringify({
          providers: {
            "paseo-btw": {
              baseUrl: stub.url,
              apiKey: "local-fixture",
              api: "openai-completions",
              models: [
                {
                  id: "stub",
                  name: "BTW HTTP fixture",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 200000,
                  maxTokens: 4096,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  compat: { sendSessionAffinityHeaders: true, supportsLongCacheRetention: true },
                },
              ],
            },
          },
        }),
      );
    }
    await writeFile(
      path.join(piAgent, "settings.json"),
      JSON.stringify({
        ...defaults,
        packages: [producer],
        extensions: [monitor],
        cacheWarming: { enabled: false },
      }),
    );
    const environment = {
      PI_CODING_AGENT_DIR: piAgent,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PI_CACHE_RETENTION: "long",
    };
    return {
      root,
      piAgent,
      gate,
      events,
      stub,
      revision,
      piBinary,
      model: live ? undefined : "paseo-btw/stub",
      environment,
      daemonConfig: {
        version: 1,
        agents: { idleRuntimeCleanup: false, providers: { pi: { command, env: environment } } },
      },
      async close() {
        await stub?.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stub?.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
export type BtwRuntime = Awaited<ReturnType<typeof createBtwRuntime>>;

async function copyOptionalConfig(source: string, destination: string): Promise<void> {
  try {
    await copyFile(source, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
