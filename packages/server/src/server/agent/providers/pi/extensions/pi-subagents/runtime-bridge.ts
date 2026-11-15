import { z } from "zod";

export const PI_SUBAGENTS_WORKFLOW_STARTED_MARKER = "PASEO_PI_SUBAGENTS_WORKFLOW_STARTED";

const WorkflowStart = z.object({
  runId: z.string().trim().min(1),
  asyncDir: z.string().trim().min(1),
});

export interface PiWorkflowStart {
  runId: string;
  asyncDir: string;
}

/** Undefined for other notifications; invalid marked payloads throw so the host claims them. */
export function parseWorkflowStartNotification(message: string): PiWorkflowStart | undefined {
  if (!message.startsWith(PI_SUBAGENTS_WORKFLOW_STARTED_MARKER)) return undefined;
  return WorkflowStart.parse(
    JSON.parse(message.slice(PI_SUBAGENTS_WORKFLOW_STARTED_MARKER.length)),
  );
}

// Pi can start resuming workflows before this bridge's session_start handler runs.
export const piSubagentsRuntimeBridge = `
  let piSubagentsWorkflowContext;
  const piSubagentsWorkflowStarts = [];
  function reportPiSubagentsWorkflowStart(ctx, event) {
    const current = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
    if (event.sessionId !== current) return;
    ctx.ui.notify(
      "${PI_SUBAGENTS_WORKFLOW_STARTED_MARKER} " +
        JSON.stringify({ runId: event.id, asyncDir: event.asyncDir }),
      "info",
    );
  }
  pi.on("session_start", (_event, ctx) => {
    piSubagentsWorkflowContext = ctx;
    for (const event of piSubagentsWorkflowStarts.splice(0))
      reportPiSubagentsWorkflowStart(ctx, event);
  });
  pi.events.on("subagent:async-started", (event) => {
    if (
      event?.mode !== "workflow" ||
      typeof event.id !== "string" ||
      typeof event.asyncDir !== "string"
    ) return;
    if (piSubagentsWorkflowContext) reportPiSubagentsWorkflowStart(piSubagentsWorkflowContext, event);
    else piSubagentsWorkflowStarts.push(event);
  });
`;
