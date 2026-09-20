import type { KiroAgentCatalog } from "@t3tools/contracts";
import { BotIcon, LockIcon, RefreshCwIcon } from "lucide-react";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  type ComposerControlSize,
} from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import { kiroAgentLabel } from "./kiroAgentSelection";

export type KiroAgentPickerProps = {
  agent: string | null;
  source?: "project" | "global" | "builtin" | undefined;
  locked: boolean;
  catalog: KiroAgentCatalog | null;
  loading: boolean;
  error: string | null;
  onSelect: (agent: string) => void;
  onRefresh: () => void;
};

const SOURCE_LABELS = {
  project: "Project agents",
  global: "Environment agents",
  builtin: "Built-in",
} as const;

export function KiroAgentMenuContent(props: KiroAgentPickerProps) {
  if (props.locked) {
    return (
      <div className="max-w-72 space-y-1 p-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2 text-foreground">
          <LockIcon className="size-3" />
          Kiro agent: {kiroAgentLabel(props.agent)}
        </div>
        <p>The agent is fixed after the first message. Start a new thread to use another agent.</p>
      </div>
    );
  }
  const missing =
    props.agent !== null &&
    props.catalog !== null &&
    !props.catalog.agents.some(
      (agent) => agent.name === props.agent && (!props.source || agent.source === props.source),
    );

  return (
    <>
      <div className="space-y-1 p-2 text-xs text-muted-foreground">
        <div className="font-medium text-foreground">Kiro agent</div>
        <p>Choose before sending the first message.</p>
      </div>
      {props.loading && !props.catalog ? (
        <div className="p-2 text-xs text-muted-foreground" role="status">
          Loading agents…
        </div>
      ) : null}
      {props.error ? (
        <div className="max-w-72 p-2 text-xs text-destructive" role="alert">
          {props.error}
        </div>
      ) : null}
      {missing ? (
        <div className="max-w-72 p-2 text-xs text-destructive" role="alert">
          Saved agent “{props.agent}” is unavailable from its selected source. Choose an agent
          again.
        </div>
      ) : null}
      <MenuRadioGroup value={missing ? "" : (props.agent ?? "")} onValueChange={props.onSelect}>
        {(["project", "global", "builtin"] as const).map((source) => {
          const agents = props.catalog?.agents.filter((agent) => agent.source === source) ?? [];
          if (agents.length === 0) return null;
          return (
            <MenuGroup key={source}>
              <MenuGroupLabel>{SOURCE_LABELS[source]}</MenuGroupLabel>
              {agents.map((agent) => (
                <MenuRadioItem key={agent.name} value={agent.name} className="min-h-11 sm:min-h-11">
                  <div className="flex items-center gap-2">
                    <span className="truncate">{kiroAgentLabel(agent.name)}</span>
                    {agent.name === props.catalog?.defaultAgent ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        Environment default
                      </span>
                    ) : null}
                  </div>
                  {agent.description ? (
                    <div className="line-clamp-2 text-xs text-muted-foreground">
                      {agent.description}
                    </div>
                  ) : null}
                </MenuRadioItem>
              ))}
            </MenuGroup>
          );
        })}
      </MenuRadioGroup>
      {props.catalog && !props.catalog.agents.some((agent) => agent.source !== "builtin") ? (
        <div className="max-w-72 p-2 text-xs text-muted-foreground">
          No custom agents found in this project or environment.
        </div>
      ) : null}
      {props.catalog?.warnings.map((warning) => (
        <div key={warning} className="max-w-72 p-2 text-xs text-muted-foreground" role="status">
          {warning}
        </div>
      ))}
      <MenuSeparator />
      <MenuItem onClick={props.onRefresh} disabled={props.loading} className="min-h-11 sm:min-h-11">
        <RefreshCwIcon />
        {props.loading ? "Refreshing…" : "Refresh agents"}
      </MenuItem>
    </>
  );
}

export function KiroAgentPicker(
  props: KiroAgentPickerProps & {
    size?: ComposerControlSize;
    hidden?: boolean;
  },
) {
  const popupProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const size = props.size ?? "sm";
  const label = props.agent
    ? kiroAgentLabel(props.agent)
    : props.locked
      ? "Existing agent"
      : "Agent";
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            aria-label={`Kiro agent: ${label}${props.locked ? " (locked)" : ""}`}
          />
        }
      >
        <ComposerControlIcon icon={props.locked ? LockIcon : BotIcon} size={size} />
        <span className="max-w-32 truncate">{label}</span>
        <ComposerControlChevron size={size} />
      </MenuTrigger>
      <MenuPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]" {...popupProps}>
        <KiroAgentMenuContent {...props} />
      </MenuPopup>
    </Menu>
  );
}
