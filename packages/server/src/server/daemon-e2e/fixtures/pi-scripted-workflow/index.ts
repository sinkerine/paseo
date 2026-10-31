import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const workflowScript = `
await runs.run("T1-implement", { agent: "worker", label: "Implement T1", phase: "T1", task: "PASEO_SCRIPTED_CHILD:T1-implement" });
await runs.run("T1-review-1", { agent: "reviewer", label: "Review T1 round 1", phase: "T1", task: "PASEO_SCRIPTED_CHILD:T1-review-1" });
await runs.lanes([{ key: "T2", stages: [
  { key: "implement", agent: "worker", label: "Implement T2", task: "PASEO_SCRIPTED_CHILD:T2.implement" },
  { key: "review", agent: "reviewer", label: "Review T2", task: "PASEO_SCRIPTED_CHILD:T2.review" }
] }]);
return runs.run("cleanup", { agent: "worker", label: "Cleanup", task: "PASEO_SCRIPTED_CHILD:cleanup" });
`;

function reply(context: TranscriptContext): ToolCall | string {
  // Pi converts notices to user messages; only the original task selects the script.
  const originalTask = context.messages.find((message) => message.role === "user");
  let userText = "";
  if (originalTask) {
    userText =
      typeof originalTask.content === "string"
        ? originalTask.content
        : originalTask.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
  }
  const childKey = /PASEO_SCRIPTED_CHILD:([\w.-]+)/.exec(userText)?.[1];
  const toolResults = context.messages.filter((message) => message.role === "toolResult");
  if (childKey) {
    if (toolResults.some((message) => message.toolName === "bash")) {
      return `PASEO_SCRIPTED_DONE:${childKey}`;
    }
    const gate = childKey === "T2.review";
    const command = gate
      ? 'test -n "$PASEO_SCRIPTED_GATE" || exit 1; while [ ! -f "$PASEO_SCRIPTED_GATE" ]; do sleep 0.1; done; printf "PASEO_SCRIPTED_GATE_OPEN\\n"'
      : `printf 'PASEO_SCRIPTED_TOOL:${childKey}\\n'`;
    return {
      type: "toolCall",
      id: `scripted-${childKey}-bash`,
      name: "bash",
      arguments: { command, timeout: 120 },
    };
  }
  if (userText.includes("RUN_WORKFLOW") && toolResults.length === 0) {
    return {
      type: "toolCall",
      id: "scripted-workflow-codemode",
      name: "codemode",
      arguments: {
        code: `return await tools.subagent(${JSON.stringify({ workflowScript, async: true })});`,
      },
    };
  }
  return "PASEO_SCRIPTED_PARENT_IDLE";
}

export default function scriptedWorkflow(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    pi.setActiveTools([...pi.getActiveTools(), "subagent"]);
  });
  pi.registerProvider("paseo-scripted", {
    api: "paseo-scripted",
    apiKey: "scripted-no-network",
    baseUrl: "http://scripted.invalid",
    models: [
      {
        id: "workflow",
        name: "Scripted workflow",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 4096,
      },
    ],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const content = reply(context);
        const stopReason = typeof content === "string" ? "stop" : "toolUse";
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [typeof content === "string" ? { type: "text", text: content } : content],
          stopReason,
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        stream.push({ type: "start", partial: message });
        if (typeof content === "string") {
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: content, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content, partial: message });
        } else {
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: content,
            partial: message,
          });
        }
        stream.push({ type: "done", reason: stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
}
