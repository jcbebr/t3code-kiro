// @effect-diagnostics nodeBuiltinImport:off - the native JSON scanner shares the filesystem boundary of usageTranscriptReader.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type KiroUsageBucket,
  type KiroUsageSource,
  type UsageDay,
  type UsageResolution,
  type UsageTokenTotals,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { addTotals, EMPTY_TOTALS, totalTokens } from "./usageTranscripts.ts";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const NonNegativeNumber = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const TokenCount = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const SessionDocument = Schema.Struct({
  session_id: NonEmptyString,
  session_state: Schema.Struct({
    conversation_metadata: Schema.Struct({ user_turn_metadatas: Schema.Array(Schema.Unknown) }),
  }),
});
const TurnMetadata = Schema.Struct({
  end_timestamp: NonEmptyString,
  model: NonEmptyString,
  metering_usage: Schema.Array(Schema.Struct({ value: NonNegativeNumber, unit: Schema.String })),
  result: Schema.optional(Schema.Unknown),
  loop_id: Schema.optional(Schema.Unknown),
  input_token_count: Schema.optional(Schema.Unknown),
  output_token_count: Schema.optional(Schema.Unknown),
  cache_read_input_token_count: Schema.optional(Schema.Unknown),
  cache_write_input_token_count: Schema.optional(Schema.Unknown),
});
const ResponseIdentity = Schema.Struct({ Ok: Schema.Struct({ id: NonEmptyString }) });
const TokenCounts = Schema.Struct({
  input_token_count: Schema.optional(TokenCount),
  output_token_count: Schema.optional(TokenCount),
  cache_read_input_token_count: Schema.optional(TokenCount),
  cache_write_input_token_count: Schema.optional(TokenCount),
});
const decodeSession = Schema.decodeUnknownOption(SessionDocument);
const decodeTurn = Schema.decodeUnknownOption(TurnMetadata);
const decodeResponseIdentity = Schema.decodeUnknownOption(ResponseIdentity);
const decodeLoopIdentity = Schema.decodeUnknownOption(Schema.JsonObject);
const decodeTokenCounts = Schema.decodeUnknownOption(TokenCounts);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const isMissingFile = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

interface KiroUsageRecord {
  readonly sessionId: string;
  readonly dedupeKey: string;
  readonly timestampMs: number;
  readonly model: string;
  readonly credits: number;
  readonly totals?: UsageTokenTotals;
}

function stableJson(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) return value.map(stableJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stableJson(child)]),
  );
}

/** Keeps only usage fields; prompts and responses never enter the scan cache. */
export function parseKiroUsageDocument(document: unknown) {
  const session = decodeSession(document);
  if (Option.isNone(session)) return null;
  const records: KiroUsageRecord[] = [];
  let malformedRecords = 0;
  for (const input of session.value.session_state.conversation_metadata.user_turn_metadatas) {
    const decoded = decodeTurn(input);
    if (Option.isNone(decoded)) {
      malformedRecords += 1;
      continue;
    }
    const turn = decoded.value;
    const timestamp = DateTime.make(turn.end_timestamp);
    const response = decodeResponseIdentity(turn.result);
    const loop = decodeLoopIdentity(turn.loop_id);
    const identity = Option.isSome(response)
      ? ["response", response.value.Ok.id]
      : Option.isSome(loop) && Object.keys(loop.value).length > 0
        ? ["loop", stableJson(loop.value)]
        : null;
    const meters = turn.metering_usage.filter((meter) => meter.unit === "credit");
    const credits = meters.reduce((sum, meter) => sum + meter.value, 0);
    if (
      Option.isNone(timestamp) ||
      identity === null ||
      turn.model.trim().length === 0 ||
      meters.length === 0 ||
      !Number.isFinite(credits)
    ) {
      malformedRecords += 1;
      continue;
    }
    const counts = decodeTokenCounts(turn);
    const totals = Option.isSome(counts)
      ? {
          uncachedInputTokens: counts.value.input_token_count ?? 0,
          cachedInputTokens: counts.value.cache_read_input_token_count ?? 0,
          cacheCreationTokens: counts.value.cache_write_input_token_count ?? 0,
          outputTokens: counts.value.output_token_count ?? 0,
          reasoningTokens: 0,
        }
      : undefined;
    // Kiro 2.22 persists zero placeholders even for billed turns. Those are
    // unavailable token counts, not evidence that the model used no tokens.
    const hasTokens = totals !== undefined && totalTokens(totals) > 0;
    records.push({
      sessionId: session.value.session_id,
      dedupeKey: JSON.stringify([session.value.session_id, identity]),
      timestampMs: DateTime.toEpochMillis(timestamp.value),
      model: turn.model.trim(),
      credits,
      ...(hasTokens ? { totals } : {}),
    });
  }
  return { records, malformedRecords };
}

export interface KiroUsageReadInput {
  readonly directory: string;
  readonly hostId: string;
  readonly timeZone: string;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly resolution?: UsageResolution | undefined;
  readonly sinceTime?: string | undefined;
  readonly untilTime?: string | undefined;
}

interface CachedSession {
  readonly stamp: string;
  readonly parsed: NonNullable<ReturnType<typeof parseKiroUsageDocument>>;
}

interface MutableBucket {
  readonly day: UsageDay;
  readonly hourStart?: string;
  readonly model: string;
  credits: number;
  records: number;
  readonly sessions: Set<string>;
  totals: UsageTokenTotals;
  tokenRecords: number;
}

const HOUR_MS = 60 * 60 * 1000;
const MTIME_SLACK_MS = 36 * HOUR_MS;

/** One service owns one cache; changed snapshots are reread, never appended. */
export function makeKiroUsageReader() {
  const cache = new Map<string, CachedSession>();

  return async function readKiroUsageSource(input: KiroUsageReadInput): Promise<KiroUsageSource> {
    const zone = Option.getOrElse(DateTime.zoneMakeNamed(input.timeZone), () =>
      DateTime.zoneMakeOffset(0),
    );
    const since = input.sinceTime === undefined ? Option.none() : DateTime.make(input.sinceTime);
    const until = input.untilTime === undefined ? Option.none() : DateTime.make(input.untilTime);
    const hourly = input.resolution === "hour";
    if (
      hourly &&
      (Option.isNone(since) ||
        Option.isNone(until) ||
        DateTime.toEpochMillis(since.value) >= DateTime.toEpochMillis(until.value))
    ) {
      throw new Error("Hourly Kiro usage requires valid sinceTime and untilTime bounds.");
    }
    const sinceTimeMs = Option.isSome(since) ? DateTime.toEpochMillis(since.value) : 0;
    const untilTimeMs = Option.isSome(until) ? DateTime.toEpochMillis(until.value) : 0;
    const sinceDayStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    const oldestFileTimeMs =
      (hourly
        ? sinceTimeMs
        : Option.isSome(sinceDayStart)
          ? DateTime.toEpochMillis(sinceDayStart.value)
          : 0) - MTIME_SLACK_MS;
    let directory = NodePath.resolve(input.directory);
    let volumeId = "";
    const base = () => ({
      fingerprint: { hostId: input.hostId, resolvedHomePath: directory, volumeId },
      scannedFiles: 0,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 0,
      buckets: [],
    });
    let files: string[];
    try {
      directory = await NodeFSP.realpath(directory);
      const stat = await NodeFSP.stat(directory);
      volumeId = `${stat.dev}:${stat.ino}`;
      files = (await NodeFSP.readdir(directory, { withFileTypes: true }))
        .filter(
          (entry) => entry.name.endsWith(".json") && (entry.isFile() || entry.isSymbolicLink()),
        )
        .map((entry) => NodePath.join(directory, entry.name))
        .sort();
    } catch (error) {
      return {
        ...base(),
        status: isMissingFile(error) ? "missing" : "failed",
        message: isMissingFile(error)
          ? "No Kiro session directory on this environment."
          : "Could not read the Kiro session directory.",
      };
    }
    const livePaths = new Set(files);
    for (const path of cache.keys()) {
      if (NodePath.dirname(path) === directory && !livePaths.has(path)) cache.delete(path);
    }

    const buckets = new Map<string, MutableBucket>();
    const seen = new Set<string>();
    const sessions = new Set<string>();
    let scannedFiles = 0;
    let skippedFiles = 0;
    let failedFiles = 0;
    let malformedRecords = 0;
    for (const path of files) {
      let parsed: NonNullable<ReturnType<typeof parseKiroUsageDocument>>;
      try {
        const stat = await NodeFSP.stat(path);
        // A session snapshot's mtime follows its latest turn. The same wide
        // slack as transcript scanning covers local days and clock skew.
        if (stat.mtimeMs < oldestFileTimeMs) {
          skippedFiles += 1;
          cache.delete(path);
          continue;
        }
        const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        const cached = cache.get(path);
        if (cached?.stamp === stamp) {
          parsed = cached.parsed;
        } else {
          const decoded = parseKiroUsageDocument(decodeJson(await NodeFSP.readFile(path, "utf8")));
          if (decoded === null) {
            malformedRecords += 1;
            skippedFiles += 1;
            failedFiles += 1;
            cache.delete(path);
            continue;
          }
          parsed = decoded;
          cache.set(path, { stamp, parsed });
        }
      } catch {
        skippedFiles += 1;
        failedFiles += 1;
        cache.delete(path);
        continue;
      }
      scannedFiles += 1;
      malformedRecords += parsed.malformedRecords;
      for (const record of parsed.records) {
        if (seen.has(record.dedupeKey)) continue;
        seen.add(record.dedupeKey);
        if (hourly && (record.timestampMs < sinceTimeMs || record.timestampMs >= untilTimeMs)) {
          continue;
        }
        const instant = DateTime.makeUnsafe(record.timestampMs);
        const day = DateTime.formatIsoDate(DateTime.setZone(instant, zone)) as UsageDay;
        if (!hourly && (day < input.sinceDay || day > input.untilDay)) continue;
        const hourStart = hourly
          ? DateTime.formatIso(
              DateTime.makeUnsafe(
                sinceTimeMs + Math.floor((record.timestampMs - sinceTimeMs) / HOUR_MS) * HOUR_MS,
              ),
            )
          : undefined;
        const key = JSON.stringify([day, hourStart, record.model]);
        let bucket = buckets.get(key);
        if (bucket === undefined) {
          bucket = {
            day,
            ...(hourStart === undefined ? {} : { hourStart }),
            model: record.model,
            credits: 0,
            records: 0,
            sessions: new Set(),
            totals: EMPTY_TOTALS,
            tokenRecords: 0,
          };
          buckets.set(key, bucket);
        }
        if (!Number.isFinite(bucket.credits + record.credits)) {
          malformedRecords += 1;
          continue;
        }
        bucket.credits += record.credits;
        bucket.records += 1;
        bucket.sessions.add(record.sessionId);
        sessions.add(record.sessionId);
        if (record.totals !== undefined) {
          bucket.totals = addTotals(bucket.totals, record.totals);
          bucket.tokenRecords += 1;
        }
      }
    }
    const result: KiroUsageBucket[] = [...buckets.values()].map((bucket) => ({
      day: bucket.day,
      ...(bucket.hourStart === undefined ? {} : { hourStart: bucket.hourStart }),
      model: bucket.model,
      credits: bucket.credits,
      records: bucket.records,
      sessions: bucket.sessions.size,
      ...(bucket.tokenRecords > 0
        ? { totals: bucket.totals, tokenRecords: bucket.tokenRecords }
        : {}),
    }));
    result.sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        (a.hourStart ?? "").localeCompare(b.hourStart ?? "") ||
        a.model.localeCompare(b.model),
    );
    const incomplete = failedFiles > 0 || malformedRecords > 0;
    return {
      ...base(),
      status: failedFiles > 0 && scannedFiles === 0 ? "failed" : incomplete ? "partial" : "ok",
      scannedFiles,
      skippedFiles,
      malformedRecords,
      distinctSessions: sessions.size,
      message: incomplete ? "Some Kiro session files or usage records could not be read." : null,
      buckets: result,
    };
  };
}
