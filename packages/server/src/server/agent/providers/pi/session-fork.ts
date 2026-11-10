import { readFile, mkdir, mkdtemp, writeFile, link, unlink, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Logger } from "pino";
import type { PiRuntime, PiRuntimeSession } from "./runtime.js";
import { piSessionForkHelperSource } from "./session-fork-helper.js";
import { z } from "zod";
import {
  NativeSessionForkFramingSchema,
  type NativeSessionForkFraming,
} from "../../native-fork-framing.js";
import {
  NativeSessionForkError,
  type AgentPersistenceHandle,
  type NativeSessionForkTarget,
} from "../../agent-sdk-types.js";

export interface PiPathEntry {
  id: string;
  parentId: string | null;
  type: string;
  role?: string;
  text?: string;
}

const headerSchema = z.object({
  type: z.literal("session"),
  id: z.string(),
  version: z.number(),
  cwd: z.string(),
  parentSession: z.string().optional(),
});
const entrySchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  type: z.string(),
  message: z.object({ role: z.string(), content: z.unknown().optional() }).optional(),
});
const textBlocksSchema = z.array(z.object({ type: z.string(), text: z.string().optional() }));

export interface PiSessionPath {
  file: string;
  header: { id: string; version: number; cwd: string; parentSession?: string };
  path: PiPathEntry[];
}

function entryText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim();
  const blocks = textBlocksSchema.safeParse(content);
  if (!blocks.success) return undefined;
  return blocks.data
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
}

export async function readPiSessionPath(
  file: string,
  leafId: string | null,
): Promise<PiSessionPath> {
  const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
  const header = headerSchema.parse(JSON.parse(lines.shift() ?? ""));
  const entries: PiPathEntry[] = [];
  for (const [index, line] of lines.entries()) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      // A running source can be captured while its final JSONL record is being appended.
      if (error instanceof SyntaxError && index === lines.length - 1) break;
      throw error;
    }
    const entry = entrySchema.parse(raw);
    entries.push({
      id: entry.id,
      parentId: entry.parentId,
      type: entry.type,
      ...(entry.message
        ? { role: entry.message.role, text: entryText(entry.message.content) }
        : {}),
    });
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (byId.size !== entries.length)
    throw new NativeSessionForkError("boundary_mismatch", "Duplicate Pi session entry id.");
  let id = leafId ?? entries.at(-1)?.id ?? null;
  const path: PiPathEntry[] = [];
  const seen = new Set<string>();
  while (id !== null) {
    const entry = byId.get(id);
    if (!entry)
      throw new NativeSessionForkError(
        "boundary_not_found",
        `Pi session entry ${id} was not found.`,
      );
    if (seen.has(id))
      throw new NativeSessionForkError("boundary_mismatch", "Cycle in Pi session ancestry.");
    seen.add(id);
    path.push(entry);
    id = entry.parentId;
  }
  path.reverse();
  return {
    file,
    header: {
      id: header.id,
      version: header.version,
      cwd: header.cwd,
      ...(header.parentSession ? { parentSession: header.parentSession } : {}),
    },
    path,
  };
}

export async function readPiForkSource(input: {
  file: string;
  leafId: string | null;
  sessionId: string;
  cwd: string;
}): Promise<PiSessionPath> {
  let source: PiSessionPath;
  try {
    source = await readPiSessionPath(input.file, input.leafId);
  } catch (error) {
    if (error instanceof NativeSessionForkError) throw error;
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    throw new NativeSessionForkError(
      missing ? "boundary_not_found" : "boundary_mismatch",
      missing
        ? "The source Pi session file is unavailable. Restore the file or reopen the source agent, then retry."
        : "The source Pi history could not be read. Verify the session in Pi, then retry.",
    );
  }
  if (source.header.id !== input.sessionId || source.header.cwd !== input.cwd) {
    throw new NativeSessionForkError(
      "boundary_mismatch",
      "The source Pi session identity or directory changed. Reload the source and retry.",
    );
  }
  return source;
}

function resolvePiLeaf(
  path: readonly PiPathEntry[],
  leafEntryId: string | null,
): { targetEntryId: string } {
  const leaf = leafEntryId ?? path.at(-1)?.id;
  if (!leaf || !path.some((entry) => entry.id === leaf)) {
    throw new NativeSessionForkError("boundary_not_found", "The Pi session leaf was not found.");
  }
  return { targetEntryId: leaf };
}

interface PiFramingCoverageInput {
  source: PiSessionPath;
  framing: NativeSessionForkFraming;
  positions: ReadonlyMap<string, number>;
  selected: number;
}

function validateFramingCoverage({
  source,
  framing,
  positions,
  selected,
}: PiFramingCoverageInput): number {
  const path = source.path;
  const start = framing.startEntryId === null ? -1 : positions.get(framing.startEntryId);
  const sourceMatches =
    framing.valid &&
    framing.sourceSessionId === source.header.id &&
    framing.sourceNativeHandle === source.file;
  if (
    !sourceMatches ||
    start === undefined ||
    selected <= start ||
    framing.observedLeafId !== path.at(-1)?.id
  ) {
    throw new NativeSessionForkError(
      "boundary_mismatch",
      "The native run provenance does not cover the active source ancestry.",
    );
  }
  return start;
}

function resolveObservedNextTrigger(
  source: PiSessionPath,
  target: Extract<NativeSessionForkTarget, { kind: "turn" }>,
): number {
  const framing = target.framing!;
  const { path } = source;
  const positions = new Map(path.map((entry, index) => [entry.id, index]));
  const selected = positions.get(target.entryId)!;
  const start = validateFramingCoverage({ source, framing, positions, selected });
  let next = path.findIndex(
    (entry, index) => index > selected && entry.type === "message" && entry.role === "user",
  );
  const seen = new Set<string>();
  const unknown: number[] = [];
  for (const boundary of framing.boundaries) {
    const index = positions.get(boundary.entryId);
    const entry = index === undefined ? undefined : path[index];
    const isTriggerEntry =
      entry?.type === "custom_message" || (entry?.type === "message" && entry.role === "user");
    if (index === undefined || index <= start || !isTriggerEntry || seen.has(boundary.entryId)) {
      throw new NativeSessionForkError(
        "boundary_mismatch",
        "Native run provenance contains an off-branch or inconsistent association.",
      );
    }
    seen.add(boundary.entryId);
    if (index <= selected) continue;
    if (boundary.kind === "unknown") unknown.push(index);
    else if (next < 0 || index < next) next = index;
  }
  if (unknown.some((index) => next < 0 || index < next)) {
    throw new NativeSessionForkError(
      "boundary_mismatch",
      "A queued custom message has no proven trigger ownership.",
    );
  }
  return next;
}

export function resolvePiForkTarget(
  source: PiSessionPath,
  target: NativeSessionForkTarget,
): { targetEntryId: string } {
  const { path } = source;
  if (target.kind === "latest") return resolvePiLeaf(path, target.leafEntryId);
  const selected = path.findIndex((entry) => entry.id === target.entryId);
  if (selected < 0) {
    throw new NativeSessionForkError(
      "boundary_not_found",
      "The selected Pi entry is not on the active ancestry.",
    );
  }
  let nextTrigger: number;
  if (target.framing === undefined) {
    nextTrigger = path.findIndex(
      (entry, index) => index > selected && entry.type === "message" && entry.role === "user",
    );
    const end = nextTrigger < 0 ? path.length : nextTrigger;
    if (path.slice(selected + 1, end).some((entry) => entry.type === "custom_message")) {
      throw new NativeSessionForkError(
        "boundary_mismatch",
        "The native file does not prove which custom message starts the next run.",
      );
    }
  } else {
    nextTrigger = resolveObservedNextTrigger(source, target);
  }
  const cutIndex = nextTrigger < 0 ? path.length - 1 : nextTrigger - 1;
  const cut = path[cutIndex];
  if (!cut)
    throw new NativeSessionForkError("boundary_not_found", "The Pi run boundary was not found.");
  return { targetEntryId: cut.id };
}

/** An in-flight append may outpace capture after an already-proven next run trigger.
 * Only that earlier cut can use the covered prefix; its leaf is never a fallback cut. */
export function resolvePiSessionForkTransaction(
  source: PiSessionPath,
  target: NativeSessionForkTarget,
  sourceRunning: boolean,
) {
  const framing = target.kind === "turn" ? target.framing : undefined;
  if (
    !sourceRunning ||
    target.kind !== "turn" ||
    !framing ||
    framing.observedLeafId === source.path.at(-1)?.id
  ) {
    return { ...resolvePiForkTarget(source, target), framingSource: source };
  }
  const covered = source.path.findIndex((entry) => entry.id === framing.observedLeafId);
  const selected = source.path.findIndex((entry) => entry.id === target.entryId);
  if (covered < 0 || selected < 0 || selected >= covered) {
    throw new NativeSessionForkError(
      "boundary_mismatch",
      "The observed run prefix is not on the active source ancestry.",
    );
  }
  const prefix = { ...source, path: source.path.slice(0, covered + 1) };
  const nextTrigger = resolveObservedNextTrigger(prefix, target);
  if (nextTrigger <= selected) {
    throw new NativeSessionForkError(
      "boundary_mismatch",
      "No proven next run trigger covers this completed response.",
    );
  }
  return { ...resolvePiForkTarget(prefix, target), framingSource: prefix };
}

const workerResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), sessionFile: z.string(), sessionId: z.string() }),
  z.object({ ok: z.literal(false), code: z.string(), error: z.string() }),
]);

function requirePiForkWorkerResult(result: z.infer<typeof workerResultSchema>) {
  if (result.ok) return result;
  const code =
    result.code === "source_needs_migration" || result.code === "unsupported"
      ? result.code
      : "materialize_failed";
  throw new NativeSessionForkError(code, result.error);
}

export async function materializePiBranch(input: {
  runtime: PiRuntime;
  cwd: string;
  sourceFile: string;
  targetEntryId: string;
  signal: AbortSignal;
  logger: Logger;
  env?: Record<string, string>;
}): Promise<{ sessionFile: string; sessionId: string }> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(120_000)]);
  const stagingRoot = join(dirname(input.sourceFile), ".paseo-fork-staging");
  await mkdir(stagingRoot, { recursive: true });
  const stagingDir = await mkdtemp(join(stagingRoot, "branch-"));
  let worker: PiRuntimeSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let published: string | undefined;
  const onAbort = () => {
    void worker?.close().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const helper = join(stagingDir, "fork-helper.ts");
    await writeFile(helper, piSessionForkHelperSource());
    worker = await input.runtime.startSession({
      cwd: input.cwd,
      env: input.env,
      signal,
      noSession: true,
      isolateForkHelper: true,
      extensionPaths: [helper],
      extraArgs: ["--no-extensions", "--no-mcp"],
    });
    signal.throwIfAborted();
    const commands = await worker.getCommands();
    if (!commands.some((command) => command.name === "paseo_fork_branch"))
      throw new NativeSessionForkError(
        "unsupported",
        "Pi did not load the native fork helper. Update Pi or check the configured wrapper.",
      );
    const activeWorker = worker;
    const workerResult = await new Promise<z.infer<typeof workerResultSchema>>(
      (resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        const detach = activeWorker.onEvent((event) => {
          if (event.type === "process_exit") reject(new Error(String(event.error)));
          if (
            event.type !== "extension_ui_request" ||
            event.method !== "notify" ||
            typeof event.message !== "string"
          )
            return;
          const prefix = "PASEO_COMMAND_RESULT ";
          if (!event.message.startsWith(prefix)) return;
          try {
            resolve(workerResultSchema.parse(JSON.parse(event.message.slice(prefix.length))));
          } catch (error) {
            reject(error);
          }
        });
        unsubscribe = () => {
          detach();
          signal.removeEventListener("abort", abort);
        };
        const payload = Buffer.from(
          JSON.stringify({
            sourceFile: input.sourceFile,
            stagingDir,
            targetEntryId: input.targetEntryId,
          }),
        ).toString("base64url");
        activeWorker.prompt(`/paseo_fork_branch ${payload}`).catch(reject);
        if (signal.aborted) abort();
      },
    );
    await worker.close();
    worker = undefined;
    signal.throwIfAborted();
    const result = requirePiForkWorkerResult(workerResult);
    if (dirname(result.sessionFile) !== stagingDir)
      throw new Error("Pi worker returned a file outside staging.");
    const branch = await readPiSessionPath(result.sessionFile, null);
    const rawHeader = z
      .object({ parentSession: z.string() })
      .parse(JSON.parse((await readFile(result.sessionFile, "utf8")).split("\n")[0]!));
    const source = await readPiSessionPath(input.sourceFile, input.targetEntryId);
    if (
      branch.header.id === source.header.id ||
      branch.header.id !== result.sessionId ||
      rawHeader.parentSession !== input.sourceFile ||
      branch.header.cwd !== input.cwd ||
      branch.path.findLast((entry) => entry.type !== "label")?.id !==
        source.path.findLast((entry) => entry.type !== "label")?.id
    ) {
      throw new Error("The staged Pi branch does not match the requested source boundary.");
    }
    const destination = join(dirname(input.sourceFile), basename(result.sessionFile));
    await link(result.sessionFile, destination);
    published = destination;
    await unlink(result.sessionFile);
    signal.throwIfAborted();
    return { sessionFile: destination, sessionId: result.sessionId };
  } catch (error) {
    if (published) await rm(published, { force: true });
    if (signal.aborted)
      throw new NativeSessionForkError(
        input.signal.aborted ? "canceled" : "timeout",
        input.signal.aborted
          ? "Session fork canceled."
          : "Session fork timed out. Retry the operation.",
      );
    if (error instanceof NativeSessionForkError) throw error;
    throw new NativeSessionForkError(
      "materialize_failed",
      `Could not create the Pi branch: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    unsubscribe?.();
    signal.removeEventListener("abort", onAbort);
    await worker
      ?.close()
      .catch((error) => input.logger.warn({ err: error }, "Failed to close Pi fork worker"));
    await rm(stagingDir, { recursive: true, force: true });
    // Other concurrent forks may still own siblings under the staging root.
    await rmdir(stagingRoot).catch(() => {});
  }
}

/** SDK branching preserves non-label ids; carry only observed proof on that copied ancestry. */
export function rebindPiForkFraming(
  source: PiSessionPath,
  handle: AgentPersistenceHandle,
  branch: PiSessionPath,
): NativeSessionForkFraming | undefined {
  const parsed = NativeSessionForkFramingSchema.safeParse(
    handle.metadata?.nativeSessionForkFraming,
  );
  if (!parsed.success) return undefined;
  const framing = parsed.data;
  const positions = new Map(source.path.map((entry, index) => [entry.id, index]));
  const start = framing.startEntryId === null ? -1 : positions.get(framing.startEntryId);
  if (
    !framing.valid ||
    framing.sourceSessionId !== source.header.id ||
    framing.sourceNativeHandle !== source.file ||
    framing.observedLeafId !== source.path.at(-1)?.id ||
    start === undefined
  )
    return undefined;
  const copied = new Set(branch.path.map((entry) => entry.id));
  let startEntryId = framing.startEntryId;
  if (startEntryId !== null && source.path[start]?.type === "label") {
    startEntryId =
      source.path.slice(0, start + 1).findLast((entry) => entry.type !== "label")?.id ?? null;
  }
  if (startEntryId !== null && !copied.has(startEntryId)) return undefined;
  const seen = new Set<string>();
  if (
    framing.boundaries.some((boundary) => {
      if (seen.has(boundary.entryId)) return true;
      seen.add(boundary.entryId);
      const index = positions.get(boundary.entryId);
      const entry = index === undefined ? undefined : source.path[index];
      return (
        index === undefined ||
        index <= start ||
        !(entry?.type === "custom_message" || (entry?.type === "message" && entry.role === "user"))
      );
    })
  )
    return undefined;
  return {
    ...framing,
    startEntryId,
    sourceSessionId: branch.header.id,
    sourceNativeHandle: branch.file,
    observedLeafId: branch.path.at(-1)?.id ?? null,
    boundaries: framing.boundaries.filter((boundary) => copied.has(boundary.entryId)),
  };
}

const inheritedForkOriginSchema = z.object({
  sourceNativeHandle: z.string(),
  inheritedLeafEntryId: z.string().min(1),
});

export function resolvePiInheritedForkEntries(
  source: PiSessionPath,
  rawOrigin: unknown,
): ReadonlySet<string> {
  const origin = inheritedForkOriginSchema.safeParse(rawOrigin);
  if (!origin.success || source.header.parentSession !== origin.data.sourceNativeHandle) {
    throw new NativeSessionForkError(
      "boundary_mismatch",
      "The native fork origin metadata is corrupt; inherited child ownership cannot be established.",
    );
  }
  const leaf = source.path.findIndex((entry) => entry.id === origin.data.inheritedLeafEntryId);
  if (leaf < 0)
    throw new NativeSessionForkError(
      "boundary_mismatch",
      "The inherited native fork boundary is missing from the active ancestry.",
    );
  return new Set(source.path.slice(0, leaf + 1).map((entry) => entry.id));
}
