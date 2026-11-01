// The synchronous Pi adapter contract reads one named status file per tracked run per tick.
// eslint-disable-next-line paseo/no-sync-io
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import type { ProviderSubagentStatus } from "../../../../provider-subagents/store.js";
import type { PiChildSessionFile, PiExtensionCustomMapping } from "../contract.js";
import { isOwnerAlive } from "./async-runs.js";
import {
  customMessageText,
  parseWorkflowChildNotice,
  parseWorkflowTerminalNotice,
  type PiCustomMessage,
} from "./notice.js";

export const WorkflowLaunchDetails = z
  .object({
    mode: z.literal("workflow"),
    runId: z.string().trim().min(1),
    asyncDir: z.string().trim().min(1),
  })
  .passthrough();

const Mission = z.object({ runs: z.array(z.unknown()) });

const WorkflowStep = z
  .object({
    workflowKey: z.string().trim().min(1).optional(),
    parentWorkflowRunId: z.string().optional(),
    label: z.string().optional(),
    agent: z.string().optional(),
    phase: z.string().trim().min(1).optional(),
    status: z.string().optional(),
    startedAt: z.number().finite().nonnegative().optional(),
    sessionFile: z.string().trim().min(1).optional(),
  })
  .passthrough();
const WorkflowGraph = z
  .object({
    phases: z.array(z.object({ title: z.string().trim().min(1), nodeIds: z.array(z.string()) })),
    nodes: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()),
  })
  .passthrough();
const WorkflowStatus = z
  .object({
    runId: z.string().trim().min(1),
    mode: z.literal("workflow"),
    state: z.string(),
    toolCallId: z.string().optional(),
    pid: z.number().int().positive().optional(),
    steps: z.array(WorkflowStep),
    workflowGraph: WorkflowGraph.optional(),
  })
  .passthrough();

// Unknown and paused values deliberately carry no new lifecycle evidence.
const statusPolicy = {
  workflow: new Map<string, ProviderSubagentStatus>(
    Object.entries({
      queued: "running",
      running: "running",
      complete: "completed",
      failed: "failed",
      partial: "failed",
      rejected: "failed",
      stopped: "canceled",
    }),
  ),
  child: new Map<string, ProviderSubagentStatus>(
    Object.entries({
      pending: "running",
      queued: "running",
      running: "running",
      completed: "completed",
      complete: "completed",
      failed: "failed",
      error: "failed",
      stopped: "canceled",
    }),
  ),
};

export function workflowSubagentId(runId: string): string {
  return `pi-subagents-workflow:${runId}`;
}
export function workflowRunSubagentId(runId: string, childKey: string): string {
  return `${workflowSubagentId(runId)}/${childKey}`;
}
export function workflowGroupSubagentId(runId: string, title: string): string {
  return `${workflowSubagentId(runId)}/group:${title}`;
}

export function resolveWorkflowGroup(
  status: z.infer<typeof WorkflowStatus>,
  step: z.infer<typeof WorkflowStep>,
): string | undefined {
  const lane = status.workflowGraph?.phases.find((phase) =>
    phase.nodeIds.some((id) => id === step.workflowKey),
  );
  return lane?.title ?? step.phase;
}

export interface PiWorkflowTrackerOptions {
  readSessions: Set<string>;
}
export interface PiWorkflowTracker {
  launch(details: z.infer<typeof WorkflowLaunchDetails>, callId?: string): PiExtensionCustomMapping;
  recoverMission(mission: unknown): PiExtensionCustomMapping | undefined;
  mapNotice(message: PiCustomMessage): PiExtensionCustomMapping | undefined;
  poll(): PiExtensionCustomMapping | undefined;
}
interface RunPresentation {
  title: string;
  subtitle?: string;
}
interface RunCreationOrder {
  startedAt: number;
  artifactOrder: number;
}
interface TrackedWorkflow {
  status?: ProviderSubagentStatus;
  asyncDir?: string;
  callId?: string;
  ownerDead: boolean;
  polling: boolean;
  groupByKey: Map<string, string | undefined>;
  runStatusByKey: Map<string, ProviderSubagentStatus | undefined>;
  presentationByKey: Map<string, RunPresentation>;
  creationOrderByKey: Map<string, RunCreationOrder>;
  groups: Set<string>;
  pendingLanes: Set<string>;
}

interface WorkflowObservation {
  childSessions: PiChildSessionFile[];
  childStatuses: Map<string, ProviderSubagentStatus | undefined>;
}

function readStatus(runId: string, asyncDir: string): z.infer<typeof WorkflowStatus> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(asyncDir, "status.json"), "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    if (error instanceof Error && "code" in error) return undefined;
    throw error;
  }
  const parsed = WorkflowStatus.safeParse(raw);
  if (!parsed.success || parsed.data.runId !== runId) return undefined;
  return parsed.data;
}

function groupStatus(
  statuses: Array<ProviderSubagentStatus | undefined>,
  pending: boolean,
): ProviderSubagentStatus {
  if (pending || statuses.includes("running")) return "running";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("canceled")) return "canceled";
  return "completed";
}

function isUnsettled(status: ProviderSubagentStatus | undefined): boolean {
  return status === undefined || status === "running";
}

function artifactChildStatus(
  previous: ProviderSubagentStatus | undefined,
  value: string | undefined,
) {
  const current = statusPolicy.child.get(value ?? "");
  // Closed artifacts freeze at dispatch; a later notice has stronger final evidence.
  return !isUnsettled(previous) && isUnsettled(current) ? previous : current;
}

function applyOwnerLiveness(
  run: TrackedWorkflow,
  status: z.infer<typeof WorkflowStatus>,
  childStatuses: WorkflowObservation["childStatuses"],
) {
  const lifecycle = statusPolicy.workflow.get(status.state);
  const active = isUnsettled(lifecycle);
  const unsettled = [...run.runStatusByKey.values()].some(isUnsettled);
  const ownerAlive = isOwnerAlive(status.pid);
  run.polling = ownerAlive && (active || unsettled);
  run.ownerDead = !ownerAlive && (active || unsettled);
  if (!run.ownerDead) return;
  run.pendingLanes.clear();
  for (const [key, value] of run.runStatusByKey) {
    if (!isUnsettled(value)) continue;
    run.runStatusByKey.set(key, "canceled");
    childStatuses.set(key, "canceled");
  }
}

export function createPiWorkflowTracker(options: PiWorkflowTrackerOptions): PiWorkflowTracker {
  const workflows = new Map<string, TrackedWorkflow>();

  function remember(runId: string): TrackedWorkflow {
    let run = workflows.get(runId);
    if (!run) {
      run = {
        polling: false,
        ownerDead: false,
        groupByKey: new Map(),
        runStatusByKey: new Map(),
        presentationByKey: new Map(),
        creationOrderByKey: new Map(),
        groups: new Set(),
        pendingLanes: new Set(),
      };
      workflows.set(runId, run);
    }
    return run;
  }

  function rememberChild(
    run: TrackedWorkflow,
    key: string,
    status: ProviderSubagentStatus | undefined,
  ) {
    if (!run.groupByKey.has(key)) run.groupByKey.set(key, undefined);
    if (!run.presentationByKey.has(key)) run.presentationByKey.set(key, { title: key });
    if (status !== undefined || !run.runStatusByKey.has(key)) run.runStatusByKey.set(key, status);
  }

  function applyStatus(
    runId: string,
    run: TrackedWorkflow,
    status: z.infer<typeof WorkflowStatus>,
  ): WorkflowObservation {
    const childSessions: PiChildSessionFile[] = [];
    const childStatuses = new Map<string, ProviderSubagentStatus | undefined>();
    run.pendingLanes.clear();
    // Terminal dispatch freezes the graph; only child evidence can keep its groups running.
    if (isUnsettled(statusPolicy.workflow.get(status.state))) {
      const pendingNodes = new Set(
        status.workflowGraph?.nodes
          .filter((node) => node.status === "pending" || node.status === "running")
          .map((node) => node.id),
      );
      for (const phase of status.workflowGraph?.phases ?? []) {
        if (phase.nodeIds.some((id) => pendingNodes.has(id))) run.pendingLanes.add(phase.title);
      }
    }
    for (const step of status.steps) {
      if (!step.workflowKey || step.parentWorkflowRunId !== runId) continue;
      const key = step.workflowKey;
      const childStatus = artifactChildStatus(run.runStatusByKey.get(key), step.status);
      childStatuses.set(key, childStatus);
      rememberChild(run, key, childStatus);
      run.groupByKey.set(key, resolveWorkflowGroup(status, step));
      run.presentationByKey.set(key, { title: step.label ?? key, subtitle: step.agent });
      // Completion notices can arrive out of order; only artifacts establish creation order.
      const previousOrder = run.creationOrderByKey.get(key);
      run.creationOrderByKey.set(key, {
        startedAt: step.startedAt ?? previousOrder?.startedAt ?? 0,
        artifactOrder: previousOrder?.artifactOrder ?? run.creationOrderByKey.size,
      });
      if (step.sessionFile && !options.readSessions.has(step.sessionFile)) {
        options.readSessions.add(step.sessionFile);
        childSessions.push({ id: workflowRunSubagentId(runId, key), file: step.sessionFile });
      }
    }
    return { childSessions, childStatuses };
  }

  function render(
    runId: string,
    run: TrackedWorkflow,
    observation: WorkflowObservation,
    workflowStatus?: ProviderSubagentStatus,
  ): PiExtensionCustomMapping {
    if (workflowStatus !== undefined) run.status = workflowStatus;
    const subagents: PiExtensionCustomMapping["subagents"] = [];
    const members = new Map<string, string[]>();
    for (const [key, group] of run.groupByKey) {
      if (group === undefined) continue;
      const keys = members.get(group) ?? [];
      keys.push(key);
      members.set(group, keys);
    }
    const groupStatuses = new Map<string, ProviderSubagentStatus>();
    for (const [group, keys] of members) {
      const statuses = keys.map((key) => run.runStatusByKey.get(key));
      groupStatuses.set(group, groupStatus(statuses, run.pendingLanes.has(group)));
    }
    const statuses = members.size ? [...groupStatuses.values()] : [...run.runStatusByKey.values()];
    const finished = statuses.filter(
      (status) => status !== undefined && status !== "running",
    ).length;
    const unit = members.size ? "groups" : "runs";
    subagents.push({
      type: "upsert",
      id: workflowSubagentId(runId),
      hasTimeline: false,
      title: "Workflow",
      ...(workflowStatus === undefined ? {} : { status: workflowStatus }),
      subtitle: `${finished} of ${statuses.length} ${unit} done`,
    });
    for (const [group, keys] of members) {
      const orderedKeys = keys.toSorted((left, right) => {
        const leftOrder = run.creationOrderByKey.get(left);
        const rightOrder = run.creationOrderByKey.get(right);
        const timestampOrder = (leftOrder?.startedAt ?? 0) - (rightOrder?.startedAt ?? 0);
        return timestampOrder || (leftOrder?.artifactOrder ?? 0) - (rightOrder?.artifactOrder ?? 0);
      });
      const newestKey = orderedKeys[orderedKeys.length - 1];
      subagents.push({
        type: "upsert",
        id: workflowGroupSubagentId(runId, group),
        hasTimeline: false,
        title: group,
        parentSubagentId: workflowSubagentId(runId),
        status: groupStatuses.get(group),
        subtitle: run.presentationByKey.get(newestKey)?.title,
      });
    }
    for (const [key, group] of run.groupByKey) {
      const parentSubagentId =
        group === undefined ? workflowSubagentId(runId) : workflowGroupSubagentId(runId, group);
      const status = observation.childStatuses.get(key);
      subagents.push({
        type: "upsert",
        id: workflowRunSubagentId(runId, key),
        parentSubagentId,
        ...run.presentationByKey.get(key),
        ...(status === undefined ? {} : { status }),
      });
    }
    for (const group of run.groups) {
      if (!members.has(group))
        subagents.push({ type: "remove", id: workflowGroupSubagentId(runId, group) });
    }
    run.groups = new Set(members.keys());
    return { subagents, childSessions: observation.childSessions };
  }

  return {
    launch(details, callId) {
      const status = readStatus(details.runId, details.asyncDir);
      if (status?.toolCallId && callId && status.toolCallId !== callId)
        return { subagents: [{ type: "remove", id: callId }] };
      const run = remember(details.runId);
      run.asyncDir = details.asyncDir;
      run.callId = callId;
      run.polling = true;
      if (isUnsettled(run.status)) run.status = "running";
      if (
        status &&
        (statusPolicy.workflow.get(status.state) !== "running" || !isOwnerAlive(status.pid))
      ) {
        const observation = applyStatus(details.runId, run, status);
        applyOwnerLiveness(run, status, observation.childStatuses);
        return render(
          details.runId,
          run,
          observation,
          run.ownerDead ? "canceled" : statusPolicy.workflow.get(status.state),
        );
      }
      return {
        subagents: [
          {
            type: "upsert",
            id: workflowSubagentId(details.runId),
            hasTimeline: false,
            title: "Workflow",
            status: "running",
          },
        ],
      };
    },
    recoverMission(mission) {
      const parsed = Mission.safeParse(mission);
      if (!parsed.success) return undefined;
      const subagents: PiExtensionCustomMapping["subagents"] = [];
      const childSessions: PiChildSessionFile[] = [];
      for (const entry of parsed.data.runs) {
        const details = WorkflowLaunchDetails.safeParse(entry);
        if (!details.success) continue;
        const { runId, asyncDir } = details.data;
        const run = workflows.get(runId);
        // Mission snapshots include unrelated runs; only recover a missing handle for known work.
        if (!run || run.asyncDir || !isUnsettled(run.status) || basename(asyncDir) !== runId)
          continue;
        const status = readStatus(runId, asyncDir);
        if (!status) continue;
        run.asyncDir = asyncDir;
        const observation = applyStatus(runId, run, status);
        applyOwnerLiveness(run, status, observation.childStatuses);
        const mapping = render(
          runId,
          run,
          observation,
          run.ownerDead ? "canceled" : statusPolicy.workflow.get(status.state),
        );
        subagents.push(...mapping.subagents);
        childSessions.push(...(mapping.childSessions ?? []));
      }
      return subagents.length ? { subagents, childSessions } : undefined;
    },
    mapNotice(message) {
      const text = customMessageText(message);
      if (text === undefined) return undefined;
      if (message.customType === "subagent-incremental-child-notify") {
        const notice = parseWorkflowChildNotice(text);
        if (!notice) return undefined;
        const run = remember(notice.workflowRunId);
        const childStatus = statusPolicy.child.get(notice.outcome);
        rememberChild(run, notice.childKey, childStatus);
        return render(notice.workflowRunId, run, {
          childSessions: [],
          childStatuses: new Map([[notice.childKey, childStatus]]),
        });
      }
      if (message.customType !== "subagent-notify") return undefined;
      const notice = parseWorkflowTerminalNotice(text);
      if (!notice) return undefined;
      const run = remember(notice.workflowRunId);
      run.asyncDir = notice.asyncDir;
      const status = readStatus(notice.workflowRunId, notice.asyncDir);
      const observation: WorkflowObservation = status
        ? applyStatus(notice.workflowRunId, run, status)
        : { childSessions: [], childStatuses: new Map() };
      for (const child of notice.children) {
        const childStatus = artifactChildStatus(
          run.runStatusByKey.get(child.childKey),
          child.status,
        );
        observation.childStatuses.set(child.childKey, childStatus);
        rememberChild(run, child.childKey, childStatus);
      }
      const unsettled = [...run.runStatusByKey.values()].some(
        (value) => value === undefined || value === "running",
      );
      if (status) applyOwnerLiveness(run, status, observation.childStatuses);
      run.polling = !run.ownerDead && unsettled;
      return render(
        notice.workflowRunId,
        run,
        observation,
        run.ownerDead ? "canceled" : notice.status,
      );
    },
    poll() {
      const subagents: PiExtensionCustomMapping["subagents"] = [];
      const childSessions: PiChildSessionFile[] = [];
      for (const [runId, run] of workflows) {
        if (!run.polling) continue;
        // A failed read must not manufacture presentation updates for this tick.
        if (!run.asyncDir) continue;
        const status = readStatus(runId, run.asyncDir);
        if (!status || (run.callId && status.toolCallId && status.toolCallId !== run.callId))
          continue;
        const observation = applyStatus(runId, run, status);
        applyOwnerLiveness(run, status, observation.childStatuses);
        const mapping = render(
          runId,
          run,
          observation,
          run.ownerDead ? "canceled" : statusPolicy.workflow.get(status.state),
        );
        subagents.push(...mapping.subagents);
        childSessions.push(...(mapping.childSessions ?? []));
      }
      return subagents.length ? { subagents, childSessions } : undefined;
    },
  };
}
