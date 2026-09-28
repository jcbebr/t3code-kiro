import {
  ProviderDriverKind,
  type KiroSettings,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as AcpSchema from "effect-acp/schema";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const KIRO_DRIVER = ProviderDriverKind.make("kiro");
export const KIRO_DEFAULT_MODEL = "kiro-default";
export const KIRO_LOGIN_MESSAGE = "Sign in on the server with `kiro-cli login`, then retry.";
export const KIRO_DEFAULT_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: KIRO_DEFAULT_MODEL,
    name: "Kiro default",
    isCustom: false,
    isDefault: true,
    capabilities: {},
  },
];

const KiroCliModelCatalog = Schema.fromJsonString(
  Schema.Struct({
    models: Schema.Array(
      Schema.Struct({
        model_id: Schema.NonEmptyString,
        name: Schema.optional(Schema.String),
        display_name: Schema.optional(Schema.String),
        model_name: Schema.optional(Schema.String),
      }),
    ),
  }),
);
const decodeKiroCliModelCatalog = Schema.decodeUnknownOption(KiroCliModelCatalog);

export function kiroCliModels(output: string): ReadonlyArray<ServerProviderModel> | undefined {
  const catalog = decodeKiroCliModelCatalog(output);
  if (Option.isNone(catalog)) return undefined;
  const seen = new Set([KIRO_DEFAULT_MODEL]);
  return [
    ...KIRO_DEFAULT_MODELS,
    ...catalog.value.models.flatMap((model) => {
      if (seen.has(model.model_id)) return [];
      seen.add(model.model_id);
      return [
        {
          slug: model.model_id,
          name: model.name || model.display_name || model.model_name || model.model_id,
          isCustom: false,
          capabilities: {},
        },
      ];
    }),
  ];
}

export function kiroSpawnInput(settings: KiroSettings, cwd: string, env: NodeJS.ProcessEnv) {
  return {
    command: settings.binaryPath || "kiro-cli",
    args: ["acp", ...(settings.agent.trim() ? ["--agent", settings.agent.trim()] : [])],
    cwd,
    env,
  } satisfies AcpSessionRuntime.AcpSpawnInput;
}

export const makeKiroAcpRuntime = (
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv,
  input: Omit<AcpSessionRuntime.AcpSessionRuntimeOptions, "spawn" | "authMethodId">,
) =>
  AcpSessionRuntime.make({
    ...input,
    spawn: kiroSpawnInput(settings, input.cwd, environment),
    // Kiro owns the Identity Center session and exits before initialize when logged out.
    authMethodId: null,
    cancelBehavior: "wait-for-prompt",
  });

export function kiroModels(started: AcpSessionRuntime.AcpSessionRuntimeStartResult) {
  const models = started.sessionSetupResult.models?.availableModels ?? [];
  return [
    ...KIRO_DEFAULT_MODELS,
    ...models
      .filter((model) => model.modelId !== KIRO_DEFAULT_MODEL)
      .map((model) => ({
        slug: model.modelId,
        name: model.name,
        isCustom: false,
        capabilities: {},
      })),
  ];
}

export function kiroPermissionOption(
  request: AcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
) {
  // Never turn T3's per-thread approval into a native persistent grant.
  const kind =
    decision === "accept" ? "allow_once" : decision === "decline" ? "reject_once" : undefined;
  return kind ? request.options.find((option) => option.kind === kind)?.optionId : undefined;
}

export function kiroApprovalOptions(request: AcpSchema.RequestPermissionRequest) {
  const options: ProviderApprovalOption[] = [];
  for (const decision of ["accept", "decline"] as const) {
    const id = kiroPermissionOption(request, decision);
    const native = request.options.find((option) => option.optionId === id);
    if (native && id) options.push({ decision, label: native.name });
  }
  options.push({ decision: "cancel", label: "Cancel" });
  return options;
}
