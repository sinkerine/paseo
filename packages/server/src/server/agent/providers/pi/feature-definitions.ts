import type { AgentFeature } from "../../agent-sdk-types.js";
import type { PiModel } from "./rpc-types.js";

export interface PiFastModelPair {
  normal: PiModel;
  fast: PiModel;
}

// Custom GPT gateways expose fast service as a separate group/<family>-fast
// route. Require both routes from the same provider; never invent a model id.
export function findPiFastModelPair(
  models: readonly PiModel[],
  model: PiModel | null | undefined,
): PiFastModelPair | null {
  if (!model) return null;
  for (const fast of models) {
    if (fast.provider !== model.provider) continue;
    const family = /^group\/([a-z0-9-]+)-fast$/i.exec(fast.id)?.[1];
    if (!family) continue;
    const candidates = models.filter(
      (candidate) =>
        candidate.provider === fast.provider &&
        /^gpt-/i.test(candidate.id) &&
        candidate.id.toLowerCase().endsWith(`-${family.toLowerCase()}`),
    );
    if (candidates.length !== 1) continue;
    const normal = candidates[0]!;
    if (model.id === normal.id || model.id === fast.id) return { normal, fast };
  }
  return null;
}

export function buildPiFeatures(
  models: readonly PiModel[],
  model: PiModel | null | undefined,
  values?: Record<string, unknown>,
): AgentFeature[] {
  const pair = findPiFastModelPair(models, model);
  if (!pair) return [];
  return [
    {
      type: "toggle",
      id: "fast_mode",
      label: "Fast",
      tooltip: "Toggle fast mode",
      icon: "zap",
      value: typeof values?.fast_mode === "boolean" ? values.fast_mode : model?.id === pair.fast.id,
    },
  ];
}
