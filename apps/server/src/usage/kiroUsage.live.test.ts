import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { KiroSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeKiroAcpRuntime } from "../provider/acp/KiroAcpSupport.ts";
import { makeKiroUsageReader } from "./kiroUsage.ts";

// Explicit opt-in: one short prompt is charged to the signed-in Kiro account.
it.live.skipIf(process.env.T3_KIRO_USAGE_LIVE !== "1")(
  "reads native metering persisted by a real Kiro ACP turn",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-usage-live-" });
      const settings = yield* Schema.decodeEffect(KiroSettings)({
        enabled: true,
        binaryPath: process.env.T3_KIRO_BINARY_PATH || "kiro-cli",
      });
      const sessionId = yield* Effect.gen(function* () {
        const runtime = yield* makeKiroAcpRuntime(settings, process.env, {
          cwd: directory,
          clientInfo: { name: "t3-kiro-usage-probe", version: "0.0.0" },
        });
        yield* runtime.handleRequestPermission(() =>
          Effect.succeed({ outcome: { outcome: "cancelled" } }),
        );
        const started = yield* runtime.start();
        let answer = "";
        yield* runtime.getEvents().pipe(
          Stream.runForEach((event) => {
            if (event._tag === "EventStreamBarrier") {
              return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
            }
            if (event._tag === "ContentDelta") answer += event.text;
            return Effect.void;
          }),
          Effect.forkScoped({ startImmediately: true }),
        );
        const response = yield* runtime.prompt({
          prompt: [
            {
              type: "text",
              text: "Reply with exactly KIRO_USAGE_OK. Do not use tools or read any files.",
            },
          ],
        });
        yield* runtime.drainEvents;
        expect(response.stopReason).toBe("end_turn");
        expect(answer).toContain("KIRO_USAGE_OK");
        return started.sessionId;
      }).pipe(Effect.scoped);

      const nativePath = path.join(
        NodeOS.homedir(),
        ".kiro",
        "sessions",
        "cli",
        `${sessionId}.json`,
      );
      const safeMetadata = Schema.Struct({
        session_id: Schema.String,
        session_state: Schema.Struct({
          conversation_metadata: Schema.Struct({
            user_turn_metadatas: Schema.Array(
              Schema.Struct({
                end_timestamp: Schema.String,
                model: Schema.String,
                metering_usage: Schema.Array(
                  Schema.Struct({ value: Schema.Finite, unit: Schema.String }),
                ),
                input_token_count: Schema.optional(Schema.Int),
                output_token_count: Schema.optional(Schema.Int),
                cache_read_input_token_count: Schema.optional(Schema.Int),
                cache_write_input_token_count: Schema.optional(Schema.Int),
                result: Schema.Struct({ Ok: Schema.Struct({ id: Schema.String }) }),
              }),
            ),
          }),
        }),
      });
      const raw = yield* fs.readFileString(nativePath);
      const safe = yield* Schema.decodeEffect(Schema.fromJsonString(safeMetadata))(raw);
      const expectedCredits = safe.session_state.conversation_metadata.user_turn_metadatas
        .flatMap((turn) => turn.metering_usage)
        .filter((entry) => entry.unit === "credit")
        .reduce((sum, entry) => sum + entry.value, 0);
      expect(expectedCredits).toBeGreaterThan(0);
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(safeMetadata))(safe);
      yield* fs.writeFileString(path.join(directory, "session.json"), encoded);
      const now = yield* DateTime.now;
      const day = DateTime.formatIsoDate(now);
      const read = makeKiroUsageReader();
      const input = {
        directory,
        hostId: "live-probe",
        timeZone: "UTC",
        sinceDay: day,
        untilDay: day,
      };
      const source = yield* Effect.promise(() => read(input));
      expect(source.status).toBe("ok");
      expect(source.distinctSessions).toBe(1);
      expect(source.buckets.reduce((sum, bucket) => sum + bucket.credits, 0)).toBeCloseTo(
        expectedCredits,
        12,
      );
      expect(yield* Effect.promise(() => read(input))).toEqual(source);
      yield* Effect.logInfo("Kiro live usage verified", {
        credits: expectedCredits,
        records: source.buckets.reduce((sum, bucket) => sum + bucket.records, 0),
        tokenRecords: source.buckets.reduce((sum, bucket) => sum + (bucket.tokenRecords ?? 0), 0),
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 120_000 },
);
