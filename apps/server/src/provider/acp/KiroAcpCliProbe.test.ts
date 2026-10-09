import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { KiroSettings } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeKiroAcpRuntime } from "./KiroAcpSupport.ts";

const settings = Schema.decodeSync(KiroSettings)({
  enabled: true,
  binaryPath: process.env.T3_KIRO_BINARY_PATH || "kiro-cli",
});

// Opt in only after CLI login. This sends one small prompt using the signed-in account.
it.effect.skipIf(process.env.T3_KIRO_LIVE_TURN !== "1")(
  "connects with the native Kiro login, streams a real answer and reloads the session",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-live-" });
      const makeRuntime = (resumeSessionId?: string) =>
        makeKiroAcpRuntime(settings, process.env, {
          cwd,
          clientInfo: { name: "t3-kiro-probe", version: "0.0.0" },
          ...(resumeSessionId ? { resumeSessionId } : {}),
        });
      const savedSessionId = yield* Effect.gen(function* () {
        const runtime = yield* makeRuntime();
        yield* runtime.handleRequestPermission(() =>
          Effect.succeed({ outcome: { outcome: "cancelled" } }),
        );
        const started = yield* runtime.start();
        let text = "";
        yield* runtime.getEvents().pipe(
          Stream.runForEach((event) => {
            if (event._tag === "EventStreamBarrier")
              return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
            if (event._tag === "ContentDelta") text += event.text;
            return Effect.void;
          }),
          Effect.forkScoped({ startImmediately: true }),
        );
        const response = yield* runtime.prompt({
          prompt: [
            {
              type: "text",
              text: "Reply with exactly KIRO_OK. Do not use tools or read any files.",
            },
          ],
        });
        yield* runtime.drainEvents;
        expect(response.stopReason).toBe("end_turn");
        expect(text).toContain("KIRO_OK");
        return started.sessionId;
      }).pipe(Effect.scoped);
      const resumed = yield* makeRuntime(savedSessionId);
      expect((yield* resumed.start()).sessionId).toBe(savedSessionId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 120_000 },
);

// Exercise the same adapter boundary used by the server, with disposable project data.
