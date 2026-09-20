import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const KiroAgentCatalogInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  cwd: TrimmedNonEmptyString,
});
export type KiroAgentCatalogInput = typeof KiroAgentCatalogInput.Type;

export const KiroAgentCatalogEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  source: Schema.Literals(["project", "global", "builtin"]),
});
export type KiroAgentCatalogEntry = typeof KiroAgentCatalogEntry.Type;

export const KiroAgentCatalog = Schema.Struct({
  agents: Schema.Array(KiroAgentCatalogEntry),
  defaultAgent: Schema.NullOr(TrimmedNonEmptyString),
  warnings: Schema.Array(Schema.String),
});
export type KiroAgentCatalog = typeof KiroAgentCatalog.Type;

export class KiroAgentCatalogError extends Schema.TaggedError<KiroAgentCatalogError>()(
  "KiroAgentCatalogError",
  { message: Schema.String },
) {}
