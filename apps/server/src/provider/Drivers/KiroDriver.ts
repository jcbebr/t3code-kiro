import { KiroSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { kiroTextGeneration } from "../../textGeneration/KiroTextGeneration.ts";
import { ProviderAdapterValidationError, ProviderDriverError } from "../Errors.ts";
import { makeKiroAdapter } from "../Layers/KiroAdapter.ts";
import { makeKiroProvider } from "../Layers/KiroProvider.ts";
import { KIRO_DRIVER, makeKiroAcpRuntime } from "../acp/KiroAcpSupport.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { requireKiroAgentSource } from "../kiroAgentCatalog.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const decodeSettings = Schema.decodeSync(KiroSettings);
export type KiroDriverEnv =
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | BackgroundPolicy.BackgroundPolicy
  | ServerSettingsService;

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
      const adapter = yield* makeKiroAdapter(settings, {
        instanceId,
        onSessionStarted: provider.onSessionStarted,
        makeRuntime: ({ agent, agentSource, ...input }) =>
          Effect.gen(function* () {
            if (agent && agentSource) {
              yield* requireKiroAgentSource({
                cwd: input.cwd,
                environment: processEnvironment,
                agent,
                agentSource,
              }).pipe(
                Effect.mapError(
                  (error) =>
                    new ProviderAdapterValidationError({
                      provider: KIRO_DRIVER,
                      operation: "startSession",
                      issue: error.message,
                    }),
                ),
              );
            }
            return yield* makeKiroAcpRuntime(
              { ...settings, agent: agent ?? settings.agent },
              processEnvironment,
              {
                ...input,
                clientInfo: { name: "t3-code", version: "0.0.0" },
              },
            );
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
      });
      return {
        instanceId,
        driverKind: KIRO_DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: provider.snapshot,
        adapter,
        textGeneration: kiroTextGeneration,
      };
    }),
};
