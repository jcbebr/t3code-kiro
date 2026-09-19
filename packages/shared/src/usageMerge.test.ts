import {
  KiroUsageBucket,
  USAGE_CONTRACT_VERSION,
  UsageSummary,
  type EnvironmentId,
  type KiroUsageSource,
  type UsageBucket,
  type UsageDay,
  type UsageProviderKind,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { isModelCostUnknown, mergeUsage, type EnvironmentUsage } from "./usageMerge.ts";

const { kiro: _kiroField, ...legacyUsageFields } = UsageSummary.fields;
const decodeLegacySummary = Schema.decodeUnknownSync(Schema.Struct(legacyUsageFields));
const decodeSummary = Schema.decodeUnknownSync(UsageSummary);
const decodeKiroBucket = Schema.decodeUnknownSync(KiroUsageBucket);

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    day: "2026-08-07" as UsageDay,
    provider: "claude",
    model: "claude-fable-5",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    costUsd: 10,
    cacheSavingsUsd: 2,
    costSource: "modelPriced",
    records: 5,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}

function summary(
  buckets: readonly UsageBucket[],
  sources: readonly {
    provider: UsageProviderKind;
    hostId: string;
    homePath: string;
    volumeId?: string;
    distinctSessions?: number;
  }[],
  contractVersion: number = USAGE_CONTRACT_VERSION,
): UsageSummary {
  return {
    contractVersion,
    readAt: "2026-08-07T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-08-01" as UsageDay,
    untilDay: "2026-08-31" as UsageDay,
    buckets,
    sources: sources.map((source) => ({
      fingerprint: {
        hostId: source.hostId,
        provider: source.provider,
        resolvedHomePath: source.homePath,
        volumeId: source.volumeId ?? `vol-${source.hostId}`,
      },
      status: "ok" as const,
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: source.distinctSessions ?? 1,
      message: null,
    })),
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 10 },
    scanDurationMs: 1,
  };
}

function environment(id: string, usageSummary: UsageSummary): EnvironmentUsage {
  return { environmentId: id as EnvironmentId, label: id, summary: usageSummary };
}

describe("mergeUsage", () => {
  it("sums environments that read different transcript directories", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }]),
        ),
        environment(
          "env-b",
          summary([bucket()], [{ provider: "claude", hostId: "linux", homePath: "/b/.claude" }]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(20);
    expect(merged.records).toBe(10);
    expect(merged.duplicateSources).toHaveLength(0);
  });

  it("counts a shared transcript directory once", () => {
    // Two worktree servers on one machine resolve the same provider home.
    const shared = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [shared])),
        environment("env-b", summary([bucket()], [shared])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.records).toBe(5);
    expect(merged.sessions).toBe(1);
    expect(merged.duplicateSources).toHaveLength(1);
    expect(merged.contributingEnvironments).toEqual(["env-a"]);
  });

  it("drops only the duplicated provider, keeping the environment's other one", () => {
    const sharedClaude = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/home/theo/.claude",
    };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [sharedClaude])),
        environment(
          "env-b",
          summary(
            [bucket(), bucket({ provider: "codex", model: "gpt-5.6-sol", costUsd: 4 })],
            [sharedClaude, { provider: "codex", hostId: "mac", homePath: "/home/theo/.codex" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    // env-b's claude bucket is dropped, its codex bucket survives.
    expect(merged.costUsd).toBe(14);
    expect(merged.providers.map((provider) => provider.provider).sort()).toEqual([
      "claude",
      "codex",
    ]);
    expect(merged.sessions).toBe(2);
    expect(
      Object.fromEntries(
        merged.providers.map((provider) => [provider.provider, provider.sessions]),
      ),
    ).toEqual({ claude: 1, codex: 1 });
  });

  it("excludes an environment reporting an older contract version", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a" }]),
        ),
        environment(
          "env-b",
          summary(
            [bucket()],
            [{ provider: "claude", hostId: "linux", homePath: "/b" }],
            USAGE_CONTRACT_VERSION - 2,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.staleEnvironments).toEqual(["env-b"]);
  });

  it("keeps the previous compatible contract version so additive provider expansions still merge", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ costUsd: 10 })],
            [{ provider: "claude", hostId: "mac", homePath: "/a" }],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ costUsd: 4, provider: "codex", model: "gpt-5.6-sol" })],
            [{ provider: "codex", hostId: "linux", homePath: "/b" }],
            USAGE_CONTRACT_VERSION - 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(14);
    expect(merged.staleEnvironments).toEqual([]);
  });

  it("derives provider shares and cost quality", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ costUsd: 75 }),
              bucket({ provider: "codex", model: "gpt-5.6-sol", costUsd: 25, unpricedRecords: 5 }),
            ],
            [
              { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
              { provider: "codex", hostId: "mac", homePath: "/a/.codex" },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.providers[0]?.provider).toBe("claude");
    expect(merged.providers[0]?.costShare).toBeCloseTo(0.75, 5);
    expect(merged.costQuality.unpricedShare).toBeCloseTo(0.5, 5);
    expect(merged.costQuality.cacheSavingsUsd).toBe(4);
  });

  it("marks a model with no known rates as unpriced rather than free", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ costUsd: 75 }),
              bucket({
                provider: "codex",
                model: "unknown-model",
                costUsd: 0,
                costSource: "unpriced",
                unpricedRecords: 5,
              }),
            ],
            [
              { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
              { provider: "codex", hostId: "mac", homePath: "/a/.codex" },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.models.find((model) => model.model === "unknown-model")?.unpricedRecords).toBe(5);
    expect(merged.models.filter(isModelCostUnknown).map((model) => model.model)).toEqual([
      "unknown-model",
    ]);
  });

  it("keeps two machines apart when hostname and home path collide", () => {
    // Every Mac resolves /Users/theo/.claude, so a hostname clash used to make
    // one machine's usage vanish. Filesystem identity separates them.
    const shape = { provider: "claude" as const, hostId: "mac", homePath: "/Users/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [{ ...shape, volumeId: "16777220:1234" }])),
        environment("env-b", summary([bucket()], [{ ...shape, volumeId: "16777221:9999" }])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(20);
    expect(merged.duplicateSources).toHaveLength(0);
  });

  it("still collapses two servers reading the same directory", () => {
    const same = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/Users/theo/.claude",
      volumeId: "16777220:1234",
    };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [same])),
        environment("env-b", summary([bucket()], [same])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.duplicateSources).toHaveLength(1);
  });

  it("totals sessions from per-directory distinct counts, not per-bucket sums", () => {
    // One session that spans two days appears in two buckets. Summing bucket
    // sessions would say 2; the source's distinct count says 1.
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ day: "2026-08-06" as UsageDay }), bucket({ day: "2026-08-07" as UsageDay })],
            [
              {
                provider: "claude",
                hostId: "mac",
                homePath: "/a/.claude",
                distinctSessions: 1,
              },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.sessions).toBe(1);
    expect(merged.providers[0]?.sessions).toBe(1);
  });

  it("returns empty totals with no environments", () => {
    const merged = mergeUsage([], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(0);
    expect(merged.daily).toHaveLength(0);
    expect(merged.hourly).toHaveLength(0);
  });

  it("omits providers with no sessions or usage", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [],
            [
              {
                provider: "claude",
                hostId: "mac",
                homePath: "/a/.claude",
                distinctSessions: 0,
              },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.providers).toEqual([]);
  });

  it("derives hourly totals without losing the daily rollup", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ hourStart: "2026-08-07T09:37:00.000Z", costUsd: 3 }),
              bucket({ hourStart: "2026-08-07T10:37:00.000Z", costUsd: 7 }),
            ],
            [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.hourly.map((hour) => [hour.hourStart, hour.costUsd])).toEqual([
      ["2026-08-07T09:37:00.000Z", 3],
      ["2026-08-07T10:37:00.000Z", 7],
    ]);
    expect(merged.daily).toHaveLength(1);
    expect(merged.daily[0]?.costUsd).toBe(10);
  });
});

function kiroBucket(overrides: Partial<KiroUsageBucket> = {}): KiroUsageBucket {
  return {
    day: "2026-08-07" as UsageDay,
    model: "claude-sonnet-4.5",
    credits: 0.123456,
    records: 2,
    sessions: 1,
    ...overrides,
  };
}

function kiroSource(overrides: Partial<KiroUsageSource> = {}): KiroUsageSource {
  return {
    fingerprint: {
      hostId: "linux",
      resolvedHomePath: "/home/user/.local/share/kiro-cli",
      volumeId: "100:200",
    },
    status: "ok",
    scannedFiles: 1,
    skippedFiles: 0,
    malformedRecords: 0,
    distinctSessions: 1,
    message: null,
    buckets: [kiroBucket()],
    ...overrides,
  };
}

function kiroSummary(sources: readonly KiroUsageSource[]): UsageSummary {
  return { ...summary([], []), kiro: { sources } };
}

describe("Kiro usage extension", () => {
  it("preserves decoding in v5 clients that do not know the extension", () => {
    const standard = summary(
      [bucket()],
      [{ provider: "claude", hostId: "linux", homePath: "/home/user/.claude" }],
    );
    const extended = { ...standard, kiro: { sources: [kiroSource()] } };

    expect(decodeLegacySummary(extended)).toEqual(standard);
    expect(decodeSummary(standard)).toEqual(standard);
    expect(decodeSummary(extended)).toEqual(extended);
    expect(USAGE_CONTRACT_VERSION).toBe(5);
  });

  it("leaves legacy summaries unchanged without the extension", () => {
    const merged = mergeUsage([environment("old-server", summary([], []))], USAGE_CONTRACT_VERSION);
    expect(merged).not.toHaveProperty("kiro");
  });

  it("merges fractional credits without pricing them in USD or estimating tokens", () => {
    const original = summary(
      [bucket()],
      [{ provider: "claude", hostId: "linux", homePath: "/home/user/.claude" }],
    );
    const merged = mergeUsage(
      [
        environment("server", {
          ...original,
          kiro: {
            sources: [
              kiroSource({
                buckets: [kiroBucket(), kiroBucket({ credits: 0.000001 })],
              }),
            ],
          },
        }),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(merged.kiro?.credits).toBeCloseTo(0.123457, 12);
    expect(merged.kiro?.models[0]?.credits).toBeCloseTo(0.123457, 12);
    expect(merged.kiro?.daily[0]?.credits).toBeCloseTo(0.123457, 12);
    expect(merged.kiro).toMatchObject({
      records: 4,
      sessions: 1,
      totalTokens: null,
      tokenRecords: 0,
      partial: false,
      unavailable: false,
    });
    const { kiro: _kiro, ...standard } = merged;
    expect(standard).toEqual(mergeUsage([environment("server", original)], USAGE_CONTRACT_VERSION));
  });

  it("deduplicates a physical source in stable environment order", () => {
    const merged = mergeUsage(
      [
        environment("z", kiroSummary([kiroSource()])),
        environment("a", kiroSummary([kiroSource()])),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(merged.kiro).toMatchObject({ credits: 0.123456, records: 2, sessions: 1 });
    expect(merged.duplicateSources).toEqual(["z: /home/user/.local/share/kiro-cli"]);
    expect(merged.contributingEnvironments).toEqual(["a"]);
  });

  it("prefers a complete scan over failed or partial duplicate sources", () => {
    const environments = [
      environment(
        "a-failed",
        kiroSummary([
          kiroSource({
            status: "failed",
            buckets: [],
            distinctSessions: 0,
            message: "History could not be read.",
          }),
        ]),
      ),
      environment("b-partial", kiroSummary([kiroSource({ status: "partial" })])),
      environment(
        "z-complete",
        kiroSummary([kiroSource({ buckets: [kiroBucket({ credits: 3, records: 5 })] })]),
      ),
    ];
    const merged = mergeUsage(environments, USAGE_CONTRACT_VERSION);
    expect(merged.kiro).toMatchObject({
      credits: 3,
      records: 5,
      sessions: 1,
      partial: false,
      unavailable: false,
      messages: [],
    });
    expect(merged.contributingEnvironments).toEqual(["z-complete"]);
    expect(merged.duplicateSources).toHaveLength(2);
    expect(mergeUsage(environments.toReversed(), USAGE_CONTRACT_VERSION)).toEqual(merged);
  });

  it("retains partial data when the other scan of the same source failed", () => {
    const merged = mergeUsage(
      [
        environment(
          "a-failed",
          kiroSummary([kiroSource({ status: "failed", buckets: [], distinctSessions: 0 })]),
        ),
        environment("z-partial", kiroSummary([kiroSource({ status: "partial" })])),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(merged.kiro).toMatchObject({
      credits: 0.123456,
      records: 2,
      partial: true,
      unavailable: false,
    });
    expect(merged.contributingEnvironments).toEqual(["z-partial"]);
  });

  it("keeps different filesystem identities even with matching hostnames and paths", () => {
    const source = kiroSource();
    const merged = mergeUsage(
      [
        environment("a", kiroSummary([source])),
        environment(
          "b",
          kiroSummary([
            kiroSource({
              fingerprint: { ...source.fingerprint, volumeId: "100:201" },
            }),
          ]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(merged.kiro?.credits).toBeCloseTo(0.246912, 12);
    expect(merged.kiro).toMatchObject({ records: 4, sessions: 2 });
    expect(merged.duplicateSources).toEqual([]);
    expect(merged.contributingEnvironments).toEqual(["a", "b"]);
  });

  it("sums only real tokens and reports incomplete record coverage per model", () => {
    const merged = mergeUsage(
      [
        environment(
          "a",
          kiroSummary([
            kiroSource({
              buckets: [
                kiroBucket(),
                kiroBucket({
                  totals: { ...bucket().totals, reasoningTokens: 40 },
                  tokenRecords: 1,
                }),
                kiroBucket({ model: "unknown-token-model" }),
              ],
            }),
          ]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(merged.kiro).toMatchObject({ totalTokens: 1160, tokenRecords: 1, records: 6 });
    expect(merged.kiro?.models).toMatchObject([
      { model: "claude-sonnet-4.5", totalTokens: 1160, tokenRecords: 1, records: 4 },
      { model: "unknown-token-model", totalTokens: null, tokenRecords: 0, records: 2 },
    ]);
    expect(merged.totalTokens).toBe(0);
  });

  it("recognizes real zero token counts when a record supplies them", () => {
    const merged = mergeUsage(
      [
        environment(
          "a",
          kiroSummary([
            kiroSource({
              buckets: [
                kiroBucket({
                  totals: {
                    uncachedInputTokens: 0,
                    cachedInputTokens: 0,
                    cacheCreationTokens: 0,
                    outputTokens: 0,
                    reasoningTokens: 0,
                  },
                }),
              ],
            }),
          ]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(merged.kiro).toMatchObject({ totalTokens: 0, tokenRecords: 2 });
  });

  it("distinguishes an unreadable source from a successful scan with zero usage", () => {
    const unavailable = mergeUsage(
      [
        environment(
          "a",
          kiroSummary([
            kiroSource({
              status: "missing",
              message: "Kiro history was not found.",
              buckets: [],
              distinctSessions: 0,
            }),
          ]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(unavailable.kiro).toMatchObject({
      credits: 0,
      unavailable: true,
      partial: true,
      messages: ["a: Kiro history was not found."],
    });
    const empty = mergeUsage(
      [environment("a", kiroSummary([kiroSource({ buckets: [], distinctSessions: 0 })]))],
      USAGE_CONTRACT_VERSION,
    );
    expect(empty.kiro).toMatchObject({
      credits: 0,
      records: 0,
      sessions: 0,
      unavailable: false,
      partial: false,
      messages: [],
    });
  });

  it("reports unavailable when every parsed record was malformed", () => {
    const merged = mergeUsage(
      [
        environment(
          "a",
          kiroSummary([
            kiroSource({
              status: "partial",
              malformedRecords: 2,
              buckets: [],
              distinctSessions: 0,
              message: "No session contained valid usage records.",
            }),
          ]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(merged.kiro).toMatchObject({
      records: 0,
      unavailable: true,
      partial: true,
      messages: ["a: No session contained valid usage records."],
    });
  });

  it("keeps partial data and messages without inventing usage for failed sources", () => {
    const partial = kiroSource({ status: "partial", message: "One session could not be read." });
    const failed = kiroSource({
      fingerprint: { ...partial.fingerprint, volumeId: "other-volume" },
      status: "failed",
      message: "Kiro history could not be read.",
      buckets: [],
      distinctSessions: 0,
    });
    const merged = mergeUsage(
      [environment("a", kiroSummary([partial])), environment("b", kiroSummary([failed]))],
      USAGE_CONTRACT_VERSION,
    );
    expect(merged.kiro).toMatchObject({
      credits: 0.123456,
      records: 2,
      partial: true,
      unavailable: false,
      messages: ["a: One session could not be read.", "b: Kiro history could not be read."],
    });
  });

  it("ignores Kiro data from incompatible environments", () => {
    const merged = mergeUsage(
      [
        environment("current", kiroSummary([kiroSource()])),
        environment("old", {
          ...kiroSummary([kiroSource()]),
          contractVersion: 1,
        }),
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(merged.kiro?.credits).toBe(0.123456);
    expect(merged.staleEnvironments).toEqual(["old"]);
    expect(merged.duplicateSources).toEqual([]);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects invalid credit values at the contract boundary: %s",
    (credits) => {
      expect(() => decodeKiroBucket(kiroBucket({ credits }))).toThrow();
    },
  );
});
