export const PI_SUBAGENTS_ASYNC_STARTED_MARKER = "PASEO_PI_SUBAGENTS_ASYNC_STARTED";

export const piSubagentsRuntimeBridge = `
  let piSubagentsCtx;
  pi.on("session_start", (_event, ctx) => {
    piSubagentsCtx = ctx;
  });
  pi.events.on("subagent:async-started", (event) => {
    if (!event || typeof event.id !== "string" || typeof event.asyncDir !== "string") return;
    // Workflow children are tracked through the workflow's status.json.
    if (event.parentWorkflowRunId) return;
    piSubagentsCtx?.ui.notify(
      "${PI_SUBAGENTS_ASYNC_STARTED_MARKER} " + JSON.stringify({ id: event.id, asyncDir: event.asyncDir }),
      "info",
    );
  });
`;
