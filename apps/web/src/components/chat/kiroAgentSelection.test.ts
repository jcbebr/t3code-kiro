import { KIRO_DEFAULT_AGENT, ProviderInstanceId, type KiroAgentCatalog } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getKiroAgentSendBlockReason,
  resolveKiroComposerAgent,
  resolveKiroComposerAgentSource,
} from "./kiroAgentSelection";

const catalog: KiroAgentCatalog = {
  agents: [
    { name: KIRO_DEFAULT_AGENT, source: "builtin" },
    { name: "reviewer", source: "project" },
    { name: "company", source: "global" },
  ],
  defaultAgent: "company",
  warnings: [],
};

describe("Kiro composer agent", () => {
  it("pins the current catalog source for defaults and older unsent name-only drafts", () => {
    expect(
      resolveKiroComposerAgentSource({
        locked: false,
        threadSelection: null,
        draftOptions: undefined,
        catalog,
      }),
    ).toBe("global");
    expect(
      resolveKiroComposerAgentSource({
        locked: false,
        threadSelection: null,
        draftOptions: [{ id: "kiroAgent", value: "reviewer" }],
        catalog,
      }),
    ).toBe("project");
  });

  it("keeps a started thread's source despite a stale draft or changed catalog", () => {
    const threadSelection = {
      instanceId: ProviderInstanceId.make("kiro"),
      model: "auto",
      options: [
        { id: "kiroAgent", value: "reviewer" },
        { id: "kiroAgentSource", value: "global" },
      ],
    };
    expect(
      resolveKiroComposerAgentSource({
        locked: true,
        threadSelection,
        draftOptions: [
          { id: "kiroAgent", value: "reviewer" },
          { id: "kiroAgentSource", value: "project" },
        ],
        catalog,
      }),
    ).toBe("global");
    expect(
      resolveKiroComposerAgentSource({
        locked: true,
        threadSelection: { ...threadSelection, options: [{ id: "kiroAgent", value: "reviewer" }] },
        draftOptions: [
          { id: "kiroAgent", value: "reviewer" },
          { id: "kiroAgentSource", value: "project" },
        ],
        catalog,
      }),
    ).toBeUndefined();
  });

  it("requires reselection when the same name now resolves to a different source", () => {
    const source = resolveKiroComposerAgentSource({
      locked: false,
      threadSelection: null,
      draftOptions: [
        { id: "kiroAgent", value: "company" },
        { id: "kiroAgentSource", value: "project" },
      ],
      catalog,
    });
    expect(source).toBe("project");
    expect(
      getKiroAgentSendBlockReason({
        locked: false,
        cwd: "/new-worktree",
        catalog,
        error: null,
        agent: "company",
        source,
      }),
    ).toContain("selected source");
  });

  it("uses the environment default until the draft has an explicit agent", () => {
    expect(
      resolveKiroComposerAgent({
        locked: false,
        threadSelection: null,
        draftOptions: undefined,
        catalog,
      }),
    ).toBe("company");
    expect(
      resolveKiroComposerAgent({
        locked: false,
        threadSelection: null,
        draftOptions: [{ id: "kiroAgent", value: "reviewer" }],
        catalog,
      }),
    ).toBe("reviewer");
  });

  it("waits for the selected environment instead of inventing a default during loading", () => {
    expect(
      resolveKiroComposerAgent({
        locked: false,
        threadSelection: null,
        draftOptions: undefined,
        catalog: null,
      }),
    ).toBeNull();
    expect(
      getKiroAgentSendBlockReason({
        locked: false,
        cwd: "/project",
        catalog: null,
        error: null,
        agent: null,
      }),
    ).toBe("Loading Kiro agents…");
  });

  it("restores the durable thread agent instead of a stale composer choice", () => {
    expect(
      resolveKiroComposerAgent({
        locked: true,
        threadSelection: {
          instanceId: ProviderInstanceId.make("kiro"),
          model: "auto",
          options: [{ id: "kiroAgent", value: "reviewer" }],
        },
        draftOptions: [{ id: "kiroAgent", value: "company" }],
        catalog,
      }),
    ).toBe("reviewer");
  });

  it("does not guess a historical agent from today's environment default", () => {
    expect(
      resolveKiroComposerAgent({
        locked: true,
        threadSelection: { instanceId: ProviderInstanceId.make("kiro"), model: "auto" },
        draftOptions: [{ id: "kiroAgent", value: "company" }],
        catalog,
      }),
    ).toBeNull();
    expect(
      getKiroAgentSendBlockReason({
        locked: true,
        cwd: "/project",
        catalog: null,
        error: "offline",
        agent: null,
      }),
    ).toBeNull();
  });

  it("keeps an unavailable saved choice visible and blocks sending in the wrong project", () => {
    const agent = resolveKiroComposerAgent({
      locked: false,
      threadSelection: null,
      draftOptions: [{ id: "kiroAgent", value: "old-project-agent" }],
      catalog,
    });
    expect(agent).toBe("old-project-agent");
    expect(
      getKiroAgentSendBlockReason({
        locked: false,
        cwd: "/new-project",
        catalog,
        error: null,
        agent,
      }),
    ).toContain("old-project-agent");
  });

  it("allows the built-in default when no custom agents exist", () => {
    const builtinOnly: KiroAgentCatalog = {
      agents: [{ name: KIRO_DEFAULT_AGENT, source: "builtin" }],
      defaultAgent: null,
      warnings: [],
    };
    const agent = resolveKiroComposerAgent({
      locked: false,
      threadSelection: null,
      draftOptions: undefined,
      catalog: builtinOnly,
    });
    expect(agent).toBe(KIRO_DEFAULT_AGENT);
    expect(
      getKiroAgentSendBlockReason({
        locked: false,
        cwd: "/project",
        catalog: builtinOnly,
        error: null,
        agent,
      }),
    ).toBeNull();
  });
});
