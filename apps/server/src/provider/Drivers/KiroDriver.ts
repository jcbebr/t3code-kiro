import { getKiroAgentSelection, getKiroAgentSource, KiroSettings } from "@t3tools/contracts";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import * as AcpErrors from "effect-acp/errors";
import { kiroTextGeneration } from "../../textGeneration/KiroTextGeneration.ts";
import { makeKiroAdapter } from "../KiroAdapter.ts";
import { makeKiroProvider } from "../KiroProvider.ts";
import { KIRO_DRIVER, makeKiroAcpRuntime } from "../acp/KiroAcpSupport.ts";
import { requireKiroAgentSource } from "../kiroAgentCatalog.ts";
import { discoverKiroSkills } from "./KiroSkills.ts";

const decodeSettings = Schema.decodeSync(KiroSettings);
export type KiroDriverEnv =
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderHost
  | IdAllocatorV2
  | McpProviderSessions;

export const KiroDriver: ProviderDriver<KiroSettings, KiroDriverEnv> = {
  driverKind: KIRO_DRIVER,
  metadata: { displayName: "Kiro", supportsMultipleInstances: false },
  configSchema: KiroSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const settings = { ...config, enabled };
      const processEnvironment = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: KIRO_DRIVER,
        instanceId,
      });
      const provider = yield* makeKiroProvider(
        settings,
        processEnvironment,
        withInstanceIdentity({
          instanceId,
          driverKind: KIRO_DRIVER,
          displayName,
          accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: KIRO_DRIVER,
              instanceId,
              detail: "Could not prepare Kiro provider status.",
              cause,
            }),
        ),
      );
      const selfInvocation = yield* resolveSelfInvocation().pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: KIRO_DRIVER,
              instanceId,
              detail: "Could not resolve the server executable for Kiro MCP.",
              cause,
            }),
        ),
      );
      const discoverSkills = (cwd: string) =>
        discoverKiroSkills(cwd, processEnvironment).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      const orchestrationAdapter = yield* makeKiroAdapter(settings, {
        instanceId,
        selfInvocation,
        onSessionStarted: provider.onSessionStarted,
        resolveSkillNames: (cwd) =>
          discoverSkills(cwd).pipe(
            Effect.map((skills) => new Set(skills.map((skill) => skill.name))),
          ),
        validateAgent: (cwd, selection) => {
          const agent = getKiroAgentSelection(selection.options);
          const agentSource = getKiroAgentSource(selection.options);
          return agent && agentSource
            ? requireKiroAgentSource({
                cwd,
                environment: processEnvironment,
                agent,
                agentSource,
              }).pipe(
                Effect.asVoid,
                Effect.mapError((cause) => AcpErrors.AcpRequestError.internalError(cause.message)),
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
              )
            : Effect.void;
        },
        makeRuntime: ({ agent, ...input }) =>
          makeKiroAcpRuntime({ ...settings, agent: agent ?? "" }, processEnvironment, input).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
      });
      const snapshotForCwd = (cwd: string) =>
        !settings.enabled
          ? provider.snapshot.getSnapshot
          : Effect.all([provider.snapshot.getSnapshot, discoverSkills(cwd)]).pipe(
              Effect.map(([snapshot, skills]) => ({ ...snapshot, skills })),
            );
      return {
        instanceId,
        driverKind: KIRO_DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: provider.snapshot,
        snapshotForCwd,
        orchestrationAdapter,
        textGeneration: kiroTextGeneration,
      };
    }),
};
