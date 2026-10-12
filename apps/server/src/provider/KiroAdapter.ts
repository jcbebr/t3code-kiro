import {
  getKiroAgentSelection,
  getKiroAgentSource,
  type KiroSettings,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
} from "@t3tools/provider-acp/server/adapter";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as AcpErrors from "effect-acp/errors";
import { KIRO_DEFAULT_MODEL, KIRO_DRIVER, kiroApprovalOptions } from "./acp/KiroAcpSupport.ts";
import { rewriteKiroSkillMentions } from "./Drivers/KiroSkills.ts";

export interface KiroAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly selfInvocation: SelfInvocation;
  readonly makeRuntime: (
    input: Parameters<AcpAdapterV2Flavor["makeRuntime"]>[0] & { readonly agent?: string },
  ) => ReturnType<AcpAdapterV2Flavor["makeRuntime"]>;
  readonly resolveSkillNames?: (cwd: string) => Effect.Effect<ReadonlySet<string>>;
  readonly validateAgent?: (
    cwd: string,
    selection: ModelSelection,
  ) => Effect.Effect<void, AcpErrors.AcpError>;
  readonly onSessionStarted?: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
  ) => Effect.Effect<void>;
}

const capabilities = {
  ...AcpProviderCapabilitiesV2,
  sessions: { ...AcpProviderCapabilitiesV2.sessions, supportsModelSwitchInSession: true },
  threads: { ...AcpProviderCapabilitiesV2.threads, canRollbackThread: false },
  tools: { ...AcpProviderCapabilitiesV2.tools, supportsMcpTools: true },
};

/** Each session owns its agent choice; shared ACP code supplies the thread's MCP credential. */
export const makeKiroAdapter = Effect.fn("makeKiroAdapter")(function* (
  settings: KiroSettings,
  options: KiroAdapterOptions,
) {
  const context =
    yield* Effect.context<
      Exclude<Effect.Services<ReturnType<typeof makeAcpAdapterV2>>, Scope.Scope>
    >();
  const base = yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    selfInvocation: options.selfInvocation,
    flavor: { driver: KIRO_DRIVER, capabilities, makeRuntime: options.makeRuntime },
  });
  return ProviderAdapter.ProviderAdapterV2.of({
    ...base,
    openSession: Effect.fn("KiroAdapter.openSession")(
      function* (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) {
        if (!settings.enabled)
          return yield* AcpErrors.AcpRequestError.internalError(
            "Enable Kiro in provider settings first.",
          );
        const cwd = input.runtimePolicy.cwd ?? process.cwd();
        yield* options.validateAgent?.(cwd, input.modelSelection) ?? Effect.void;
        const requestedAgent = getKiroAgentSelection(input.modelSelection.options);
        const requestedSource = getKiroAgentSource(input.modelSelection.options);
        let pinnedAgent =
          requestedAgent ??
          (input.initialNativeThreadId ? undefined : settings.agent.trim() || undefined);
        const skills = yield* options.resolveSkillNames?.(cwd) ?? Effect.succeed(new Set<string>());
        const adapter = yield* makeAcpAdapterV2({
          instanceId: options.instanceId,
          selfInvocation: options.selfInvocation,
          flavor: {
            driver: KIRO_DRIVER,
            capabilities,
            approvalOptions: kiroApprovalOptions,
            applyModelSelection: ({ runtime, startResult, modelSelection }) =>
              Effect.gen(function* () {
                const agent = getKiroAgentSelection(modelSelection.options);
                const source = getKiroAgentSource(modelSelection.options);
                if ((agent && agent !== pinnedAgent) || (source && source !== requestedSource)) {
                  return yield* AcpErrors.AcpRequestError.internalError(
                    "The Kiro agent cannot change after the thread starts. Start a new thread instead.",
                  );
                }
                const reportedAgent = startResult.sessionSetupResult.modes?.currentModeId;
                if (pinnedAgent && reportedAgent && pinnedAgent !== reportedAgent) {
                  return yield* AcpErrors.AcpRequestError.internalError(
                    `Kiro started agent '${reportedAgent}' instead of '${pinnedAgent}'. Check that the selected agent is available in this workspace.`,
                  );
                }
                pinnedAgent ??= reportedAgent;
                yield* options.onSessionStarted?.(startResult) ?? Effect.void;
                if (modelSelection.model !== KIRO_DEFAULT_MODEL) {
                  // Kiro's v2 engine exposes legacy models; v3 advertises model config options.
                  const hasModelConfig = startResult.sessionSetupResult.configOptions?.some(
                    (option) => option.category === "model",
                  );
                  if (hasModelConfig) {
                    yield* runtime.setModel(modelSelection.model);
                  } else {
                    yield* runtime.setSessionModel(modelSelection.model);
                  }
                  return modelSelection.model;
                }
                return undefined;
              }),
            makeRuntime: (runtimeInput) =>
              options
                .makeRuntime({ ...runtimeInput, ...(pinnedAgent ? { agent: pinnedAgent } : {}) })
                .pipe(
                  Effect.map((runtime) => ({
                    ...runtime,
                    prompt: (promptInput: Parameters<typeof runtime.prompt>[0]) =>
                      runtime.prompt({
                        ...promptInput,
                        prompt: promptInput.prompt.map((block) =>
                          block.type === "text"
                            ? { ...block, text: rewriteKiroSkillMentions(block.text, skills) }
                            : block,
                        ),
                      }),
                  })),
                ),
          },
        });
        return yield* adapter.openSession(input);
      },
      (effect, input) =>
        effect.pipe(
          Effect.provide(context),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: KIRO_DRIVER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
});
