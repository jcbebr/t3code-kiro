import {
  type KiroSettings,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  KIRO_DEFAULT_MODELS,
  KIRO_DRIVER,
  KIRO_LOGIN_MESSAGE,
  kiroModels,
} from "../acp/KiroAcpSupport.ts";
import type { AcpSessionRuntimeStartResult } from "../acp/AcpSessionRuntime.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

export const makeKiroProvider = Effect.fn("makeKiroProvider")(function* (
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv,
  stampIdentity: (snapshot: ServerProviderDraft) => ServerProvider,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const models =
    yield* SubscriptionRef.make<ReadonlyArray<ServerProviderModel>>(KIRO_DEFAULT_MODELS);
  const run = (args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const binary = settings.binaryPath || "kiro-cli";
      const command = yield* resolveSpawnCommand(binary, args, { env: environment });
      return yield* spawnAndCollect(
        binary,
        ChildProcess.make(command.command, command.args, {
          env: environment,
          shell: command.shell,
        }),
      );
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.timeout("10 seconds"),
    );
  const initial = Effect.gen(function* () {
    return stampIdentity({
      displayName: "Kiro",
      badgeLabel: "Local preview",
      enabled: settings.enabled,
      installed: false,
      version: null,
      status: settings.enabled ? "warning" : "disabled",
      auth: { status: "unknown" },
      checkedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      models: yield* SubscriptionRef.get(models),
      skills: [],
      slashCommands: [],
      showInteractionModeToggle: false,
      supportsConversationRollback: false,
      message: settings.enabled
        ? "Checking Kiro CLI. Titles and branch names are generated locally; automatic Git messages are unavailable."
        : "Kiro is disabled.",
    });
  });
  const checkProvider = Effect.gen(function* () {
    const base = yield* initial;
    if (!settings.enabled) return base;
    const version = yield* run(["--version"]).pipe(
      Effect.map((result) => ({ result, missing: false })),
      Effect.catch((cause) =>
        Effect.succeed({ result: undefined, missing: isCommandMissingCause(cause) }),
      ),
    );
    if (!version.result || version.result.code !== 0) {
      return {
        ...base,
        installed: !version.missing,
        status: "error" as const,
        message: version.missing
          ? "Kiro CLI was not found. Install it or set its full binary path."
          : "Could not run Kiro CLI. Check its binary path.",
      };
    }
    const auth = yield* run(["whoami", "--format", "json"]).pipe(Effect.option);
    const checked = {
      ...base,
      installed: true,
      version: parseGenericCliVersion(version.result.stdout),
    };
    if (auth._tag === "None")
      return {
        ...checked,
        status: "warning" as const,
        message: "Kiro login check timed out or failed. Check `kiro-cli whoami` in a terminal.",
      };
    if (auth.value.code !== 0)
      return {
        ...checked,
        status: "error" as const,
        auth: { status: "unauthenticated" as const },
        message: KIRO_LOGIN_MESSAGE,
      };
    return {
      ...checked,
      status: "ready" as const,
      auth: { status: "authenticated" as const, type: "cli", label: "Kiro CLI login" },
      message:
        "Uses your Kiro CLI login and native tool permissions. Titles and branch names are local; automatic Git messages are unavailable.",
    };
  });
  const snapshot = yield* makeManagedServerProvider({
    getSettings: Effect.succeed(settings),
    streamSettings: Stream.empty,
    haveSettingsChanged: () => false,
    initialSnapshot: () => initial,
    checkProvider,
    resolveMaintenance: () =>
      Effect.succeed(
        makeManualOnlyProviderMaintenanceCapabilities({ provider: KIRO_DRIVER, packageName: null }),
      ),
    enrichSnapshot: ({ snapshot, publishSnapshot }) =>
      SubscriptionRef.changes(models).pipe(
        Stream.runForEach((catalog) => publishSnapshot({ ...snapshot, models: catalog })),
      ),
  });
  return {
    snapshot,
    onSessionStarted: (started: AcpSessionRuntimeStartResult) =>
      SubscriptionRef.set(models, kiroModels(started)),
  };
});
