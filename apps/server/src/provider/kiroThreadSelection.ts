import {
  getKiroAgentSelection,
  getKiroAgentSource,
  KIRO_AGENT_OPTION_ID,
  KIRO_AGENT_SOURCE_OPTION_ID,
  withKiroAgentSelection,
  type ModelSelection,
} from "@t3tools/contracts";

/** Native Kiro sessions keep their agent even when a client omits the fork's options. */
export function kiroThreadSelection(
  current: ModelSelection,
  requested: ModelSelection,
  started: boolean,
) {
  const agentOptions =
    requested.options?.filter((option) => option.id === KIRO_AGENT_OPTION_ID) ?? [];
  const sourceOptions =
    requested.options?.filter((option) => option.id === KIRO_AGENT_SOURCE_OPTION_ID) ?? [];
  const agent = getKiroAgentSelection(requested.options);
  const source = getKiroAgentSource(requested.options);
  if (
    (agentOptions.length > 0 && (agentOptions.length !== 1 || !agent)) ||
    (sourceOptions.length > 0 && (sourceOptions.length !== 1 || !source || !agent))
  ) {
    return { error: "Select a single Kiro agent by name." } as const;
  }
  if (!started || current.instanceId !== requested.instanceId)
    return { selection: requested } as const;
  const pinnedAgent = getKiroAgentSelection(current.options);
  const pinnedSource = getKiroAgentSource(current.options);
  if (
    (agent !== undefined && agent !== pinnedAgent) ||
    (source !== undefined && source !== pinnedSource)
  ) {
    return {
      error: "The Kiro agent cannot change after the thread starts. Start a new thread instead.",
    } as const;
  }
  return {
    selection: pinnedAgent
      ? {
          ...requested,
          options: withKiroAgentSelection(requested.options, pinnedAgent, pinnedSource),
        }
      : requested,
  } as const;
}
