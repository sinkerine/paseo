import { basename } from "node:path";
import type { PiAgentMessage } from "../../rpc-types.js";
import { extractTextFromToolResult } from "../../tool-call-mapper.js";

export type PiCustomMessage = Extract<PiAgentMessage, { role: "custom" }>;

export function customMessageText(message: PiCustomMessage): string | undefined {
  return typeof message.content === "string"
    ? message.content
    : extractTextFromToolResult({ content: message.content });
}

export function noticeStatus(header: string): "completed" | "failed" | "canceled" | undefined {
  if (/^Background tasks completed \(\d+\):/.test(header)) return "completed";
  const outcome = header.match(
    /^(?:Background task|Detached foreground task) (completed|failed|stopped): \*\*/,
  )?.[1];
  if (outcome === "stopped") return "canceled";
  if (outcome === "completed" || outcome === "failed") return outcome;
  return undefined;
}

export type WorkflowChildOutcome = "completed" | "failed" | "paused" | "stopped";

export interface WorkflowChildNotice {
  workflowRunId: string;
  childKey: string;
  outcome: WorkflowChildOutcome;
  childRunId?: string;
}

export function parseWorkflowChildNotice(text: string): WorkflowChildNotice | undefined {
  const lines = text.split("\n");
  const header = lines[0]?.match(
    /^Workflow child (completed|failed|paused \(needs attention\)|stopped): \*\*(.+)\*\*$/,
  );
  const workflowRunId = correlationLine(lines, /^Workflow run: (\S+)$/);
  if (!header || !workflowRunId) return undefined;
  const outcome = header[1] === "paused (needs attention)" ? "paused" : header[1];
  if (
    outcome !== "completed" &&
    outcome !== "failed" &&
    outcome !== "paused" &&
    outcome !== "stopped"
  )
    return undefined;
  return {
    workflowRunId,
    childKey: header[2],
    outcome,
    childRunId: correlationLine(lines, /^Child run: (\S+)$/),
  };
}

export interface WorkflowChildRunEntry {
  childKey: string;
  childRunId: string;
  status?: string;
}

export interface WorkflowTerminalNotice {
  workflowRunId: string;
  asyncDir: string;
  status: "completed" | "failed" | "canceled";
  children: WorkflowChildRunEntry[];
}

function correlationLine(lines: string[], pattern: RegExp): string | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    const value = lines[index].match(pattern)?.[1];
    if (value) return value;
  }
  return undefined;
}

export function parseWorkflowTerminalNotice(text: string): WorkflowTerminalNotice | undefined {
  const lines = text.split("\n");
  const status = noticeStatus(lines[0] ?? "");
  const workflowRunId = correlationLine(lines, /^Workflow run: (\S+)$/);
  const asyncDir = correlationLine(lines, /^Retention-managed async directory: (\S.*)$/);
  if (!status || !workflowRunId || !asyncDir || basename(asyncDir) !== workflowRunId)
    return undefined;
  const children: WorkflowChildRunEntry[] = [];
  const childRuns = correlationLine(lines, /^Child runs: (.*)$/);
  for (const entry of childRuns ? childRuns.split(", ") : []) {
    const match = entry.match(/^([^=\s]+)=([^\s]+?)(?: \(([^()]+)\))?$/);
    if (!match) return undefined;
    children.push({ childKey: match[1], childRunId: match[2], status: match[3] });
  }
  return { workflowRunId, asyncDir, status, children };
}
