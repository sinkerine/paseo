import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type {
  ProviderSubagentInputEvent,
  ProviderSubagentStatus,
} from "../../../../provider-subagents/store.js";
import type { PiChildSessionFile } from "../contract.js";

const AsyncStepSchema = z.object({
  agent: z.string().trim().min(1),
  label: z.string().optional(),
  status: z
    .enum([
      "pending",
      "queued",
      "running",
      "completed",
      "complete",
      "failed",
      "error",
      "paused",
      "stopped",
      "rejected",
      "detached",
    ])
    .optional(),
  sessionFile: z.string().trim().min(1).optional(),
});
const AsyncStatusSchema = z.object({
  state: z.enum([
    "queued",
    "running",
    "complete",
    "failed",
    "partial",
    "stopped",
    "rejected",
    "paused",
  ]),
  runId: z.string().optional(),
  toolCallId: z.string().optional(),
  mode: z.string().optional(),
  pid: z.number().int().positive().optional(),
  steps: z.array(AsyncStepSchema),
});

export type AsyncStep = z.infer<typeof AsyncStepSchema>;
export type AsyncStatus = z.infer<typeof AsyncStatusSchema>;
export type AsyncRunState = "active" | "paused" | "terminal";

export interface AsyncRun {
  dir: string;
  /** The spawning subagent tool call id. */
  owner: string;
  toolCallId: string;
  polling: boolean;
  emitted: Map<string, string>;
}

export function readAsyncStatus(dir: string): AsyncStatus | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
    const parsed = AsyncStatusSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    // External run files can disappear or be mid-write during a poll.
    return undefined;
  }
}

export function isOwnerAlive(pid: number | undefined): boolean {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

export function runState(status: AsyncStatus): AsyncRunState {
  if (status.state === "paused") return "paused";
  if (status.state !== "queued" && status.state !== "running") return "terminal";
  // A crashed Pi owner cannot finish an async run or write its completion notice.
  return isOwnerAlive(status.pid) ? "active" : "terminal";
}

function ownerStatus(state: AsyncRunState, runStatus: string): ProviderSubagentStatus {
  if (state === "active") return "running";
  if (state === "paused") return "canceled";
  if (runStatus === "complete") return "completed";
  const stopped = runStatus === "stopped" || runStatus === "queued" || runStatus === "running";
  return stopped ? "canceled" : "failed";
}

export function stepStatus(
  state: AsyncRunState,
  runStatus: string,
  step: AsyncStep,
): ProviderSubagentStatus {
  if (step.status === "complete" || step.status === "completed" || step.status === "detached")
    return "completed";
  if (step.status === "failed" || step.status === "error" || step.status === "rejected")
    return "failed";
  if (step.status === "stopped" || step.status === "paused") return "canceled";
  return ownerStatus(state, runStatus);
}

interface AsyncRunProjection {
  subagents: ProviderSubagentInputEvent[];
  childSessions: PiChildSessionFile[];
  state: AsyncRunState;
}
type SubagentRow = Extract<ProviderSubagentInputEvent, { type: "upsert" }>;

function wasSettled(signature: string | undefined): boolean {
  if (signature === undefined) return false;
  const previous: unknown = JSON.parse(signature);
  return Array.isArray(previous) && previous[0] !== "running";
}

export function projectRun(
  run: AsyncRun,
  status: AsyncStatus,
  readSessions: Set<string>,
): AsyncRunProjection {
  const state = runState(status);
  const rows = new Map<string, SubagentRow>();
  const childSessions: PiChildSessionFile[] = [];
  const owner: SubagentRow = {
    type: "upsert",
    id: run.owner,
    toolCallId: run.toolCallId,
    status: ownerStatus(state, status.state),
  };
  for (const [index, step] of status.steps.entries()) {
    let id = run.owner;
    if (status.steps.length !== 1) id = `${run.owner}:${index}`;
    const projectedStatus = stepStatus(state, status.state, step);
    rows.set(id, {
      type: "upsert",
      id,
      title: step.agent,
      description: step.label,
      toolCallId: run.toolCallId,
      status: projectedStatus,
    });
    if (step.sessionFile) {
      const resumed = projectedStatus === "running" && wasSettled(run.emitted.get(id));
      // The host drops followers when a row settles, including while paused.
      if (!readSessions.has(step.sessionFile) || resumed) {
        readSessions.add(step.sessionFile);
        childSessions.push({ id, file: step.sessionFile });
      }
    }
  }
  if (state !== "active" || status.steps.length !== 1) {
    rows.set(run.owner, { ...rows.get(run.owner), ...owner });
  }
  const subagents: ProviderSubagentInputEvent[] = [];
  for (const row of rows.values()) {
    const signature = JSON.stringify([
      row.status,
      row.title,
      row.description,
      row.parentSubagentId,
    ]);
    if (run.emitted.get(row.id) === signature) continue;
    run.emitted.set(row.id, signature);
    subagents.push(row);
  }
  if (state === "terminal") run.polling = false;
  return { subagents, childSessions, state };
}
