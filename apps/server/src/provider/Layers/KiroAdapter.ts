import {
  ApprovalRequestId,
  EventId,
  RuntimeRequestId,
  TurnId,
  KIRO_DEFAULT_AGENT,
  getKiroAgentSelection,
  getKiroAgentSource,
  type KiroAgentSource,
  type KiroSettings,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  type TurnCompletedPayload,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import type {
  AcpSessionRuntime,
  AcpSessionRuntimeEvent,
  AcpSessionRuntimeStartResult,
} from "../acp/AcpSessionRuntime.ts";
import {
  KIRO_DEFAULT_MODEL,
  KIRO_DRIVER,
  kiroApprovalOptions,
  kiroPermissionOption,
} from "../acp/KiroAcpSupport.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { rewriteKiroSkillMentions } from "../Drivers/KiroSkills.ts";

type Adapter = ProviderAdapterShape<ProviderAdapterError>;
type Runtime = Pick<
  AcpSessionRuntime["Service"],
  | "start"
  | "handleRequestPermission"
  | "getEvents"
  | "drainEvents"
  | "prompt"
  | "cancel"
  | "setSessionModel"
>;
export interface KiroAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly resolveSkillNames?: (cwd: string) => Effect.Effect<ReadonlySet<string>>;
  readonly makeRuntime: (input: {
    readonly cwd: string;
    readonly agent?: string;
    readonly agentSource?: KiroAgentSource;
    readonly resumeSessionId?: string;
  }) => Effect.Effect<Runtime, AcpErrors.AcpError | ProviderAdapterValidationError, Scope.Scope>;
  readonly onSessionStarted?: (started: AcpSessionRuntimeStartResult) => Effect.Effect<void>;
}

const ResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
  agent: Schema.optional(Schema.NonEmptyString),
  agentSource: Schema.optional(Schema.Literals(["project", "global", "builtin"])),
});
const decodeCursor = Schema.decodeUnknownOption(ResumeCursor);
const isAcpError = Schema.is(AcpErrors.AcpError);
interface PendingApproval {
  readonly request: AcpSchema.RequestPermissionRequest;
  readonly response: Deferred.Deferred<{
    readonly decision: ProviderApprovalDecision;
    readonly result: AcpSchema.RequestPermissionResponse;
  }>;
}
interface SessionContext {
  readonly runtime: Runtime;
  readonly nativeSessionId: string;
  readonly agent: string;
  readonly agentSource?: KiroAgentSource;
  readonly scope: Scope.Closeable;
  readonly promptLock: Semaphore.Semaphore;
  readonly stopLock: Semaphore.Semaphore;
  readonly approvals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  session: ProviderSession;
  promptFiber: Fiber.Fiber<AcpSchema.PromptResponse, AcpErrors.AcpError> | undefined;
  activeTurnId: TurnId | undefined;
  generation: number;
  stopped: boolean;
  disconnected: boolean;
}

export const makeKiroAdapter = Effect.fn("makeKiroAdapter")(function* (
  settings: KiroSettings,
  options: KiroAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const ownerScope = yield* Effect.scope;
  const sessions = new Map<ThreadId, SessionContext>();
  const locks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const uuid = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: KIRO_DRIVER,
          method: "crypto/randomUUIDv4",
          detail: "Could not create a Kiro event ID.",
          cause,
        }),
    ),
  );
  const stamp = Effect.all({ eventId: uuid.pipe(Effect.map(EventId.make)), createdAt: now });
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);
  const invalid = (operation: string, issue: string) =>
    new ProviderAdapterValidationError({ provider: KIRO_DRIVER, operation, issue });
  const requireSession = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const context = sessions.get(threadId);
      return context && !context.stopped
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: KIRO_DRIVER, threadId }));
    });
  const withThreadLock = <A, E, R>(threadId: ThreadId, task: Effect.Effect<A, E, R>) =>
    SynchronizedRef.modifyEffect(locks, (current) => {
      const existing = current.get(threadId);
      return existing
        ? Effect.succeed([existing, current] as const)
        : Semaphore.make(1).pipe(
            Effect.map((lock) => [lock, new Map(current).set(threadId, lock)] as const),
          );
    }).pipe(Effect.flatMap((lock) => lock.withPermit(task)));
  const cancelRequests = (context: SessionContext) =>
    Effect.forEach(
      [...context.approvals.values()],
      (pending) =>
        Deferred.succeed(pending.response, {
          decision: "cancel",
          result: { outcome: { outcome: "cancelled" } },
        }),
      { discard: true },
    );

  const stopContext = (context: SessionContext) =>
    context.stopLock
      .withPermit(
        Effect.gen(function* () {
          if (context.stopped) return;
          context.stopped = true;
          yield* cancelRequests(context).pipe(
            Effect.ensuring(Scope.close(context.scope, Exit.void)),
          );
          if (sessions.get(context.session.threadId) === context)
            sessions.delete(context.session.threadId);
          yield* emit({
            type: "session.exited",
            ...(yield* stamp),
            provider: KIRO_DRIVER,
            threadId: context.session.threadId,
            payload: {
              exitKind: context.disconnected ? "error" : "graceful",
              ...(context.disconnected
                ? { reason: "Kiro CLI disconnected. Check your login and retry." }
                : {}),
            },
          });
        }),
      )
      .pipe(Effect.uninterruptible);

  const handlePermission = Effect.fn("KiroAdapter.handlePermission")(function* (
    context: SessionContext,
    request: AcpSchema.RequestPermissionRequest,
  ): Effect.fn.Return<AcpSchema.RequestPermissionResponse, ProviderAdapterError> {
    if (context.stopped || !context.activeTurnId || request.sessionId !== context.nativeSessionId) {
      return { outcome: { outcome: "cancelled" } };
    }
    const allowOnce = kiroPermissionOption(request, "accept");
    const mode = context.session.runtimeMode;
    const edit = ["edit", "delete", "move"].includes(request.toolCall.kind ?? "");
    if (allowOnce && (mode === "full-access" || (mode === "auto-accept-edits" && edit))) {
      return { outcome: { outcome: "selected", optionId: allowOnce } };
    }
    const requestId = ApprovalRequestId.make(yield* uuid);
    const turnId = context.activeTurnId;
    const response = yield* Deferred.make<{
      decision: ProviderApprovalDecision;
      result: AcpSchema.RequestPermissionResponse;
    }>();
    context.approvals.set(requestId, { request, response });
    const permissionRequest = parsePermissionRequest(request);
    return yield* Effect.gen(function* () {
      yield* emit(
        makeAcpRequestOpenedEvent({
          stamp: yield* stamp,
          provider: KIRO_DRIVER,
          threadId: context.session.threadId,
          turnId,
          requestId: RuntimeRequestId.make(requestId),
          permissionRequest,
          approvalOptions: kiroApprovalOptions(request),
          detail: permissionRequest.detail ?? "Kiro requests permission.",
          args: request,
          source: "acp.jsonrpc",
          method: "session/request_permission",
          rawPayload: request,
        }),
      );
      const answer = yield* Deferred.await(response);
      yield* emit(
        makeAcpRequestResolvedEvent({
          stamp: yield* stamp,
          provider: KIRO_DRIVER,
          threadId: context.session.threadId,
          turnId,
          requestId: RuntimeRequestId.make(requestId),
          permissionRequest,
          decision: answer.decision,
        }),
      );
      return answer.result;
    }).pipe(Effect.ensuring(Effect.sync(() => context.approvals.delete(requestId))));
  });

  const handleEvent = Effect.fn("KiroAdapter.handleEvent")(function* (
    context: SessionContext,
    event: AcpSessionRuntimeEvent,
  ) {
    if (event._tag === "EventStreamBarrier") {
      yield* Deferred.succeed(event.acknowledge, undefined);
      return;
    }
    if (context.stopped) return;
    if (event._tag === "ConnectionTerminated") {
      context.disconnected = true;
      yield* stopContext(context).pipe(Effect.forkIn(ownerScope));
      return;
    }
    // session/load replays history; T3 already owns the persisted conversation.
    if (context.activeTurnId === undefined) return;
    const base = {
      stamp: yield* stamp,
      provider: KIRO_DRIVER,
      threadId: context.session.threadId,
      turnId: context.activeTurnId,
    };
    switch (event._tag) {
      case "AssistantItemStarted":
      case "AssistantItemCompleted":
        yield* emit(
          makeAcpAssistantItemEvent({
            ...base,
            itemId: event.itemId,
            lifecycle: event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
          }),
        );
        return;
      case "ContentDelta":
      case "ThoughtDelta":
        yield* emit(
          makeAcpContentDeltaEvent({
            ...base,
            ...(event._tag === "ContentDelta" && event.itemId ? { itemId: event.itemId } : {}),
            streamKind: event._tag === "ThoughtDelta" ? "reasoning_text" : "assistant_text",
            text: event.text,
            rawPayload: event.rawPayload,
          }),
        );
        return;
      case "ToolCallUpdated":
        yield* emit(
          makeAcpToolCallEvent({ ...base, toolCall: event.toolCall, rawPayload: event.rawPayload }),
        );
        return;
      case "PlanUpdated":
        yield* emit(
          makeAcpPlanUpdatedEvent({
            ...base,
            payload: event.payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload: event.rawPayload,
          }),
        );
        return;
    }
  });

  const selectModel = (runtime: Runtime, requested: string | undefined) =>
    requested && requested !== KIRO_DEFAULT_MODEL
      ? runtime.setSessionModel(requested)
      : Effect.void;

  const startSession: Adapter["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (!settings.enabled)
          return yield* invalid("startSession", "Enable Kiro in provider settings first.");
        if (
          (input.provider && input.provider !== KIRO_DRIVER) ||
          (input.providerInstanceId && input.providerInstanceId !== options.instanceId) ||
          (input.modelSelection && input.modelSelection.instanceId !== options.instanceId)
        ) {
          return yield* invalid("startSession", "The Kiro instance does not match this session.");
        }
        if (!input.cwd?.trim())
          return yield* invalid("startSession", "Kiro requires a workspace directory.");
        const cursor = decodeCursor(input.resumeCursor);
        if (input.resumeCursor !== undefined && Option.isNone(cursor)) {
          return yield* invalid(
            "startSession",
            "The saved Kiro session is invalid. Start a new thread.",
          );
        }
        const requestedAgent = getKiroAgentSelection(input.modelSelection?.options);
        const requestedAgentSource = getKiroAgentSource(input.modelSelection?.options);
        const previous = sessions.get(input.threadId);
        const pinnedAgent =
          (Option.isSome(cursor) ? cursor.value.agent : undefined) ?? previous?.agent;
        const pinnedAgentSource =
          (Option.isSome(cursor) ? cursor.value.agentSource : undefined) ?? previous?.agentSource;
        if (
          (requestedAgent && pinnedAgent && requestedAgent !== pinnedAgent) ||
          (requestedAgentSource && pinnedAgentSource && requestedAgentSource !== pinnedAgentSource)
        ) {
          return yield* invalid(
            "startSession",
            "The Kiro agent cannot change after the thread starts. Start a new thread instead.",
          );
        }
        const agent = pinnedAgent ?? requestedAgent ?? (settings.agent.trim() || undefined);
        const agentSource = pinnedAgentSource ?? requestedAgentSource;
        if (previous) yield* stopContext(previous);
        const scope = yield* Scope.make("sequential");
        let transferred = false;
        let context: SessionContext | undefined;
        yield* Effect.addFinalizer(() =>
          transferred
            ? Effect.void
            : Effect.gen(function* () {
                sessions.delete(input.threadId);
                yield* Scope.close(scope, Exit.void);
              }),
        );
        const session = yield* Effect.gen(function* () {
          const runtime = yield* options.makeRuntime({
            cwd: input.cwd!,
            ...(agent ? { agent } : {}),
            ...(agentSource ? { agentSource } : {}),
            ...(Option.isSome(cursor) ? { resumeSessionId: cursor.value.sessionId } : {}),
          });
          yield* runtime.handleRequestPermission((request) =>
            context
              ? handlePermission(context, request).pipe(
                  Effect.mapError((cause) =>
                    AcpErrors.AcpRequestError.internalError(
                      "Could not process Kiro permission.",
                      undefined,
                      { cause },
                    ),
                  ),
                )
              : Effect.succeed({
                  outcome: { outcome: "cancelled" },
                } satisfies AcpSchema.RequestPermissionResponse),
          );
          const started = yield* runtime.start();
          const reportedAgent = started.sessionSetupResult.modes?.currentModeId;
          if (agent && reportedAgent && agent !== reportedAgent) {
            return yield* invalid(
              "startSession",
              `Kiro started agent '${reportedAgent}' instead of '${agent}'. Check that the selected agent is available in this workspace on the server.`,
            );
          }
          // Omitting --agent lets the CLI resolve its configured default. Persist that
          // result so changing environment defaults cannot change a resumed thread.
          const sessionAgent = agent ?? reportedAgent ?? KIRO_DEFAULT_AGENT;
          yield* selectModel(runtime, input.modelSelection?.model);
          yield* options.onSessionStarted?.(started) ?? Effect.void;
          const createdAt = yield* now;
          const session: ProviderSession = {
            provider: KIRO_DRIVER,
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            cwd: input.cwd!,
            status: "ready",
            runtimeMode: input.runtimeMode,
            model: input.modelSelection?.model ?? KIRO_DEFAULT_MODEL,
            resumeCursor: {
              schemaVersion: 1,
              sessionId: started.sessionId,
              agent: sessionAgent,
              ...(agentSource ? { agentSource } : {}),
            },
            createdAt,
            updatedAt: createdAt,
          };
          context = {
            runtime,
            nativeSessionId: started.sessionId,
            agent: sessionAgent,
            ...(agentSource ? { agentSource } : {}),
            scope,
            promptLock: yield* Semaphore.make(1),
            stopLock: yield* Semaphore.make(1),
            approvals: new Map(),
            turns: [],
            session,
            activeTurnId: undefined,
            promptFiber: undefined,
            generation: 0,
            stopped: false,
            disconnected: false,
          };
          const running = context;
          sessions.set(input.threadId, running);
          yield* Stream.runForEach(runtime.getEvents(), (event) =>
            handleEvent(running, event),
          ).pipe(
            Effect.catchCause(() => {
              running.disconnected = true;
              return stopContext(running).pipe(Effect.forkIn(ownerScope), Effect.asVoid);
            }),
            Effect.forkIn(scope),
          );
          yield* runtime.drainEvents;
          if (running.disconnected || running.stopped)
            return yield* AcpErrors.AcpRequestError.internalError(
              "Kiro disconnected during startup.",
            );
          yield* emit({
            type: "session.started",
            ...(yield* stamp),
            provider: KIRO_DRIVER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* emit({
            type: "session.state.changed",
            ...(yield* stamp),
            provider: KIRO_DRIVER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Kiro ACP session ready" },
          });
          yield* emit({
            type: "thread.started",
            ...(yield* stamp),
            provider: KIRO_DRIVER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          return session;
        }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () =>
              Effect.fail(
                AcpErrors.AcpRequestError.internalError(
                  "Kiro startup timed out. Check CLI login and MCP configuration.",
                ),
              ),
          }),
          Effect.mapError((cause) =>
            isAcpError(cause)
              ? mapAcpToAdapterError(KIRO_DRIVER, input.threadId, "session/start", cause)
              : cause,
          ),
        );
        transferred = true;
        return session;
      }).pipe(Effect.scoped),
    );

  const sendTurn: Adapter["sendTurn"] = Effect.fn("KiroAdapter.sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId) {
      return yield* invalid("sendTurn", "The selected model belongs to another provider instance.");
    }
    const requestedAgent = getKiroAgentSelection(input.modelSelection?.options);
    const requestedAgentSource = getKiroAgentSource(input.modelSelection?.options);
    if (
      (requestedAgent && requestedAgent !== context.agent) ||
      (requestedAgentSource && requestedAgentSource !== context.agentSource)
    ) {
      return yield* invalid(
        "sendTurn",
        "The Kiro agent cannot change after the thread starts. Start a new thread instead.",
      );
    }
    if (!input.input?.trim()) return yield* invalid("sendTurn", "Enter a message for Kiro.");
    if (input.attachments?.length)
      return yield* invalid("sendTurn", "Kiro attachments are not supported in this build yet.");
    if (input.interactionMode === "plan")
      return yield* invalid("sendTurn", "Kiro plan mode is not supported in this build.");
    let intent: { turnId: TurnId; generation: number; settled: boolean } | undefined;
    const finish = (turn: NonNullable<typeof intent>, payload: TurnCompletedPayload) =>
      Effect.gen(function* () {
        if (turn.settled || context.stopped || context.generation !== turn.generation) return;
        turn.settled = true;
        context.activeTurnId = undefined;
        context.promptFiber = undefined;
        context.session = {
          ...context.session,
          activeTurnId: undefined,
          status: payload.state === "failed" ? "error" : "ready",
          updatedAt: yield* now,
          lastError: payload.errorMessage,
        };
        yield* emit({
          type: "turn.completed",
          ...(yield* stamp),
          provider: KIRO_DRIVER,
          threadId: input.threadId,
          turnId: turn.turnId,
          payload,
        });
      }).pipe(Effect.uninterruptible);
    return yield* Effect.gen(function* () {
      const launch = yield* context.promptLock.withPermit(
        Effect.gen(function* () {
          yield* requireSession(input.threadId);
          const steering = context.activeTurnId !== undefined;
          const turn = {
            turnId: context.activeTurnId ?? TurnId.make(yield* uuid),
            generation: ++context.generation,
            settled: false,
          };
          intent = turn;
          if (context.promptFiber) {
            yield* cancelRequests(context);
            yield* context.runtime.cancel;
            yield* Fiber.await(context.promptFiber);
            yield* context.runtime.drainEvents;
          }
          const model = input.modelSelection?.model ?? context.session.model;
          yield* selectModel(context.runtime, model);
          context.activeTurnId = turn.turnId;
          context.session = {
            ...context.session,
            model,
            activeTurnId: turn.turnId,
            status: "running",
            updatedAt: yield* now,
          };
          if (!steering)
            yield* emit({
              type: "turn.started",
              ...(yield* stamp),
              provider: KIRO_DRIVER,
              threadId: input.threadId,
              turnId: turn.turnId,
              payload: model ? { model } : {},
            });
          const dispatched = yield* Deferred.make<void>();
          const prompt = input.input!;
          const skillNames =
            prompt.includes("$") && options.resolveSkillNames && context.session.cwd
              ? yield* options.resolveSkillNames(context.session.cwd)
              : new Set<string>();
          const fiber = yield* context.runtime
            .prompt(
              {
                prompt: [
                  { type: "text", text: rewriteKiroSkillMentions(prompt, skillNames) },
                  { type: "text", text: buildRuntimeInstructions({ harness: "Kiro" }) },
                ],
              },
              { dispatched },
            )
            .pipe(Effect.forkIn(context.scope));
          context.promptFiber = fiber;
          yield* Effect.raceFirst(
            Deferred.await(dispatched),
            Fiber.await(fiber).pipe(
              Effect.flatMap((exit) => exit),
              Effect.asVoid,
            ),
          );
          return { turn, fiber };
        }),
      );
      const result = yield* Fiber.await(launch.fiber).pipe(Effect.flatMap((exit) => exit));
      yield* context.runtime.drainEvents;
      if (context.stopped)
        return yield* new ProviderAdapterSessionClosedError({
          provider: KIRO_DRIVER,
          threadId: input.threadId,
        });
      if (context.generation === launch.turn.generation) {
        context.turns.push({ id: launch.turn.turnId, items: [result] });
      }
      yield* context.promptLock.withPermit(
        finish(launch.turn, {
          state: result.stopReason === "cancelled" ? "cancelled" : "completed",
          stopReason: result.stopReason,
        }),
      );
      return {
        threadId: input.threadId,
        turnId: launch.turn.turnId,
        resumeCursor: context.session.resumeCursor,
      };
    }).pipe(
      Effect.mapError((cause) =>
        isAcpError(cause)
          ? mapAcpToAdapterError(KIRO_DRIVER, input.threadId, "session/prompt", cause)
          : cause,
      ),
      Effect.tapError((cause) =>
        Effect.suspend(() =>
          intent
            ? context.promptLock.withPermit(
                finish(intent, { state: "failed", errorMessage: cause.message }),
              )
            : Effect.void,
        ),
      ),
      Effect.onInterrupt(() =>
        context.promptLock.withPermit(
          Effect.gen(function* () {
            if (
              !intent ||
              intent.settled ||
              context.stopped ||
              context.generation !== intent.generation
            )
              return;
            yield* cancelRequests(context);
            yield* Effect.ignore(context.runtime.cancel);
            if (context.promptFiber) yield* Fiber.interrupt(context.promptFiber);
            yield* finish(intent, { state: "cancelled", stopReason: "cancelled" });
          }),
        ),
      ),
    );
  });

  const stopAll = () => Effect.forEach([...sessions.values()], stopContext, { discard: true });
  yield* Effect.addFinalizer(() =>
    stopAll().pipe(Effect.ignore, Effect.ensuring(PubSub.shutdown(events))),
  );
  const adapter: Adapter = {
    provider: KIRO_DRIVER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    startSession,
    sendTurn,
    stopAll,
    stopSession: (threadId) =>
      withThreadLock(threadId, requireSession(threadId).pipe(Effect.flatMap(stopContext))),
    interruptTurn: (threadId, turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* context.promptLock
          .withPermit(
            Effect.gen(function* () {
              if (turnId && context.activeTurnId !== turnId) return;
              yield* cancelRequests(context);
              yield* context.runtime.cancel;
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(KIRO_DRIVER, threadId, "session/cancel", cause),
            ),
          );
      }),
    respondToRequest: (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.approvals.get(requestId);
        if (!pending)
          return yield* invalid("respondToRequest", "This Kiro approval is no longer pending.");
        const optionId = kiroPermissionOption(pending.request, decision);
        if (decision !== "cancel" && !optionId)
          return yield* invalid("respondToRequest", "Kiro did not offer this approval choice.");
        yield* Deferred.succeed(pending.response, {
          decision,
          result: {
            outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" },
          },
        });
      }),
    respondToUserInput: () =>
      Effect.fail(invalid("respondToUserInput", "Reply to Kiro questions in the chat.")),
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((entry) => !entry.stopped)
          .map((entry) => ({ ...entry.session })),
      ),
    hasSession: (threadId) =>
      Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.stopped),
    readThread: (threadId) =>
      requireSession(threadId).pipe(Effect.map((entry) => ({ threadId, turns: entry.turns }))),
    rollbackThread: () =>
      Effect.fail(
        invalid(
          "rollbackThread",
          "Kiro conversation rewind is not supported. Start a new thread instead.",
        ),
      ),
    streamEvents: Stream.fromPubSub(events),
  };
  return adapter;
});
