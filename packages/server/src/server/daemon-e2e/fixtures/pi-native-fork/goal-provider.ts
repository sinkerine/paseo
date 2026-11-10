import { appendFileSync } from "node:fs";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function nativeForkGoalProvider(pi: ExtensionAPI): void {
  let sessionId = "";
  pi.on("session_start", (_event, context) => {
    sessionId = context.sessionManager.getSessionId();
  });
  pi.registerProvider("native-fork-scripted", {
    api: "native-fork-scripted",
    apiKey: "no-network",
    baseUrl: "http://native-fork-scripted.invalid",
    models: [
      {
        id: "goal",
        name: "Native fork goal ownership",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 4096,
      },
    ],
    streamSimple(model, context) {
      const log = process.env.PASEO_NATIVE_GOAL_CALLS;
      if (!log) throw new Error("Missing isolated goal call log");
      appendFileSync(log, `${sessionId}\n`);
      const latest = context.messages.at(-1);
      const waitingForGoal =
        latest?.role === "user" && !JSON.stringify(latest).includes("NATIVE_GOAL_INITIAL");
      const gate = process.env.PASEO_NATIVE_GOAL_GATE;
      const content: string | ToolCall = waitingForGoal
        ? {
            type: "toolCall",
            id: `native-goal-wait-${Date.now()}`,
            name: "bash",
            arguments: { command: `while ! test -f ${JSON.stringify(gate)}; do sleep 0.1; done` },
          }
        : "NATIVE_GOAL_SOURCE_READY";
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
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
