import { basename } from "node:path";
import { NativeSessionForkError } from "../../agent-sdk-types.js";
import type { PiTranscript } from "./transcript.js";
import type {
  PiModel,
  PiPromptAck,
  PiRpcSlashCommand,
  PiRuntimeEvent,
  PiSessionState,
  PiSessionStats,
} from "./rpc-types.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";

export interface PiRuntimeLaunch {
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
  protocolMode?: "rpc" | "rpc-ui";
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  session?: string;
  noSession?: boolean;
  mcpConfigPath?: string;
  extensionPaths?: string[];
  extraArgs?: string[];
}

export interface PiStartSessionInput {
  isolateForkHelper?: boolean;
  cwd: string;
  signal?: AbortSignal;
  env?: Record<string, string>;
  protocolMode?: "rpc" | "rpc-ui";
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  session?: string;
  noSession?: boolean;
  mcpConfigPath?: string;
  extensionPaths?: string[];
  extraArgs?: string[];
}

export interface PiRuntimeSession {
  readonly environment: Record<string, string>;
  onEvent(callback: (event: PiRuntimeEvent) => void): () => void;
  prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<PiPromptAck>;
  steer(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void>;
  clearQueue(): Promise<void>;
  compact(customInstructions?: string): Promise<void>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<PiSessionState>;
  getHistory(): Promise<PiTranscript>;
  getAvailableModels(timeoutMs?: number | null): Promise<PiModel[]>;
  setModel(provider: string, modelId: string): Promise<PiModel>;
  setThinkingLevel(level: string): Promise<void>;
  getSessionStats(): Promise<PiSessionStats>;
  getCommands(): Promise<PiRpcSlashCommand[]>;
  request(
    command: { type: string; [key: string]: unknown },
    timeoutMs?: number | null,
  ): Promise<unknown>;
  sendRawFrame(frame: object & { type: string }): void;
  respondToExtensionUiRequest(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): void;
  cancelExtensionUiRequest(id: string): void;
  close(): Promise<void>;
}

export interface PiRuntime {
  startSession(input: PiStartSessionInput): Promise<PiRuntimeSession>;
}

export function buildPiLaunch(input: {
  command: [string, ...string[]];
  runtimeSettings?: ProviderRuntimeSettings;
  session: PiStartSessionInput;
}): PiRuntimeLaunch {
  const command =
    input.runtimeSettings?.command?.mode === "replace" && input.runtimeSettings.command.argv[0]
      ? input.runtimeSettings.command.argv
      : input.command;
  const argv = input.session.isolateForkHelper ? isolatePiForkCommand(command) : [...command];

  const protocolMode = input.session.protocolMode ?? "rpc";
  appendPiLaunchArgs(argv, input.session, protocolMode);

  return {
    cwd: input.session.cwd,
    argv,
    env:
      input.runtimeSettings?.env || input.session.env
        ? {
            ...input.runtimeSettings?.env,
            ...input.session.env,
          }
        : undefined,
    model: input.session.model,
    thinkingOptionId: input.session.thinkingOptionId,
    protocolMode,
    modeId: input.session.modeId,
    session: input.session.session,
    noSession: input.session.noSession,
    mcpConfigPath: input.session.mcpConfigPath,
    extensionPaths: input.session.extensionPaths,
    extraArgs: input.session.extraArgs,
  };
}

function appendPiLaunchArgs(
  argv: string[],
  session: PiStartSessionInput,
  protocolMode: "rpc" | "rpc-ui",
): void {
  if (!hasModeFlag(argv)) {
    argv.push("--mode", protocolMode);
  }
  if (session.extraArgs?.length) {
    argv.push(...session.extraArgs);
  }
  if (session.model) {
    argv.push("--model", session.model);
  }
  if (session.thinkingOptionId) {
    argv.push("--thinking", session.thinkingOptionId);
  }
  if (session.noSession) {
    argv.push("--no-session");
  } else if (session.session) {
    argv.push("--session", session.session);
  }
  if (session.mcpConfigPath) {
    argv.push("--mcp-config", session.mcpConfigPath);
  }
  for (const extensionPath of session.extensionPaths ?? []) {
    argv.push("--extension", extensionPath);
  }
}

function hasModeFlag(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--mode") {
      return true;
    }
    if (argv[i]?.startsWith("--mode=")) {
      return true;
    }
  }
  return false;
}

const FORK_REMOVE_VALUE_ARGS = new Set([
  "--extension",
  "-e",
  "--session",
  "--session-id",
  "--fork",
  "--model",
  "--provider",
  "--models",
  "--system-prompt",
  "--append-system-prompt",
  "--prompt-template",
  "--skill",
  "--thinking",
  "--name",
  "-n",
  "--mode",
  "--export",
  "--theme",
]);
const FORK_REMOVE_SWITCH_ARGS = new Set([
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--print",
  "-p",
  "--help",
  "-h",
  "--version",
  "-v",
]);
const FORK_KEEP_VALUE_ARGS = new Set([
  "--api-key",
  "--session-dir",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
]);
const FORK_KEEP_SWITCH_ARGS = new Set([
  "--no-session",
  "--no-extensions",
  "-ne",
  "--no-mcp",
  "--no-skills",
  "-ns",
  "--no-prompt-templates",
  "-np",
  "--no-themes",
  "--no-context-files",
  "-nc",
  "--no-tools",
  "-nt",
  "--no-builtin-tools",
  "-nbt",
  "--verbose",
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--offline",
]);

function isolationError(detail: string): never {
  throw new NativeSessionForkError(
    "materialize_failed",
    `Cannot isolate the configured Pi fork worker: ${detail}. Use a command without initial prompts or unknown wrapper options.`,
  );
}

function piCommandPrefixLength(command: readonly string[]): number {
  let index = 1;
  if (basename(command[0] ?? "") === "env") {
    while (index < command.length) {
      const arg = command[index]!;
      if (arg === "--") {
        index += 1;
        break;
      }
      if (arg === "-u" || arg === "--unset") {
        if (!command[index + 1] || command[index + 1]!.startsWith("-"))
          isolationError("env unset option has no variable name");
        index += 2;
        continue;
      }
      if (
        arg === "-i" ||
        arg === "--ignore-environment" ||
        /^--unset=[A-Za-z_][A-Za-z0-9_]*$/.test(arg) ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)
      ) {
        index += 1;
        continue;
      }
      if (arg.startsWith("-")) isolationError("unsupported env option");
      break;
    }
    if (!command[index]) isolationError("env has no executable");
    index += 1;
  }
  const executable = basename(command[index - 1]!);
  if (executable === "node" || executable === "nodejs") {
    const script = command[index];
    if (!script || script.startsWith("-"))
      isolationError("node requires an explicit wrapper script");
    index += 1;
  }
  return index;
}

/** Pi 1.4 parses known options only as separate argv tokens; equals forms are extension flags. */
function isolatePiForkCommand(command: readonly string[]): string[] {
  const prefix = piCommandPrefixLength(command);
  const isolated = command.slice(0, prefix);
  for (let index = prefix; index < command.length; index += 1) {
    const arg = command[index]!;
    if (arg === "--") {
      if (index !== command.length - 1) isolationError("positional input follows --");
      break;
    }
    if (FORK_REMOVE_VALUE_ARGS.has(arg) || FORK_KEEP_VALUE_ARGS.has(arg)) {
      const value = command[++index];
      if (!value || value.startsWith("-")) isolationError(`${arg} requires one separate value`);
      if (FORK_KEEP_VALUE_ARGS.has(arg)) isolated.push(arg, value);
      continue;
    }
    if (FORK_REMOVE_SWITCH_ARGS.has(arg)) continue;
    if (FORK_KEEP_SWITCH_ARGS.has(arg)) {
      isolated.push(arg);
      continue;
    }
    // Unknown options may belong to opaque wrappers; consuming their values would guess ownership.
    isolationError(
      arg.startsWith("-") ? `unsupported option ${arg.split("=")[0]}` : "positional input",
    );
  }
  return isolated;
}
