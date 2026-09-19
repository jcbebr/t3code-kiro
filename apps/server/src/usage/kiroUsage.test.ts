// @effect-diagnostics nodeBuiltinImport:off - the scanner tests use disposable native session snapshots.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { makeKiroUsageReader, parseKiroUsageDocument } from "./kiroUsage.ts";

function turn(id = "response-a", overrides: Record<string, unknown> = {}) {
  return {
    result: { Ok: { id } },
    loop_id: { agent_id: { name: "kiro_default", parent_id: null, rand: null }, rand: 12 },
    end_timestamp: "2026-09-18T21:21:07.864942506Z",
    model: "auto",
    metering_usage: [{ value: 0.25, unit: "credit", unitPlural: "credits" }],
    input_token_count: 0,
    output_token_count: 0,
    cache_read_input_token_count: 0,
    cache_write_input_token_count: 0,
    ...overrides,
  };
}

function session(turns: readonly unknown[] = [turn()], sessionId = "session-a") {
  return {
    session_id: sessionId,
    created_at: "2026-09-17T20:00:00Z",
    updated_at: "2026-09-19T20:00:00Z",
    session_created_reason: "subagent",
    session_state: { conversation_metadata: { user_turn_metadatas: turns } },
  };
}

describe("parseKiroUsageDocument", () => {
  it("reads native credits and treats billed zero-token placeholders as unavailable", () => {
    const result = parseKiroUsageDocument(session());
    expect(result?.malformedRecords).toBe(0);
    expect(result?.records).toHaveLength(1);
    expect(result?.records[0]).toMatchObject({
      sessionId: "session-a",
      model: "auto",
      credits: 0.25,
      timestampMs: 1789766467864,
    });
    expect(result?.records[0]).not.toHaveProperty("totals");
  });

  it("preserves real reported tokens separately from credits", () => {
    const result = parseKiroUsageDocument(
      session([
        turn("response-a", {
          input_token_count: 10,
          output_token_count: 20,
          cache_read_input_token_count: 30,
          cache_write_input_token_count: 40,
        }),
      ]),
    );
    expect(result?.records[0]?.totals).toEqual({
      uncachedInputTokens: 10,
      cachedInputTokens: 30,
      cacheCreationTokens: 40,
      outputTokens: 20,
      reasoningTokens: 0,
    });
    expect(result?.records[0]?.credits).toBe(0.25);
  });

  it.each([-1, Infinity, NaN])("rejects invalid credit value %s", (value) => {
    const result = parseKiroUsageDocument(
      session([turn("bad", { metering_usage: [{ value, unit: "credit" }] }), turn("good")]),
    );
    expect(result?.malformedRecords).toBe(1);
    expect(result?.records).toHaveLength(1);
    expect(result?.records[0]?.credits).toBe(0.25);
  });

  it("does not mistake other units, missing meters, timestamps or IDs for valid credits", () => {
    const result = parseKiroUsageDocument(
      session([
        turn("usd", { metering_usage: [{ value: 10, unit: "usd" }] }),
        turn("empty", { metering_usage: [] }),
        turn("missing", { metering_usage: undefined }),
        turn("time", { end_timestamp: "not-a-date" }),
        turn("model", { model: "   " }),
        turn("identity", { result: undefined, loop_id: {} }),
      ]),
    );
    expect(result).toEqual({ records: [], malformedRecords: 6 });
  });

  it("counts reported zero credits and sums credit meters without converting other units", () => {
    const result = parseKiroUsageDocument(
      session([
        turn("zero", { metering_usage: [{ value: 0, unit: "credit" }] }),
        turn("mixed", {
          metering_usage: [
            { value: 0.125, unit: "credit" },
            { value: 0.25, unit: "credit" },
            { value: 100, unit: "request" },
          ],
        }),
      ]),
    );
    expect(result?.records.map((record) => record.credits)).toEqual([0, 0.375]);
  });

  it("canonicalizes fallback loop IDs regardless of JSON property order", () => {
    const result = parseKiroUsageDocument(
      session([
        turn("a", {
          result: undefined,
          loop_id: { rand: 12, agent_id: { name: "kiro", rand: 1 } },
        }),
        turn("b", {
          result: undefined,
          loop_id: { agent_id: { rand: 1, name: "kiro" }, rand: 12 },
        }),
      ]),
    );
    expect(result?.records[0]?.dedupeKey).toBe(result?.records[1]?.dedupeKey);
  });

  it("keeps valid credits when token metadata is unavailable or malformed", () => {
    const result = parseKiroUsageDocument(
      session([turn("invalid-tokens", { output_token_count: -1 })]),
    );
    expect(result?.records[0]?.credits).toBe(0.25);
    expect(result?.records[0]).not.toHaveProperty("totals");
  });

  it("rejects unsupported documents and overflowing meter sums", () => {
    expect(parseKiroUsageDocument({ messages: [] })).toBeNull();
    expect(parseKiroUsageDocument(null)).toBeNull();
    expect(
      parseKiroUsageDocument(
        session([
          turn("overflow", {
            metering_usage: [
              { value: Number.MAX_VALUE, unit: "credit" },
              { value: Number.MAX_VALUE, unit: "credit" },
            ],
          }),
        ]),
      ),
    ).toEqual({ records: [], malformedRecords: 1 });
  });
});

describe("readKiroUsageSource", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-usage-test-"));
  });
  afterEach(async () => {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  });

  const options = () => ({
    directory,
    hostId: "test-host",
    timeZone: "America/Sao_Paulo",
    sinceDay: "2026-09-18",
    untilDay: "2026-09-18",
  });
  const write = (name: string, value: unknown) =>
    NodeFSP.writeFile(NodePath.join(directory, name), JSON.stringify(value));

  it("aggregates native history across models and deduplicates resumed snapshots", async () => {
    const first = turn("first");
    const second = turn("second", { model: "claude-sonnet-4.5" });
    await write("original.json", session([first]));
    await write("resumed.json", session([first, first, second]));
    await write("second-session.json", session([first], "session-b"));
    await NodeFSP.writeFile(NodePath.join(directory, "messages.jsonl"), "invalid chat data");
    const result = await makeKiroUsageReader()(options());
    expect(result).toMatchObject({ status: "ok", scannedFiles: 3, distinctSessions: 2 });
    expect(result.fingerprint).toMatchObject({
      hostId: "test-host",
      resolvedHomePath: await NodeFSP.realpath(directory),
    });
    expect(result.fingerprint.volumeId).toMatch(/^\d+:\d+$/);
    expect(result.buckets).toEqual([
      { day: "2026-09-18", model: "auto", credits: 0.5, records: 2, sessions: 2 },
      { day: "2026-09-18", model: "claude-sonnet-4.5", credits: 0.25, records: 1, sessions: 1 },
    ]);
  });

  it("buckets by each turn's local day, not file or session timestamp", async () => {
    await write(
      "session.json",
      session([
        turn("before", { end_timestamp: "2026-09-18T02:59:59Z" }),
        turn("start", { end_timestamp: "2026-09-18T03:00:00Z" }),
        turn("end", { end_timestamp: "2026-09-19T02:59:59Z" }),
        turn("after", { end_timestamp: "2026-09-19T03:00:00Z" }),
      ]),
    );
    const result = await makeKiroUsageReader()(options());
    expect(result.buckets).toEqual([
      { day: "2026-09-18", model: "auto", credits: 0.5, records: 2, sessions: 1 },
    ]);
  });

  it("uses inclusive/exclusive rolling-hour bounds across a daylight-saving transition", async () => {
    await write(
      "session.json",
      session([
        turn("before", { end_timestamp: "2026-11-01T05:14:59Z" }),
        turn("start", { end_timestamp: "2026-11-01T05:15:00Z" }),
        turn("same", { end_timestamp: "2026-11-01T06:14:59Z" }),
        turn("next", { end_timestamp: "2026-11-01T06:15:00Z" }),
        turn("after", { end_timestamp: "2026-11-01T07:15:00Z" }),
      ]),
    );
    await NodeFSP.utimes(NodePath.join(directory, "session.json"), 1793517300, 1793517300);
    const result = await makeKiroUsageReader()({
      ...options(),
      timeZone: "America/New_York",
      sinceDay: "2026-11-01",
      untilDay: "2026-11-01",
      resolution: "hour",
      sinceTime: "2026-11-01T05:15:00Z",
      untilTime: "2026-11-01T07:15:00Z",
    });
    expect(result.buckets).toEqual([
      {
        day: "2026-11-01",
        hourStart: "2026-11-01T05:15:00.000Z",
        model: "auto",
        credits: 0.5,
        records: 2,
        sessions: 1,
      },
      {
        day: "2026-11-01",
        hourStart: "2026-11-01T06:15:00.000Z",
        model: "auto",
        credits: 0.25,
        records: 1,
        sessions: 1,
      },
    ]);
  });

  it("reports token coverage only for records with positive reported tokens", async () => {
    await write(
      "session.json",
      session([turn("unknown"), turn("known", { output_token_count: 10 })]),
    );
    const result = await makeKiroUsageReader()(options());
    expect(result.buckets[0]).toMatchObject({
      credits: 0.5,
      records: 2,
      tokenRecords: 1,
      totals: {
        outputTokens: 10,
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      },
    });
  });

  it("replaces changed cached snapshots, retries corruption, and drops removed files", async () => {
    const read = makeKiroUsageReader();
    await write("session.json", session());
    expect((await read(options())).buckets[0]?.records).toBe(1);
    expect((await read(options())).buckets[0]?.records).toBe(1);
    await write("session.json", session([turn(), turn("new")]));
    expect((await read(options())).buckets[0]?.records).toBe(2);
    await NodeFSP.writeFile(NodePath.join(directory, "session.json"), "{");
    expect(await read(options())).toMatchObject({ status: "failed", skippedFiles: 1, buckets: [] });
    await write("session.json", session([turn("restored")]));
    expect((await read(options())).buckets[0]?.records).toBe(1);
    await NodeFSP.unlink(NodePath.join(directory, "session.json"));
    expect(await read(options())).toMatchObject({ status: "ok", buckets: [], distinctSessions: 0 });
  });

  it("degrades to partial while retaining valid records from readable files", async () => {
    await write("valid.json", session([turn(), turn("bad", { metering_usage: [] })]));
    await NodeFSP.writeFile(NodePath.join(directory, "corrupt.json"), "invalid");
    await write("unsupported.json", {});
    const result = await makeKiroUsageReader()(options());
    expect(result).toMatchObject({
      status: "partial",
      scannedFiles: 1,
      skippedFiles: 2,
      malformedRecords: 2,
    });
    expect(result.buckets[0]?.credits).toBe(0.25);
  });

  it("distinguishes a missing source from a path that cannot be scanned", async () => {
    const read = makeKiroUsageReader();
    expect(
      await read({ ...options(), directory: NodePath.join(directory, "absent") }),
    ).toMatchObject({ status: "missing", buckets: [] });
    await write("file.json", session());
    expect(
      await read({ ...options(), directory: NodePath.join(directory, "file.json") }),
    ).toMatchObject({ status: "failed", buckets: [] });
  });

  it("skips old snapshots without marking coverage partial", async () => {
    await write("old.json", session());
    await NodeFSP.utimes(NodePath.join(directory, "old.json"), 1, 1);
    expect(await makeKiroUsageReader()(options())).toMatchObject({
      status: "ok",
      skippedFiles: 1,
      scannedFiles: 0,
      buckets: [],
    });
  });

  it("keeps per-window session counts and handles an invalid time zone like existing usage", async () => {
    await write("session.json", session());
    const read = makeKiroUsageReader();
    expect((await read({ ...options(), timeZone: "not/a-zone" })).buckets[0]?.day).toBe(
      "2026-09-18",
    );
    expect(
      await read({ ...options(), sinceDay: "2026-09-20", untilDay: "2026-09-20" }),
    ).toMatchObject({ distinctSessions: 0, buckets: [] });
  });

  it("rejects hourly windows without exact valid bounds", async () => {
    await expect(makeKiroUsageReader()({ ...options(), resolution: "hour" })).rejects.toThrow(
      "valid sinceTime",
    );
  });
});
