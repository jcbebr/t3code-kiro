import type { ProviderOptionSelection } from "./model.ts";

export const KIRO_AGENT_OPTION_ID = "kiroAgent";
export const KIRO_AGENT_SOURCE_OPTION_ID = "kiroAgentSource";
export const KIRO_DEFAULT_AGENT = "kiro_default";
export type KiroAgentSource = "project" | "global" | "builtin";

/** A Kiro agent belongs to the thread, independently of its selected model. */
export function getKiroAgentSelection(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): string | undefined {
  const value = options?.find((option) => option.id === KIRO_AGENT_OPTION_ID)?.value;
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function getKiroAgentSource(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): KiroAgentSource | undefined {
  const value = options?.find((option) => option.id === KIRO_AGENT_SOURCE_OPTION_ID)?.value;
  return value === "project" || value === "global" || value === "builtin" ? value : undefined;
}

export function withKiroAgentSelection(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
  agent: string | undefined,
  source?: KiroAgentSource,
): ReadonlyArray<ProviderOptionSelection> {
  const remaining =
    options?.filter(
      (option) => option.id !== KIRO_AGENT_OPTION_ID && option.id !== KIRO_AGENT_SOURCE_OPTION_ID,
    ) ?? [];
  if (!agent) return remaining;
  const agentSource =
    source ?? (getKiroAgentSelection(options) === agent ? getKiroAgentSource(options) : undefined);
  return [
    ...remaining,
    { id: KIRO_AGENT_OPTION_ID, value: agent },
    ...(agentSource ? [{ id: KIRO_AGENT_SOURCE_OPTION_ID, value: agentSource }] : []),
  ];
}
