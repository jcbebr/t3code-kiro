import * as NodeOS from "node:os";
import {
  KiroAgentCatalogError,
  KiroSettings,
  type KiroAgentCatalog,
  type KiroAgentCatalogEntry,
  type KiroAgentCatalogInput,
  type KiroAgentSource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerSettingsService } from "../serverSettings.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

const AgentFile = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});
const NativeSettings = Schema.Struct({
  "chat.defaultAgent": Schema.optional(Schema.String),
});
const decodeAgent = Schema.decodeUnknownOption(Schema.fromJsonString(AgentFile));
const decodeNativeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(NativeSettings));
const decodeKiroSettings = Schema.decodeUnknownEffect(KiroSettings);
const MAX_CONFIG_BYTES = 1024 * 1024;

/** Reads metadata only; agent prompts, tools and credentials never leave the environment. */
export const discoverKiroAgents = Effect.fn("discoverKiroAgents")(function* (input: {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  defaultAgent?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const warnings: string[] = [];
  const agents = new Map<string, KiroAgentCatalogEntry>([
    [
      "kiro_default",
      { name: "kiro_default", description: "Default Kiro agent", source: "builtin" },
    ],
  ]);
  const home = input.environment.HOME || input.environment.USERPROFILE || NodeOS.homedir();
  const globalRoot = input.environment.KIRO_HOME
    ? path.resolve(input.cwd, input.environment.KIRO_HOME)
    : path.join(home, ".kiro");
  const projectRoot = path.join(input.cwd, ".kiro");

  const readConfig = Effect.fn("discoverKiroAgents.readConfig")(function* (file: string) {
    return yield* Effect.gen(function* () {
      const stat = yield* fs.stat(file);
      if (stat.type !== "File" || Number(stat.size) > MAX_CONFIG_BYTES) {
        warnings.push(`Skipped ${file}: expected a configuration file smaller than 1 MiB.`);
        return undefined;
      }
      return yield* fs.readFileString(file);
    }).pipe(
      Effect.catch((error) => {
        if (error.reason._tag !== "NotFound") warnings.push(`Could not read ${file}.`);
        return Effect.void;
      }),
    );
  });

  for (const [root, source] of [
    [globalRoot, "global"],
    [projectRoot, "project"],
  ] as const) {
    if (source === "project" && path.resolve(root) === path.resolve(globalRoot)) continue;
    const directory = path.join(root, "agents");
    const entries = yield* fs.readDirectory(directory).pipe(
      Effect.catch((error) => {
        if (error.reason._tag !== "NotFound") warnings.push(`Could not read ${directory}.`);
        return Effect.succeed([] as string[]);
      }),
    );
    const names = new Set<string>();
    for (const entry of entries.filter((entry) => entry.endsWith(".json")).sort()) {
      const file = path.join(directory, entry);
      const content = yield* readConfig(file);
      if (content === undefined) continue;
      const decoded = decodeAgent(content);
      if (decoded._tag === "None") {
        warnings.push(`Skipped ${file}: invalid agent JSON or missing name.`);
        continue;
      }
      const agent = decoded.value;
      if (names.has(agent.name)) {
        warnings.push(`Skipped ${file}: duplicate agent name ${agent.name}.`);
        continue;
      }
      names.add(agent.name);
      const description = agent.description?.trim();
      agents.set(agent.name, {
        name: agent.name,
        ...(description ? { description } : {}),
        source,
      });
    }
  }

  let defaultAgent = "kiro_default";
  for (const root of new Set([globalRoot, projectRoot])) {
    const file = path.join(root, "settings", "cli.json");
    const content = yield* readConfig(file);
    if (content === undefined) continue;
    const decoded = decodeNativeSettings(content);
    if (decoded._tag === "None") {
      warnings.push(`Could not read the default Kiro agent from ${file}: invalid settings.`);
      continue;
    }
    const configured = decoded.value["chat.defaultAgent"]?.trim();
    if (configured) defaultAgent = configured;
  }
  defaultAgent = input.defaultAgent?.trim() || defaultAgent;
  if (!agents.has(defaultAgent)) {
    warnings.push(`The configured default agent ${defaultAgent} was not found.`);
  }

  return {
    agents: [...agents.values()].sort((left, right) => left.name.localeCompare(right.name)),
    defaultAgent,
    warnings,
  } satisfies KiroAgentCatalog;
});

/** Recheck in the actual session directory, which may be a newly-created worktree. */
export const requireKiroAgentSource = Effect.fn("requireKiroAgentSource")(function* (input: {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  agent: string;
  agentSource: KiroAgentSource;
}) {
  const catalog = yield* discoverKiroAgents({ ...input, defaultAgent: input.agent });
  const effective = catalog.agents.find((agent) => agent.name === input.agent);
  if (effective?.source !== input.agentSource) {
    return yield* new KiroAgentCatalogError({
      message: `Kiro agent '${input.agent}' was selected from ${input.agentSource} configuration, but ${effective ? `resolves to ${effective.source} configuration` : "is unavailable"} in this workspace. Make the selected agent available in the thread's workspace before retrying.`,
    });
  }
});

export const readKiroAgentCatalog = Effect.fn("readKiroAgentCatalog")(function* (
  input: KiroAgentCatalogInput,
) {
  const settings = yield* ServerSettingsService;
  const current = yield* settings.getSettings.pipe(
    Effect.mapError(
      () => new KiroAgentCatalogError({ message: "Could not read provider settings." }),
    ),
  );
  const instance = current.providerInstances[input.instanceId];
  if (instance?.driver !== "kiro") {
    return yield* new KiroAgentCatalogError({
      message: "The selected Kiro provider was not found.",
    });
  }
  const config = yield* decodeKiroSettings(instance.config ?? {}).pipe(
    Effect.mapError(
      () => new KiroAgentCatalogError({ message: "The Kiro provider configuration is invalid." }),
    ),
  );
  return yield* discoverKiroAgents({
    cwd: input.cwd,
    environment: mergeProviderInstanceEnvironment(instance.environment),
    defaultAgent: config.agent,
  });
});
