import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  KiroSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Queue from "effect/Queue";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeKiroAdapter } from "../Layers/KiroAdapter.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { KIRO_DEFAULT_MODEL, makeKiroAcpRuntime } from "./KiroAcpSupport.ts";

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
it.effect.skipIf(process.env.T3_KIRO_LIVE_TURN !== "1")(
  "completes real T3 turns before and after restoring a Kiro session",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-adapter-live-" });
      const instanceId = ProviderInstanceId.make("kiro-live");
      const threadId = ThreadId.make("kiro-live-thread");
      const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const adapter = yield* makeKiroAdapter(settings, {
        instanceId,
        makeRuntime: (input) =>
          makeKiroAcpRuntime(settings, process.env, {
            ...input,
            clientInfo: { name: "t3-code", version: "0.0.0" },
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
      });
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Queue.offer(queue, event)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const start = (resumeCursor?: unknown) =>
        adapter.startSession({
          threadId,
          providerInstanceId: instanceId,
          cwd,
          runtimeMode: "approval-required",
          modelSelection: { instanceId, model: KIRO_DEFAULT_MODEL },
          ...(resumeCursor === undefined ? {} : { resumeCursor }),
        });
      const session = yield* start();
      for (const marker of ["KIRO_FIRST_OK", "KIRO_RESUMED_OK"]) {
        yield* adapter.sendTurn({
          threadId,
          input: `Reply with exactly ${marker}. Do not use tools or read any files.`,
        });
        let answer = "";
        while (true) {
          const event = yield* Queue.take(queue);
          if (event.type === "request.opened")
            throw new Error("Unexpected tool request for a text-only probe");
          if (event.type === "content.delta") answer += event.payload.delta;
          if (event.type === "turn.completed") {
            expect(event.payload.state).toBe("completed");
            break;
          }
        }
        expect(answer).toContain(marker);
        if (marker === "KIRO_FIRST_OK") {
          yield* adapter.stopSession(threadId);
          yield* start(session.resumeCursor);
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 120_000 },
);
