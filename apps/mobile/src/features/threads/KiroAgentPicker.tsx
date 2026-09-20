import {
  KIRO_DEFAULT_AGENT,
  type KiroAgentCatalog,
  type KiroAgentSource,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";

import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { ControlPillMenu } from "../../components/ControlPill";

export function KiroAgentPicker(props: {
  readonly selectedAgent: string | undefined;
  readonly selectedSource: KiroAgentSource | undefined;
  readonly catalog: KiroAgentCatalog | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly locked?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: (name: string) => void;
  readonly onRefresh: () => void;
}) {
  const label =
    props.selectedAgent === KIRO_DEFAULT_AGENT
      ? "Default agent"
      : (props.selectedAgent ?? (props.locked ? "Existing agent" : "Default agent"));
  if (props.locked || props.disabled) {
    return (
      <ComposerInlineControl
        label={label}
        icon="lock.fill"
        accessibilityLabel={`Kiro agent: ${label}`}
        accessibilityHint="The agent is fixed after the thread starts."
        static
        maxWidth={160}
      />
    );
  }
  const actions: MenuAction[] = (props.catalog?.agents ?? []).map((agent) => ({
    id: `agent:${agent.name}`,
    title: agent.name === KIRO_DEFAULT_AGENT ? "Default agent" : agent.name,
    subtitle: [
      agent.source === "project" ? "Project" : agent.source === "global" ? "Global" : "Built-in",
      agent.description,
    ]
      .filter(Boolean)
      .join(" · "),
    state:
      agent.name === props.selectedAgent &&
      (!props.selectedSource || agent.source === props.selectedSource)
        ? "on"
        : "off",
  }));
  if (props.error)
    actions.push({ id: "error", title: props.error, attributes: { disabled: true } });
  if (
    props.selectedAgent &&
    props.catalog &&
    !props.catalog.agents.some(
      (agent) =>
        agent.name === props.selectedAgent &&
        (!props.selectedSource || agent.source === props.selectedSource),
    )
  ) {
    actions.push({
      id: "missing",
      title: `Agent ${props.selectedAgent} is unavailable. Choose another agent.`,
      attributes: { disabled: true },
    });
  }
  for (const [index, warning] of (props.catalog?.warnings ?? []).entries()) {
    actions.push({ id: `warning:${index}`, title: warning, attributes: { disabled: true } });
  }
  actions.push({
    id: "refresh",
    title: props.loading ? "Loading agents…" : "Refresh agents",
    attributes: { disabled: props.loading },
  });
  return (
    <ControlPillMenu
      title="Kiro agent"
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "refresh") props.onRefresh();
        else if (nativeEvent.event.startsWith("agent:")) props.onSelect(nativeEvent.event.slice(6));
      }}
    >
      <ComposerInlineControl
        label={props.loading ? "Loading agents…" : props.error ? "Agents unavailable" : label}
        accessibilityLabel={`Choose Kiro agent: ${label}`}
        accessibilityHint="Choose a project or global agent before starting this thread."
        maxWidth={160}
        static
      />
    </ControlPillMenu>
  );
}
