import {
  getKiroAgentSelection,
  getKiroAgentSource,
  KIRO_DEFAULT_AGENT,
  type KiroAgentCatalog,
  type ModelSelection,
  type ProviderOptionSelection,
} from "@t3tools/contracts";

type KiroComposerAgentInput = {
  locked: boolean;
  threadSelection: ModelSelection | null | undefined;
  draftOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  catalog: KiroAgentCatalog | null;
};

/** A started thread always reads its durable selection, never a stale composer draft. */
export function resolveKiroComposerAgent(input: KiroComposerAgentInput): string | null {
  if (input.locked) return getKiroAgentSelection(input.threadSelection?.options) ?? null;
  return (
    getKiroAgentSelection(input.draftOptions) ??
    (input.catalog ? (input.catalog.defaultAgent ?? KIRO_DEFAULT_AGENT) : null)
  );
}

export function resolveKiroComposerAgentSource(input: KiroComposerAgentInput) {
  if (input.locked) return getKiroAgentSource(input.threadSelection?.options);
  const agent = resolveKiroComposerAgent(input);
  return (
    getKiroAgentSource(input.draftOptions) ??
    input.catalog?.agents.find((candidate) => candidate.name === agent)?.source
  );
}

export function getKiroAgentSendBlockReason(input: {
  locked: boolean;
  cwd: string | null;
  catalog: KiroAgentCatalog | null;
  error: string | null;
  agent: string | null;
  source?: "project" | "global" | "builtin" | undefined;
}): string | null {
  if (input.locked) return null;
  if (!input.cwd) return "Choose a project to load its Kiro agents.";
  if (input.error) return "Could not load Kiro agents. Open the agent picker to retry.";
  if (!input.catalog) return "Loading Kiro agents…";
  if (!input.agent || !input.catalog.agents.some((agent) => agent.name === input.agent)) {
    return `Kiro agent “${input.agent ?? "default"}” is unavailable in this project. Choose another agent.`;
  }
  if (
    input.source &&
    !input.catalog.agents.some(
      (agent) => agent.name === input.agent && agent.source === input.source,
    )
  ) {
    return `Kiro agent “${input.agent}” is no longer available from its selected source. Choose the agent again.`;
  }
  return null;
}

export function kiroAgentLabel(agent: string | null): string {
  return agent === KIRO_DEFAULT_AGENT ? "Default" : (agent ?? "Existing agent");
}
