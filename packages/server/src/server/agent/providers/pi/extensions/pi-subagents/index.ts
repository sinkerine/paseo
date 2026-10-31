import { z } from "zod";
import { extractTextFromToolResult } from "../../tool-call-mapper.js";
import type { PiExtension, PiExtensionToolCall, PiExtensionToolMapping } from "../contract.js";
import { projectRun, readAsyncStatus, type AsyncRun } from "./async-runs.js";
import { customMessageText, noticeStatus } from "./notice.js";
import { createPiWorkflowTracker, WorkflowLaunchDetails } from "./workflow.js";

const Args = z
  .object({
    agent: z.string().trim().min(1).optional(),
    task: z.string().trim().min(1).optional(),
    async: z.boolean().optional(),
    action: z.unknown().optional(),
  })
  .passthrough();
const Row = z
  .object({
    index: z.number().int().nonnegative().optional(),
    agent: z.string().trim().min(1),
    exitCode: z.number().optional(),
    success: z.boolean().optional(),
    sessionFile: z.string().trim().min(1).optional(),
  })
  .passthrough();
const Completion = z
  .object({ runId: z.string().trim().min(1), results: z.array(Row) })
  .passthrough();
const Details = z
  .object({
    mode: z.string(),
    runId: z.string().optional(),
    asyncId: z.string().optional(),
    asyncDir: z.string().trim().min(1).optional(),
    results: z.array(Row),
    completions: z.array(Completion).optional(),
  })
  .passthrough();
const MissionResult = z.object({
  details: z.object({ mode: z.string(), mission: z.unknown() }),
});

export const piSubagents: PiExtension = {
  id: "pi-subagents",
  createSession: () => {
    const callsByRun = new Map<string, string>();
    const readSessions = new Set<string>();
    const workflows = createPiWorkflowTracker({ readSessions });
    /** Keyed by async directory, which both status.json and the completion notice carry. */
    const asyncRuns = new Map<string, AsyncRun>();
    const rememberAsyncRun = (details: z.infer<typeof Details>, call: PiExtensionToolCall) => {
      if (details.asyncDir && call.status !== "failed") {
        if (!asyncRuns.has(details.asyncDir))
          asyncRuns.set(details.asyncDir, {
            dir: details.asyncDir,
            owner: call.callId,
            toolCallId: call.callId,
            polling: true,
            emitted: new Map(),
          });
      }
    };
    const collectRows = (
      owner: string,
      rows: z.infer<typeof Row>[],
      description?: string,
      failed = false,
    ) => {
      const subagents: NonNullable<PiExtensionToolMapping["subagents"]> = [];
      const childSessions: NonNullable<PiExtensionToolMapping["childSessions"]> = [];
      for (const [index, row] of rows.entries()) {
        const id = rows.length === 1 ? owner : `${owner}:${row.index ?? index}`;
        subagents.push({
          type: "upsert",
          id,
          title: row.agent,
          description,
          toolCallId: owner,
          status:
            failed || row.success === false || (row.success !== true && row.exitCode !== 0)
              ? "failed"
              : "completed",
        });
        if (row.sessionFile && !readSessions.has(row.sessionFile)) {
          readSessions.add(row.sessionFile);
          childSessions.push({ id, file: row.sessionFile });
        }
      }
      return { subagents, childSessions };
    };
    const mapWait = (call: PiExtensionToolCall) => {
      if (call.status === "running") return undefined;
      const details = Details.safeParse(
        typeof call.result === "object" ? call.result?.details : null,
      );
      if (!details.success || !details.data.completions) return undefined;
      const subagents: NonNullable<PiExtensionToolMapping["subagents"]> = [];
      const childSessions: NonNullable<PiExtensionToolMapping["childSessions"]> = [];
      for (const completion of details.data.completions) {
        const owner = callsByRun.get(completion.runId);
        if (!owner) continue;
        const mapped = collectRows(owner, completion.results);
        subagents.push(...mapped.subagents);
        childSessions.push(...mapped.childSessions);
      }
      return subagents.length ? { subagents, childSessions } : undefined;
    };
    const spawnArgs = (raw: unknown) => {
      const args = Args.safeParse(raw);
      if (!args.success || args.data.action !== undefined || !args.data.agent || !args.data.task)
        return undefined;
      return args.data;
    };
    const projectAsyncSpawn = (details: z.infer<typeof Details>) => {
      const run = details.asyncDir ? asyncRuns.get(details.asyncDir) : undefined;
      if (!run) return undefined;
      const status = readAsyncStatus(run.dir);
      if (!status || status.mode === "workflow") return undefined;
      if (status.toolCallId && status.toolCallId !== run.owner) return undefined;
      return projectRun(run, status, readSessions);
    };
    const mapSpawn = (call: PiExtensionToolCall) => {
      const args = spawnArgs(call.args);
      if (!args) return undefined;
      const detail = {
        type: "sub_agent" as const,
        subAgentType: args.agent,
        description: args.task,
        log: extractTextFromToolResult(call.result)?.trim() ?? "",
      };
      const base = {
        type: "upsert" as const,
        id: call.callId,
        title: args.agent,
        description: args.task,
        toolCallId: call.callId,
      };
      if (call.status === "running")
        return { detail, subagents: [{ ...base, status: "running" as const }] };
      const details = Details.safeParse(
        typeof call.result === "object" ? call.result?.details : null,
      );
      if (!details.success || details.data.mode === "management")
        return call.status === "failed"
          ? { detail, subagents: [{ ...base, status: "failed" as const }] }
          : { detail };
      if (details.data.runId) callsByRun.set(details.data.runId, call.callId);
      if (details.data.results.length === 0 && (details.data.asyncId || args.async)) {
        rememberAsyncRun(details.data, call);
        const projected = projectAsyncSpawn(details.data);
        if (projected) return { detail, ...projected };
        return {
          detail,
          subagents: [
            {
              ...base,
              status: call.status === "failed" ? ("failed" as const) : ("running" as const),
            },
          ],
        };
      }
      if (details.data.results.length === 0 && call.status === "failed")
        return { detail, subagents: [{ ...base, status: "failed" as const }] };
      return {
        detail,
        ...collectRows(call.callId, details.data.results, args.task, call.status === "failed"),
      };
    };
    const mapCall = (call: PiExtensionToolCall): PiExtensionToolMapping | undefined => {
      if (call.toolName === "bg_wait") return mapWait(call);
      if (call.toolName !== "subagent") return undefined;
      if (call.status !== "running") {
        const details = WorkflowLaunchDetails.safeParse(
          typeof call.result === "object" ? call.result?.details : null,
        );
        if (details.success && call.status !== "failed")
          return workflows.launch(details.data, call.callId);
      }
      return mapSpawn(call);
    };
    return {
      mapToolCall(call) {
        const mapped = mapCall(call);
        if (call.toolName !== "subagent" || call.status !== "completed") return mapped;
        const result = MissionResult.safeParse(call.result);
        const recovered = result.success
          ? workflows.recoverMission(result.data.details.mission)
          : undefined;
        if (!recovered) return mapped;
        return {
          ...mapped,
          subagents: [...(mapped?.subagents ?? []), ...recovered.subagents],
          childSessions: [...(mapped?.childSessions ?? []), ...(recovered.childSessions ?? [])],
        };
      },
      // The notice is the only completion Pi persists, so replay settles async runs from it.
      mapCustomMessage(message) {
        if (message.customType === "subagent-incremental-child-notify")
          return workflows.mapNotice(message);
        if (message.customType !== "subagent-notify") return undefined;
        const workflow = workflows.mapNotice(message);
        if (workflow) return workflow;
        const text = customMessageText(message);
        const lines = text?.split("\n") ?? [];
        const status = noticeStatus(lines[0] ?? "");
        if (!status) return undefined;
        const subagents: NonNullable<PiExtensionToolMapping["subagents"]> = [];
        const childSessions: NonNullable<PiExtensionToolMapping["childSessions"]> = [];
        // Each run's session line follows its async directory line; earlier lines are child output.
        let owner: string | undefined;
        for (const line of lines) {
          const dir = line.match(/^Retention-managed async directory: (.+)$/)?.[1];
          if (dir) {
            owner = asyncRuns.get(dir)?.owner;
            if (owner) subagents.push({ type: "upsert", id: owner, status });
            continue;
          }
          const file = owner ? line.match(/^Session file: (.+)$/)?.[1] : undefined;
          if (!owner || !file) continue;
          if (!readSessions.has(file)) {
            readSessions.add(file);
            childSessions.push({ id: owner, file });
          }
          owner = undefined;
        }
        return subagents.length ? { subagents, childSessions } : undefined;
      },
      poll() {
        const subagents: NonNullable<PiExtensionToolMapping["subagents"]> = [];
        const childSessions: NonNullable<PiExtensionToolMapping["childSessions"]> = [];
        for (const run of asyncRuns.values()) {
          if (!run.polling) continue;
          const status = readAsyncStatus(run.dir);
          if (
            !status ||
            status.mode === "workflow" ||
            (status.toolCallId && status.toolCallId !== run.owner)
          )
            continue;
          const mapped = projectRun(run, status, readSessions);
          subagents.push(...mapped.subagents);
          childSessions.push(...mapped.childSessions);
        }
        const workflow = workflows.poll();
        subagents.push(...(workflow?.subagents ?? []));
        childSessions.push(...(workflow?.childSessions ?? []));
        return subagents.length || childSessions.length ? { subagents, childSessions } : undefined;
      },
    };
  },
};
