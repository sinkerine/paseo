import { z } from "zod";
import type { AgentTimelineItem } from "../../../../agent-sdk-types.js";
import type { PiExtension } from "../contract.js";

const Details = z.object({
  piGoal: z.literal(1),
  goal: z
    .object({
      id: z.string().min(1),
      status: z.enum(["active", "paused", "blocked", "complete", "budget_limited"]),
      statusReason: z.string().nullish(),
      objectivePreview: z.string(),
      ownerSessionId: z.string(),
      tokensUsed: z.number().nonnegative(),
      tokenBudget: z.number().nonnegative().nullable(),
      wait: z
        .object({
          reason: z.string(),
          deadline: z.string(),
          message: z.object({ source_agent_id: z.string(), prefix: z.string() }).optional(),
        })
        .nullish(),
    })
    .nullable(),
});
const toolNames = new Set(["create_goal", "get_goal", "update_goal", "adopt_goal", "clear_goal"]);

function goalTodo(goal: z.infer<typeof Details>["goal"]): AgentTimelineItem {
  if (!goal) return { type: "todo", items: [] };
  const status = goal.status;
  const completed = status === "complete";
  let taskStatus: "pending" | "in_progress" | "completed" = "pending";
  if (status === "active") taskStatus = "in_progress";
  if (completed) taskStatus = "completed";
  let text = `Goal: ${goal.objectivePreview}`;
  if (status !== "active") {
    const reason = goal.statusReason ? `: ${goal.statusReason}` : "";
    text += ` (${status}${reason})`;
  }
  return {
    type: "todo",
    items: [{ id: goal.id, text, status: taskStatus, completed }],
  };
}

export const piGoal: PiExtension = {
  id: "pi-goal",
  outOfBandCommands: ["goal-pause", "goal-resume", "goal-clear", "goal-list", "goal-adopt"],
  createSession() {
    let latest: AgentTimelineItem | undefined;
    return {
      replay: () => (latest ? { subagents: [], timeline: [latest] } : undefined),
      mapToolCall(call) {
        if (
          !toolNames.has(call.toolName) ||
          call.status !== "completed" ||
          !call.result ||
          typeof call.result === "string"
        )
          return undefined;
        const parsed = Details.safeParse(call.result.details);
        if (!parsed.success) return undefined;
        latest = goalTodo(parsed.data.goal);
        return { timeline: [latest] };
      },
      mapCustomMessage(message) {
        if (message.customType !== "pi-goal") return undefined;
        const parsed = Details.safeParse(message.details);
        if (!parsed.success) return undefined;
        latest = goalTodo(parsed.data.goal);
        return { subagents: [], timeline: [latest], suppressDefaultMessage: true };
      },
    };
  },
};
