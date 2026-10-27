import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import {
  AppConfigEndpointSchema,
  AppConfigResponseSchema,
  type AppConfigRequest,
} from "@getpaseo/protocol/app-config";
import { withOutput, type CommandOptions } from "../../output/index.js";

export function desktopUserDataPath(): string {
  const override = process.env.PASEO_ELECTRON_USER_DATA_DIR?.trim();
  if (override) return path.resolve(override);
  if (process.platform === "darwin")
    return path.join(homedir(), "Library", "Application Support", "Paseo");
  if (process.platform === "win32")
    return path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "Paseo");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "Paseo");
}

export async function requestAppConfig(
  request: AppConfigRequest,
  userDataPath: string,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path.join(userDataPath, "app-config-endpoint.json"), "utf8");
  } catch (error) {
    throw new Error(
      `Cannot find the desktop configuration endpoint in ${userDataPath}. Start an updated Paseo Desktop app, or select --user-data <path>.`,
      { cause: error },
    );
  }
  const endpoint = AppConfigEndpointSchema.parse(JSON.parse(raw));
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${endpoint.port}/config`, {
      method: "POST",
      headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
  } catch (error) {
    throw new Error(
      "Cannot reach Paseo Desktop. Open the app and retry. If an edit timed out, read the preference before retrying.",
      { cause: error },
    );
  }
  const result = AppConfigResponseSchema.parse(await response.json());
  if (!result.ok) throw new Error(result.error);
  if (!response.ok) throw new Error(`Desktop configuration request failed (${response.status}).`);
  return result.data;
}

async function run(request: AppConfigRequest, options: CommandOptions) {
  const userDataPath =
    typeof options.userData === "string" ? path.resolve(options.userData) : desktopUserDataPath();
  const data = await requestAppConfig(request, userDataPath);
  return {
    type: "single" as const,
    data,
    schema: {
      idField: () => "app-config",
      columns: [],
      renderHuman: () => JSON.stringify(data, null, 2),
    },
  };
}

export function createAppCommand(): Command {
  const app = new Command("app").description("Configure the running local desktop app");
  const config = app
    .command("config")
    .description("Read and edit app preferences and keyboard shortcuts");
  function options(command: Command): Command {
    return command
      .option("--user-data <path>", "Desktop user data directory")
      .option("--json", "Output JSON");
  }
  options(config.command("get [path]")).action(
    withOutput(async (field: string | undefined, opts: CommandOptions, _command: Command) =>
      run({ operation: "get", path: field }, opts),
    ),
  );
  options(config.command("set <path> <value>"))
    .option("--string", "Interpret the value literally as a string")
    .action(
      withOutput(async (field: string, raw: string, opts: CommandOptions, _command: Command) => {
        let value: unknown = raw;
        if (!opts.string) {
          try {
            value = JSON.parse(raw);
          } catch {
            /* Unquoted values are strings. */
          }
        }
        return run({ operation: "set", path: field, value }, opts);
      }),
    );
  options(config.command("unset <path>")).action(
    withOutput(async (field: string, opts: CommandOptions, _command: Command) =>
      run({ operation: "unset", path: field }, opts),
    ),
  );
  options(
    config
      .command("shortcuts")
      .description("List shortcut IDs, defaults, overrides, and effective bindings"),
  ).action(
    withOutput(async (opts: CommandOptions, _command: Command) =>
      run({ operation: "shortcuts" }, opts),
    ),
  );
  config.addHelpText(
    "after",
    `
Examples:
  paseo app config get
  paseo app config get settings.theme
  paseo app config set settings.theme dark
  paseo app config set settings.openInSidePane.chatFiles true
  paseo app config shortcuts
  paseo app config set shortcuts.workspace-new-cmd-n-mac 'Mod+Shift+N'
  paseo app config set shortcuts.workspace-new-cmd-n-mac null
  paseo app config unset shortcuts.workspace-new-cmd-n-mac

Paths start with settings or shortcuts. Arrays are replaced as whole JSON values.
Set a shortcut to null to unassign it; unset restores its default.
Targets the local desktop app, independently of daemon --home/--host selectors.
`,
  );
  return app;
}
