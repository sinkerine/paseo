import { z } from "zod";
import { extractTextFromToolResult } from "../../tool-call-mapper.js";
import type { PiExtension, PiExtensionToolCall, PiExtensionToolMapping } from "../contract.js";

import { projectRun, readAsyncStatus, resolveAsyncDir, type AsyncRun } from "./async-runs.js";
import { PI_SUBAGENTS_ASYNC_STARTED_MARKER, piSubagentsRuntimeBridge } from "./runtime-bridge.js";

const Args = z
  .object({
    agent: z.string().trim().min(1).optional(),
    task: z.string().trim().min(1).optional(),
    async: z.boolean().optional(),
    workflowScript: z.string().optional(),
    workflowScriptPath: z.string().optional(),
    workflow: z.string().optional(),
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
const CodemodeDetails = z.object({
  calls: z.array(z.object({ name: z.string(), status: z.string() })),
});
const Started = z.object({ id: z.string().min(1), asyncDir: z.string().min(1) });

/** The `subagent-notify` header; a grouped notice reports every run as completed. */
function noticeStatus(header: string) {
  if (/^Background tasks completed \(\d+\):/.test(header)) return "completed";
  const outcome = header.match(
    /^(?:Background task|Detached foreground task) (completed|failed|paused|stopped): \*\*/,
  )?.[1];
  if (outcome === "stopped" || outcome === "paused") return "canceled";
  return outcome as "completed" | "failed" | undefined;
}

export const piSubagents: PiExtension = {
  id: "pi-subagents",
  runtimeBridge: piSubagentsRuntimeBridge,
  createSession: () => {
    const callsByRun = new Map<string, string>();
    const readSessions = new Set<string>();
    const knownDirs = new Map<string, string>();
    const asyncRuns = new Map<string, AsyncRun>();
    const registerRun = (dir: string, owner: string, toolCallId: string, workflow: boolean) => {
      const existing = asyncRuns.get(dir);
      if (existing) {
        if (existing.toolCallId !== toolCallId) {
          existing.toolCallId = toolCallId;
          existing.emitted.clear();
        }
        return existing;
      }
      const run: AsyncRun = {
        dir,
        owner,
        toolCallId,
        workflow,
        polling: true,
        emitted: new Map(),
      };
      asyncRuns.set(dir, run);
      return run;
    };
    const mapCodemode = (call: PiExtensionToolCall) => {
      if (call.status === "running") return undefined;
      const details = CodemodeDetails.safeParse(
        typeof call.result === "object" ? call.result?.details : null,
      );
      if (
        !details.success ||
        !details.data.calls.some((nested) => nested.name === "subagent" && nested.status === "ok")
      )
        return undefined;
      const text = extractTextFromToolResult(call.result) ?? "";
      const subagents: NonNullable<PiExtensionToolMapping["subagents"]> = [];
      const childSessions: NonNullable<PiExtensionToolMapping["childSessions"]> = [];
      for (const match of text.matchAll(/\bAsync(?: workflow|:[^\n[]*)? \[([0-9a-f-]{36})\]/g)) {
        const dir = resolveAsyncDir(match[1], knownDirs);
        const status = readAsyncStatus(dir);
        // Text alone cannot prove which Pi parent owns this run.
        if (!status?.toolCallId?.startsWith(`${call.callId}/`)) continue;
        const run = registerRun(dir, status.toolCallId, call.callId, status.mode === "workflow");
        const mapped = projectRun(run, status, readSessions);
        subagents.push(...mapped.subagents);
        childSessions.push(...mapped.childSessions);
      }
      return subagents.length || childSessions.length ? { subagents, childSessions } : undefined;
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
    const mapAsyncSpawn = (
      call: PiExtensionToolCall,
      details: z.infer<typeof Details>,
      workflow: boolean,
    ): PiExtensionToolMapping => {
      const isWorkflow = workflow || details.mode === "workflow";
      const status = details.asyncDir ? readAsyncStatus(details.asyncDir) : undefined;
      if (call.status === "completed" && isWorkflow && status?.toolCallId !== call.callId)
        return { subagents: [{ type: "remove", id: call.callId }] };
      if (details.asyncDir && call.status !== "failed") {
        if (status?.toolCallId && status.toolCallId !== call.callId) return { subagents: [] };
        const run = registerRun(details.asyncDir, call.callId, call.callId, isWorkflow);
        if (status) return projectRun(run, status, readSessions);
      }
      return {
        subagents: [
          {
            type: "upsert",
            id: call.callId,
            toolCallId: call.callId,
            status: call.status === "failed" ? "failed" : "running",
          },
        ],
      };
    };
    const spawnArgs = (raw: unknown) => {
      const parsed = Args.safeParse(raw);
      if (!parsed.success || parsed.data.action !== undefined) return undefined;
      const args = parsed.data;
      const workflow = Boolean(args.workflowScript || args.workflowScriptPath || args.workflow);
      if (workflow) return { args, workflow, title: "workflow" };
      if (args.agent && args.task) return { args, workflow, title: args.agent };
      return undefined;
    };
    const mapSpawn = (call: PiExtensionToolCall) => {
      const parsed = spawnArgs(call.args);
      if (!parsed) return undefined;
      const { args, workflow, title } = parsed;
      const detail = {
        type: "sub_agent" as const,
        subAgentType: title,
        description: args.task ?? args.workflow,
        log: extractTextFromToolResult(call.result)?.trim() ?? "",
      };
      const base = {
        type: "upsert" as const,
        id: call.callId,
        title,
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
        const mapped = mapAsyncSpawn(call, details.data, workflow);
        const subagents = mapped.subagents?.map((row) =>
          row.type === "upsert" ? { ...base, ...row } : row,
        );
        return { detail, ...mapped, subagents };
      }
      if (details.data.results.length === 0 && call.status === "failed")
        return { detail, subagents: [{ ...base, status: "failed" as const }] };
      const mapped = collectRows(
        call.callId,
        details.data.results,
        args.task,
        call.status === "failed",
      );
      if (workflow)
        mapped.subagents.push({
          ...base,
          status: call.status === "failed" ? "failed" : "completed",
        });
      return { detail, ...mapped };
    };
    return {
      mapToolCall(call) {
        if (call.toolName === "codemode") return mapCodemode(call);
        if (call.toolName === "bg_wait") return mapWait(call);
        if (call.toolName === "subagent") return mapSpawn(call);
        return undefined;
      },
      mapRuntimeNotification(message) {
        const prefix = `${PI_SUBAGENTS_ASYNC_STARTED_MARKER} `;
        if (!message.startsWith(prefix)) return undefined;
        try {
          const parsed = Started.safeParse(JSON.parse(message.slice(prefix.length)));
          if (parsed.success) knownDirs.set(parsed.data.id, parsed.data.asyncDir);
        } catch {
          // Notifications are external input; malformed bridge messages are still claimed.
        }
        return { subagents: [] };
      },
      mapCustomMessage(message) {
        if (message.customType !== "subagent-notify") return undefined;
        const text =
          typeof message.content === "string"
            ? message.content
            : extractTextFromToolResult({ content: message.content });
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
          if (!status || (status.toolCallId && status.toolCallId !== run.owner)) continue;
          const mapped = projectRun(run, status, readSessions);
          subagents.push(...mapped.subagents);
          childSessions.push(...mapped.childSessions);
        }
        return subagents.length || childSessions.length ? { subagents, childSessions } : undefined;
      },
    };
  },
};
