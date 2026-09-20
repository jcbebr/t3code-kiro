import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { layerTest } from "../serverSettings.ts";
import {
  discoverKiroAgents,
  readKiroAgentCatalog,
  requireKiroAgentSource,
} from "./kiroAgentCatalog.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fixture = Effect.fn("kiroAgentCatalogTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-agents-" });
  const cwd = `${root}/workspace`;
  const home = `${root}/home`;
  const write = Effect.fn("kiroAgentCatalogTest.write")(function* (file: string, value: unknown) {
    yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    yield* fs.writeFileString(file, typeof value === "string" ? value : encodeJson(value));
  });
  return { fs, root, cwd, home, write, environment: { HOME: home } };
});

it.effect("rejects a worktree fallback to a global agent with the same name", () =>
  Effect.gen(function* () {
    const { root, cwd, home, environment, write } = yield* fixture();
    yield* write(`${home}/.kiro/agents/reviewer.json`, { name: "reviewer", description: "Global" });
    yield* write(`${cwd}/.kiro/agents/reviewer.json`, { name: "reviewer", description: "Project" });
    yield* requireKiroAgentSource({ cwd, environment, agent: "reviewer", agentSource: "project" });
    const missingProject = yield* requireKiroAgentSource({
      cwd: `${root}/new-worktree`,
      environment,
      agent: "reviewer",
      agentSource: "project",
    }).pipe(Effect.flip);
    expect(missingProject).toMatchObject({ _tag: "KiroAgentCatalogError" });
    expect(missingProject.message).toContain("resolves to global configuration");
    const overriddenGlobal = yield* requireKiroAgentSource({
      cwd,
      environment,
      agent: "reviewer",
      agentSource: "global",
    }).pipe(Effect.flip);
    expect(overriddenGlobal.message).toContain("resolves to project configuration");
    yield* requireKiroAgentSource({
      cwd: `${root}/new-worktree`,
      environment,
      agent: "reviewer",
      agentSource: "global",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("merges global and project agents by native name, with project precedence", () =>
  Effect.gen(function* () {
    const { cwd, home, environment, write } = yield* fixture();
    yield* write(`${home}/.kiro/agents/reviewer.json`, { name: "reviewer", description: "Global" });
    yield* write(`${home}/.kiro/agents/docs.json`, { name: "docs", prompt: "private prompt" });
    yield* write(`${cwd}/.kiro/agents/other-filename.json`, {
      name: "reviewer",
      description: "Project",
      mcpServers: { secret: { env: { TOKEN: "private" } } },
    });
    const catalog = yield* discoverKiroAgents({ cwd, environment });
    expect(catalog.agents.find((agent) => agent.name === "reviewer")).toEqual({
      name: "reviewer",
      description: "Project",
      source: "project",
    });
    expect(catalog.agents.find((agent) => agent.name === "docs")).toEqual({
      name: "docs",
      source: "global",
    });
    expect(encodeJson(catalog)).not.toContain("private");
    expect(catalog.warnings).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("missing directories use the builtin default without warnings", () =>
  Effect.gen(function* () {
    const { cwd, environment } = yield* fixture();
    const catalog = yield* discoverKiroAgents({ cwd, environment });
    expect(catalog.defaultAgent).toBe("kiro_default");
    expect(
      catalog.agents.some(
        (agent) => agent.name === catalog.defaultAgent && agent.source === "builtin",
      ),
    ).toBe(true);
    expect(catalog.warnings).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("skips malformed configs and ignores prompt files and nested directories", () =>
  Effect.gen(function* () {
    const { cwd, environment, write } = yield* fixture();
    yield* write(`${cwd}/.kiro/agents/bad.json`, "{invalid");
    yield* write(`${cwd}/.kiro/agents/unnamed.json`, { description: "missing name" });
    yield* write(`${cwd}/.kiro/agents/readme.md`, "---\nname: markdown\n---\nprompt");
    yield* write(`${cwd}/.kiro/agents/nested/hidden.json`, { name: "hidden" });
    yield* write(`${cwd}/.kiro/agents/valid.json`, { name: "valid", description: "" });
    const catalog = yield* discoverKiroAgents({ cwd, environment });
    expect(catalog.agents.filter((agent) => agent.source === "project")).toEqual([
      { name: "valid", source: "project" },
    ]);
    expect(catalog.warnings).toHaveLength(2);
    expect(catalog.warnings.join("\n")).not.toContain("{invalid");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reads the native default with workspace then provider override precedence", () =>
  Effect.gen(function* () {
    const { cwd, home, environment, write } = yield* fixture();
    for (const name of ["global", "project", "provider"]) {
      yield* write(`${home}/.kiro/agents/${name}.json`, { name });
    }
    yield* write(`${home}/.kiro/settings/cli.json`, { "chat.defaultAgent": "global" });
    expect((yield* discoverKiroAgents({ cwd, environment })).defaultAgent).toBe("global");
    yield* write(`${cwd}/.kiro/settings/cli.json`, { "chat.defaultAgent": "project" });
    expect((yield* discoverKiroAgents({ cwd, environment })).defaultAgent).toBe("project");
    expect(
      (yield* discoverKiroAgents({ cwd, environment, defaultAgent: "provider" })).defaultAgent,
    ).toBe("provider");
    const missing = yield* discoverKiroAgents({ cwd, environment, defaultAgent: "missing" });
    expect(missing.defaultAgent).toBe("missing");
    expect(missing.warnings).toContain("The configured default agent missing was not found.");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("honors the selected provider environment HOME and KIRO_HOME overrides", () =>
  Effect.gen(function* () {
    const { cwd, home, root, write } = yield* fixture();
    const instanceId = ProviderInstanceId.make("kiro-test");
    yield* write(`${home}/.kiro/agents/home-agent.json`, { name: "home-agent" });
    yield* write(`${root}/profile/agents/profile-agent.json`, { name: "profile-agent" });
    const read = (profile?: string) =>
      readKiroAgentCatalog({ cwd, instanceId }).pipe(
        Effect.provide(
          layerTest({
            providerInstances: {
              [instanceId]: {
                driver: ProviderDriverKind.make("kiro"),
                config: {},
                environment: [
                  { name: "HOME", value: home, sensitive: false },
                  { name: "KIRO_HOME", value: profile ?? "", sensitive: false },
                ],
              },
            },
          }),
        ),
      );
    expect((yield* read()).agents.some((agent) => agent.name === "home-agent")).toBe(true);
    const catalog = yield* read(`${root}/profile`);
    expect(catalog.agents.some((agent) => agent.name === "profile-agent")).toBe(true);
    expect(catalog.agents.some((agent) => agent.name === "home-agent")).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not return a Kiro catalog for another provider", () =>
  Effect.gen(function* () {
    const result = yield* readKiroAgentCatalog({
      cwd: "/workspace",
      instanceId: ProviderInstanceId.make("codex"),
    }).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
  }).pipe(Effect.provide(Layer.mergeAll(layerTest(), NodeServices.layer))),
);
