import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  KiroSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as AcpSchema from "effect-acp/compat";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { KIRO_DEFAULT_MODEL } from "./acp/KiroAcpSupport.ts";
import { makeKiroAdapter, type KiroAdapterOptions } from "./KiroAdapter.ts";

const instanceId = ProviderInstanceId.make("kiro-test");
const threadId = ThreadId.make("kiro-thread");
const settings = Schema.decodeSync(KiroSettings)({ enabled: true });
const fixture = NodeURL.fileURLToPath(new URL("../../scripts/acp-mock-agent.ts", import.meta.url));
const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);
const selection = (agent?: string): ModelSelection => ({
  instanceId,
  model: KIRO_DEFAULT_MODEL,
  ...(agent ? { options: [{ id: "kiroAgent", value: agent }] } : {}),
});

const makeHarness = Effect.fn("KiroTest.makeHarness")(function* (
  reportedAgent?: string,
  environment: NodeJS.ProcessEnv = {},
  fixturePath = fixture,
) {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-test-" });
  const requests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
  const responses: AcpSchema.RequestPermissionResponse[] = [];
  const inputs: Parameters<KiroAdapterOptions["makeRuntime"]>[0][] = [];
  const adapter = yield* makeKiroAdapter(settings, {
    instanceId,
    selfInvocation: yield* resolveSelfInvocation(),
    resolveSkillNames: () => Effect.succeed(new Set(["review"])),
    makeRuntime: (input) =>
      Effect.gen(function* () {
        inputs.push(input);
        const runtime = yield* AcpSessionRuntime.make({
          ...input,
          cancelBehavior: "wait-for-prompt",
          spawn: {
            command: process.execPath,
            args: [fixturePath],
            cwd: input.cwd,
            env: { T3_ACP_SESSION_LIFECYCLE: "1", ...environment },
          },
          requestLogger: (event) =>
            Effect.sync(() => {
              requests.push(event);
            }),
        });
        return {
          ...runtime,
          handleRequestPermission: (
            handler: Parameters<typeof runtime.handleRequestPermission>[0],
          ) =>
            runtime.handleRequestPermission((request, context) =>
              handler(request, context).pipe(
                Effect.tap((response) =>
                  Effect.sync(() => {
                    responses.push(response);
                  }),
                ),
              ),
            ),
          start: () =>
            runtime.start().pipe(
              Effect.map((started) => ({
                ...started,
                sessionSetupResult: {
                  ...started.sessionSetupResult,
                  modes: {
                    currentModeId: reportedAgent ?? input.agent ?? "kiro_default",
                    availableModes: [],
                  },
                },
              })),
            ),
        };
      }),
  });
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd,
  });
  const open = (modelSelection = selection(), id = threadId, nativeThreadId?: string) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const runtime = yield* adapter
        .openSession({
          threadId: id,
          providerSessionId: ProviderSessionId.make(`session:${id}`),
          modelSelection,
          runtimePolicy,
          ...(nativeThreadId ? { initialNativeThreadId: nativeThreadId } : {}),
        })
        .pipe(Effect.provideService(Scope.Scope, scope));
      return { ...runtime, close: () => Scope.close(scope, Exit.void) };
    });
  return { adapter, open, requests, responses, inputs, runtimePolicy };
});

it.effect.each([
  { engine: "v2", modern: false },
  { engine: "v3", modern: true },
])("selects and restores a model with the Kiro $engine engine", ({ modern }) =>
  Effect.gen(function* () {
    const h = yield* makeHarness(
      undefined,
      {
        T3_KIRO_MOCK_MODEL_CONFIG: modern ? "1" : "0",
      },
      NodeURL.fileURLToPath(new URL("../../scripts/kiro-acp-mock-agent.ts", import.meta.url)),
    );
    const modelSelection = { ...selection(), model: "claude-opus" };
    const runtime = yield* h.open(modelSelection);
    const native = yield* runtime.ensureThread({
      threadId,
      modelSelection,
      runtimePolicy: h.runtimePolicy,
    });
    yield* runtime.close();
    const restored = yield* h.open(modelSelection, threadId, native.nativeThreadRef!.nativeId!);
    const providerThread = yield* restored.ensureThread({
      threadId,
      modelSelection,
      runtimePolicy: h.runtimePolicy,
    });
    const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    yield* restored.events.pipe(
      Stream.runForEach((event) => Queue.offer(queue, event)),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* restored.startTurn(
      makeTurnInput({
        threadId,
        providerThread,
        instanceId,
        modelSelection,
        runtimePolicy: h.runtimePolicy,
        now: yield* DateTime.now,
      }),
    );
    let reply = "";
    while (true) {
      const event = yield* Queue.take(queue);
      if (event.type === "message.updated" && event.message.role === "assistant") {
        reply = event.message.text;
      }
      if (event.type === "provider_turn.updated" && event.providerTurn.status === "completed")
        break;
    }
    expect(reply).toBe("claude-opus");
    const method = modern ? "session/set_config_option" : "session/set_model";
    const changes = h.requests.filter(
      (event) => event.method === method && event.status === "succeeded",
    );
    expect(changes).toHaveLength(2);
    expect(changes.map((event) => event.payload)).toEqual([
      expect.objectContaining(
        modern ? { configId: "model", value: "claude-opus" } : { modelId: "claude-opus" },
      ),
      expect.objectContaining(
        modern ? { configId: "model", value: "claude-opus" } : { modelId: "claude-opus" },
      ),
    ]);
    expect(h.requests.some((event) => event.status === "failed")).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("passes current thread MCP credentials when creating and restoring sessions", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const mcp = yield* McpProviderSessions.McpProviderSessions;
    const register = (authorizationHeader: string) =>
      mcp.set({
        environmentId: EnvironmentId.make("kiro-environment"),
        threadId,
        providerSessionId: "kiro-session",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:3773/api/mcp",
        authorizationHeader,
        capabilities: new Set(["pull-requests"]),
        browserToolsAvailable: false,
      });
    yield* register("Bearer initial-test-token");
    const runtime = yield* h.open();
    const native = yield* runtime.ensureThread({
      threadId,
      modelSelection: selection(),
      runtimePolicy: h.runtimePolicy,
    });
    yield* h.open(selection(), ThreadId.make("other-thread"));
    yield* runtime.close();
    yield* register("Bearer resumed-test-token");
    yield* h.open(selection(), threadId, native.nativeThreadRef!.nativeId!);
    const setup = h.requests.filter(
      (event) =>
        event.status === "succeeded" &&
        (event.method === "session/new" || event.method === "session/load"),
    );
    expect(setup.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        mcpServers: [
          expect.objectContaining({
            name: "t3-code",
            env: expect.arrayContaining([
              { name: "T3_ACP_MCP_ENDPOINT", value: "http://127.0.0.1:3773/api/mcp" },
              { name: "T3_ACP_MCP_AUTHORIZATION", value: "Bearer initial-test-token" },
            ]),
          }),
        ],
      }),
      expect.objectContaining({ mcpServers: [] }),
      expect.objectContaining({
        mcpServers: [
          expect.objectContaining({
            name: "t3-code",
            env: expect.arrayContaining([
              { name: "T3_ACP_MCP_ENDPOINT", value: "http://127.0.0.1:3773/api/mcp" },
              { name: "T3_ACP_MCP_AUTHORIZATION", value: "Bearer resumed-test-token" },
            ]),
          }),
        ],
      }),
    ]);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("keeps separate agent selections across sessions and resume", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const runtime = yield* h.open(selection("reviewer"));
    const native = yield* runtime.ensureThread({
      threadId,
      modelSelection: selection("reviewer"),
      runtimePolicy: h.runtimePolicy,
    });
    yield* h.open(selection("builder"), ThreadId.make("builder-thread"));
    yield* runtime.close();
    yield* h.open(selection("reviewer"), threadId, native.nativeThreadRef!.nativeId!);
    expect(h.inputs.map((input) => input.agent)).toEqual(["reviewer", "builder", "reviewer"]);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("rejects a native fallback to another agent before prompting", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("kiro_default");
    const error = yield* h.open(selection("missing-agent")).pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "ProviderAdapterOpenSessionError" });
    expect(h.requests.some((event) => event.method === "session/prompt")).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("streams a turn and sends selected skills as Kiro slash commands", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const runtime = yield* h.open();
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: selection(),
      runtimePolicy: h.runtimePolicy,
    });
    const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    yield* runtime.events.pipe(
      Stream.runForEach((event) => Queue.offer(queue, event)),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* runtime.startTurn(
      makeTurnInput({
        threadId,
        providerThread,
        instanceId,
        runtimePolicy: h.runtimePolicy,
        now: yield* DateTime.now,
        modelSelection: selection(),
        messageText: "$review check this change",
      }),
    );
    while (true) {
      const event = yield* Queue.take(queue);
      if (event.type === "provider_turn.updated" && event.providerTurn.status === "completed")
        break;
    }
    expect(h.requests.find((event) => event.method === "session/prompt")?.payload).toMatchObject({
      prompt: expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("/review check this change"),
        }),
      ]),
    });
    expect(h.requests.some((event) => event.method === "session/set_model")).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("full access approves Kiro tools only once without persisting native grants", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(undefined, {
      T3_ACP_EMIT_TOOL_CALLS: "1",
      T3_ACP_ALLOW_ONCE_OPTION_ID: "kiro/yes/42",
    });
    const runtime = yield* h.open();
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: selection(),
      runtimePolicy: h.runtimePolicy,
    });
    const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    yield* runtime.events.pipe(
      Stream.runForEach((event) => Queue.offer(queue, event)),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* runtime.startTurn(
      makeTurnInput({
        threadId,
        providerThread,
        instanceId,
        runtimePolicy: h.runtimePolicy,
        now: yield* DateTime.now,
        modelSelection: selection(),
        messageText: "$review check this change",
      }),
    );
    while (true) {
      const event = yield* Queue.take(queue);
      if (event.type === "provider_turn.updated" && event.providerTurn.status === "completed")
        break;
    }
    expect(h.requests.find((event) => event.method === "session/prompt")?.payload).toMatchObject({
      prompt: expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("/review check this change"),
        }),
      ]),
    });
    expect(h.responses).toEqual([{ outcome: { outcome: "selected", optionId: "kiro/yes/42" } }]);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

function makeTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly instanceId: ProviderInstanceId;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly now: DateTime.Utc;
  readonly ordinal?: number;
  readonly modelSelection?: ModelSelection;
  /** agent+provider marks a post-settle continuation attach (drains wakeBuffer). */
  readonly messageCreatedBy?: "user" | "agent";
  readonly messageCreationSource?: "web" | "mobile" | "mcp" | "provider" | "server";
  readonly messageText?: string;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  const ordinal = input.ordinal ?? 1;
  const suffix = `${input.threadId}:${ordinal}`;
  const modelSelection =
    input.modelSelection ?? ({ instanceId: input.instanceId, model: "default" } as const);
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make(`project:${input.threadId}`),
      title: "ACP adapter test",
      providerInstanceId: input.instanceId,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId: input.threadId,
    runId: RunId.make(`run:${suffix}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt:${suffix}`),
    rootNodeId: NodeId.make(`node:${suffix}`),
    providerThread: input.providerThread,
    message: {
      createdBy: input.messageCreatedBy ?? "user",
      creationSource: input.messageCreationSource ?? "web",
      messageId: MessageId.make(`message:${suffix}`),
      text: input.messageText ?? "test prompt",
      attachments: [],
    },
    modelSelection,
    runtimePolicy: input.runtimePolicy,
  };
}
