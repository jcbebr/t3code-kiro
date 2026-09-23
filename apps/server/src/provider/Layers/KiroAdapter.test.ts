import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  KiroSettings,
  KIRO_DEFAULT_AGENT,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  type KiroAgentSource,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as AcpSchema from "effect-acp/schema";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { KIRO_DEFAULT_MODEL } from "../acp/KiroAcpSupport.ts";
import { makeKiroAdapter, type KiroAdapterOptions } from "./KiroAdapter.ts";

const instanceId = ProviderInstanceId.make("kiro-test");
const threadId = ThreadId.make("kiro-thread");
const fixture = NodeURL.fileURLToPath(
  new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
);
const settings = Schema.decodeSync(KiroSettings)({ enabled: true });

const makeHarness = Effect.fn("KiroTest.makeHarness")(function* (
  environment: NodeJS.ProcessEnv = {},
  providerSettings = settings,
  reportedAgent?: string,
  skillNames?: ReadonlySet<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-test-" });
  const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const seen: ProviderRuntimeEvent[] = [];
  const requests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
  const responses: AcpSchema.RequestPermissionResponse[] = [];
  const runtimes: AcpSessionRuntime.AcpSessionRuntime["Service"][] = [];
  const runtimeInputs: Parameters<KiroAdapterOptions["makeRuntime"]>[0][] = [];
  const adapter = yield* makeKiroAdapter(providerSettings, {
    instanceId,
    ...(skillNames ? { resolveSkillNames: () => Effect.succeed(skillNames) } : {}),
    makeRuntime: (input) =>
      Effect.gen(function* () {
        runtimeInputs.push(input);
        const runtime = yield* AcpSessionRuntime.make({
          ...input,
          spawn: { command: process.execPath, args: [fixture], cwd: input.cwd, env: environment },
          authMethodId: null,
          cancelBehavior: "wait-for-prompt",
          clientInfo: { name: "kiro-test", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requests.push(event);
            }),
        });
        runtimes.push(runtime);
        return {
          ...runtime,
          start: () =>
            runtime.start().pipe(
              Effect.map((started) => ({
                ...started,
                sessionSetupResult: {
                  ...started.sessionSetupResult,
                  modes: {
                    ...started.sessionSetupResult.modes,
                    currentModeId: reportedAgent ?? input.agent ?? "ask",
                    availableModes: started.sessionSetupResult.modes?.availableModes ?? [],
                  },
                },
              })),
            ),
          handleRequestPermission: (
            handler: Parameters<typeof runtime.handleRequestPermission>[0],
          ) =>
            runtime.handleRequestPermission((request) =>
              handler(request).pipe(
                Effect.tap((response) =>
                  Effect.sync(() => {
                    responses.push(response);
                  }),
                ),
              ),
            ),
        };
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
  });
  yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) => {
      seen.push(event);
      return Queue.offer(queue, event);
    }),
    Effect.forkScoped({ startImmediately: true }),
  );
  const waitFor = Effect.fn("KiroTest.waitFor")(function* <T extends ProviderRuntimeEvent["type"]>(
    type: T,
  ) {
    while (true) {
      const event = yield* Queue.take(queue);
      if (event.type === type) return event as Extract<ProviderRuntimeEvent, { type: T }>;
    }
  });
  const start = (
    mode: RuntimeMode = "approval-required",
    resumeCursor?: unknown,
    id = threadId,
    agent?: string,
    agentSource?: KiroAgentSource,
  ) =>
    adapter.startSession({
      threadId: id,
      providerInstanceId: instanceId,
      cwd,
      runtimeMode: mode,
      modelSelection: {
        instanceId,
        model: KIRO_DEFAULT_MODEL,
        ...(agent
          ? {
              options: [
                { id: "kiroAgent", value: agent },
                ...(agentSource ? [{ id: "kiroAgentSource", value: agentSource }] : []),
              ],
            }
          : {}),
      },
      ...(resumeCursor === undefined ? {} : { resumeCursor }),
    });
  return { adapter, start, waitFor, seen, requests, responses, runtimes, runtimeInputs, cwd };
});

it.effect("sends selected skills as native Kiro slash commands", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({}, settings, undefined, new Set(["review"]));
    yield* h.start();
    yield* h.adapter.sendTurn({
      threadId,
      input: "$review check this change",
      modelSelection: { instanceId, model: KIRO_DEFAULT_MODEL },
    });
    expect((yield* h.waitFor("turn.completed")).payload.state).toBe("completed");
    expect(h.requests.find((event) => event.method === "session/prompt")?.payload).toMatchObject({
      prompt: expect.arrayContaining([{ type: "text", text: "/review check this change" }]),
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("runs independent thread agents and retains the selected agent when resuming", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({}, { ...settings, agent: "environment-agent" });
    const selected = yield* h.start("approval-required", undefined, threadId, "project-agent");
    const other = ThreadId.make("default-agent-thread");
    yield* h.start("approval-required", undefined, other, KIRO_DEFAULT_AGENT);
    expect(h.runtimeInputs.map((input) => input.agent)).toEqual([
      "project-agent",
      KIRO_DEFAULT_AGENT,
    ]);
    expect(selected.resumeCursor).toMatchObject({ agent: "project-agent" });
    yield* h.adapter.stopSession(threadId);
    yield* h.start("approval-required", selected.resumeCursor);
    expect(h.runtimeInputs.at(-1)?.agent).toBe("project-agent");
    expect(h.requests.some((event) => event.method === "session/load")).toBe(true);
    // An official client has no kiroAgent option but must keep the pinned agent.
    yield* h.adapter.sendTurn({
      threadId,
      input: "Continue with the same agent",
      modelSelection: { instanceId, model: KIRO_DEFAULT_MODEL },
    });
    expect((yield* h.waitFor("turn.completed")).payload.state).toBe("completed");
    expect(yield* h.adapter.hasSession(other)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("pins agent source on resume and rejects changing only its source", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const session = yield* h.start("approval-required", undefined, threadId, "reviewer", "project");
    expect(h.runtimeInputs[0]).toMatchObject({ agent: "reviewer", agentSource: "project" });
    expect(session.resumeCursor).toMatchObject({ agent: "reviewer", agentSource: "project" });
    const turnError = yield* h.adapter
      .sendTurn({
        threadId,
        input: "Switch agent scope",
        modelSelection: {
          instanceId,
          model: KIRO_DEFAULT_MODEL,
          options: [
            { id: "kiroAgent", value: "reviewer" },
            { id: "kiroAgentSource", value: "global" },
          ],
        },
      })
      .pipe(Effect.flip);
    expect(turnError).toMatchObject({ _tag: "ProviderAdapterValidationError" });
    yield* h.adapter.stopSession(threadId);
    const resumeError = yield* h
      .start("approval-required", session.resumeCursor, threadId, "reviewer", "global")
      .pipe(Effect.flip);
    expect(resumeError).toMatchObject({ _tag: "ProviderAdapterValidationError" });
    yield* h.start("approval-required", session.resumeCursor, threadId, "reviewer");
    expect(h.runtimeInputs.at(-1)).toMatchObject({ agent: "reviewer", agentSource: "project" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("preserves native defaults and legacy cursors, then pins the resolved agent", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const initial = yield* h.start();
    expect(h.runtimeInputs[0]?.agent).toBeUndefined();
    // The mock reports its selected ACP mode, standing in for Kiro's agent name.
    expect(initial.resumeCursor).toMatchObject({ agent: "ask" });
    yield* h.adapter.stopSession(threadId);
    yield* h.start("approval-required", initial.resumeCursor);
    expect(h.runtimeInputs.at(-1)?.agent).toBe("ask");
    yield* h.adapter.stopSession(threadId);
    const legacy = yield* h.start("approval-required", {
      schemaVersion: 1,
      sessionId: "legacy-session",
    });
    expect(h.runtimeInputs.at(-1)?.agent).toBeUndefined();
    expect(legacy.resumeCursor).toMatchObject({ agent: "ask" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects changing an agent on live and resumed sessions before prompting", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const initial = yield* h.start("approval-required", undefined, threadId, "reviewer");
    const changed = yield* h.adapter
      .sendTurn({
        threadId,
        input: "Change agents",
        modelSelection: {
          instanceId,
          model: KIRO_DEFAULT_MODEL,
          options: [{ id: "kiroAgent", value: "writer" }],
        },
      })
      .pipe(Effect.flip);
    expect(changed).toMatchObject({ _tag: "ProviderAdapterValidationError" });
    expect(h.requests.some((event) => event.method === "session/prompt")).toBe(false);
    const changedLive = yield* h
      .start("approval-required", undefined, threadId, "writer")
      .pipe(Effect.flip);
    expect(changedLive).toMatchObject({ _tag: "ProviderAdapterValidationError" });
    expect(yield* h.adapter.hasSession(threadId)).toBe(true);
    yield* h.adapter.stopSession(threadId);
    const changedResume = yield* h
      .start("approval-required", initial.resumeCursor, threadId, "writer")
      .pipe(Effect.flip);
    expect(changedResume).toMatchObject({ _tag: "ProviderAdapterValidationError" });
    expect(h.runtimeInputs).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails before prompting when Kiro silently falls back to another agent", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({}, settings, KIRO_DEFAULT_AGENT);
    const result = yield* h
      .start("approval-required", undefined, threadId, "missing-agent")
      .pipe(Effect.flip);
    expect(result).toMatchObject({ _tag: "ProviderAdapterValidationError" });
    expect(result.message).toContain("missing-agent");
    expect(yield* h.adapter.hasSession(threadId)).toBe(false);
    expect(h.requests.some((event) => event.method === "session/prompt")).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "uses the native login, streams two turns, and never sends the default alias to set_model",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.start();
      for (const input of ["First", "Second"]) {
        yield* h.adapter.sendTurn({ threadId, input });
        const completed = yield* h.waitFor("turn.completed");
        expect(completed.payload.state).toBe("completed");
      }
      expect(h.seen.some((event) => event.type === "content.delta")).toBe(true);
      expect(h.requests.some((event) => event.method === "authenticate")).toBe(false);
      expect(h.requests.some((event) => event.method === "session/set_model")).toBe(false);
      expect((yield* h.adapter.readThread(threadId)).turns).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const decision of ["accept", "decline"] as const) {
  it.effect(`returns the exact native permission ID for ${decision}`, () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        T3_ACP_EMIT_TOOL_CALLS: "1",
        T3_ACP_ALLOW_ONCE_OPTION_ID: "kiro/yes/42",
        T3_ACP_REJECT_ONCE_OPTION_ID: "kiro/no/42",
      });
      yield* h.start();
      const turn = yield* h.adapter
        .sendTurn({ threadId, input: "Run a tool" })
        .pipe(Effect.forkChild);
      const approval = yield* h.waitFor("request.opened");
      expect(approval.payload.options?.map((option) => option.decision)).toEqual([
        "accept",
        "decline",
        "cancel",
      ]);
      const invalid = yield* h.adapter
        .respondToRequest(threadId, ApprovalRequestId.make(approval.requestId!), "acceptForSession")
        .pipe(Effect.result);
      expect(invalid._tag).toBe("Failure");
      yield* h.adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(approval.requestId!),
        decision,
      );
      yield* Fiber.join(turn);
      yield* h.waitFor("turn.completed");
      expect(h.responses).toEqual([
        {
          outcome: {
            outcome: "selected",
            optionId: decision === "accept" ? "kiro/yes/42" : "kiro/no/42",
          },
        },
      ]);
      expect(h.seen.some((event) => event.type === "item.completed")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect("cancels a pending approval, settles the turn, and can send another prompt", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ T3_ACP_EMIT_TOOL_CALLS: "1" });
    yield* h.start();
    const first = yield* h.adapter
      .sendTurn({ threadId, input: "Wait for approval" })
      .pipe(Effect.forkChild);
    yield* h.waitFor("request.opened");
    yield* h.adapter.interruptTurn(threadId);
    yield* Fiber.join(first);
    expect((yield* h.waitFor("turn.completed")).payload.state).toBe("cancelled");
    expect(h.responses[0]).toEqual({ outcome: { outcome: "cancelled" } });
    const second = yield* h.adapter
      .sendTurn({ threadId, input: "Try again" })
      .pipe(Effect.forkChild);
    const request = yield* h.waitFor("request.opened");
    yield* h.adapter.respondToRequest(
      threadId,
      ApprovalRequestId.make(request.requestId!),
      "accept",
    );
    yield* Fiber.join(second);
    expect((yield* h.waitFor("turn.completed")).payload.state).toBe("completed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("full access uses a single-use approval, never a persistent native grant", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ T3_ACP_EMIT_TOOL_CALLS: "1" });
    yield* h.start("full-access");
    yield* h.adapter.sendTurn({ threadId, input: "Run a tool" });
    yield* h.waitFor("turn.completed");
    expect(h.responses).toEqual([{ outcome: { outcome: "selected", optionId: "allow-once" } }]);
    expect(h.seen.some((event) => event.type === "request.opened")).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("loads the saved session without replaying messages into T3", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ T3_ACP_EMIT_LOAD_REPLAY: "1" });
    const session = yield* h.start();
    yield* h.adapter.stopSession(threadId);
    yield* h.start("approval-required", session.resumeCursor);
    expect(h.requests.some((event) => event.method === "session/load")).toBe(true);
    expect(h.seen.some((event) => event.type === "content.delta")).toBe(false);
    yield* h.adapter.sendTurn({ threadId, input: "Continue" });
    expect((yield* h.waitFor("turn.completed")).payload.state).toBe("completed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("closes a crashed process without stopping another thread", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.start();
    const other = ThreadId.make("other-thread");
    yield* h.start("approval-required", undefined, other);
    yield* h.runtimes[0]!.notify("_test/exit", {});
    expect((yield* h.waitFor("session.exited")).payload.exitKind).toBe("error");
    expect(yield* h.adapter.hasSession(threadId)).toBe(false);
    expect(yield* h.adapter.hasSession(other)).toBe(true);
    yield* h.adapter.sendTurn({ threadId: other, input: "Still alive" });
    expect((yield* h.waitFor("turn.completed")).payload.state).toBe("completed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects invalid resume state, instance mismatches and conversation rollback", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    expect(
      (yield* h.start("approval-required", { sessionId: "invalid" }).pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(h.runtimes).toHaveLength(0);
    yield* h.start();
    expect(
      (yield* h.adapter
        .sendTurn({
          threadId,
          input: "Hello",
          modelSelection: {
            instanceId: ProviderInstanceId.make("other"),
            model: KIRO_DEFAULT_MODEL,
          },
        })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect((yield* h.adapter.rollbackThread(threadId, 1).pipe(Effect.result))._tag).toBe("Failure");
    expect(h.adapter.capabilities.supportsConversationRollback).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
