import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type KiroAgentSource,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-09-20T00:00:00.000Z";
const threadId = ThreadId.make("kiro-thread");
const instanceId = ProviderInstanceId.make("kiro");
const selection = (agent?: string, source?: KiroAgentSource): ModelSelection => ({
  instanceId,
  model: "kiro-default",
  ...(agent
    ? {
        options: [
          { id: "kiroAgent", value: agent },
          ...(source ? [{ id: "kiroAgentSource", value: source }] : []),
        ],
      }
    : {}),
});
const readModel = (changes: Partial<OrchestrationThread> = {}): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Kiro",
      modelSelection: selection("reviewer"),
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
      ...changes,
    },
  ],
  updatedAt: NOW,
});
const existingMessage: OrchestrationThread["messages"][number] = {
  id: MessageId.make("previous-message"),
  role: "user",
  text: "Review this project",
  turnId: null,
  streaming: false,
  createdAt: NOW,
  updatedAt: NOW,
};
const command = (
  type: "thread.meta.update" | "thread.turn.start",
  modelSelection: ModelSelection,
): OrchestrationCommand =>
  type === "thread.meta.update"
    ? {
        type,
        commandId: CommandId.make("update"),
        threadId,
        modelSelection,
      }
    : {
        type,
        commandId: CommandId.make("start"),
        threadId,
        modelSelection,
        message: {
          messageId: MessageId.make("next-message"),
          role: "user",
          text: "Continue",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: NOW,
      };

it.layer(NodeServices.layer)("Kiro thread agent", (it) => {
  for (const type of ["thread.meta.update", "thread.turn.start"] as const) {
    it.effect(`preserves omitted source and rejects changing only source through ${type}`, () =>
      Effect.gen(function* () {
        const initial = readModel({
          modelSelection: selection("reviewer", "project"),
          messages: [existingMessage],
        });
        const changed = yield* decideOrchestrationCommand({
          readModel: initial,
          command: command(type, selection("reviewer", "global")),
        }).pipe(Effect.flip);
        expect(changed).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
        for (const requested of [selection(), selection("reviewer")]) {
          const decided = yield* decideOrchestrationCommand({
            readModel: initial,
            command: command(type, requested),
          });
          const emitted = Array.isArray(decided) ? decided : [decided];
          expect(
            emitted.find(
              (event) =>
                event.type === "thread.meta-updated" ||
                event.type === "thread.turn-start-requested",
            )?.payload,
          ).toMatchObject({ modelSelection: selection("reviewer", "project") });
        }
      }),
    );
    it.effect(`allows choosing the agent before the first turn through ${type}`, () =>
      Effect.gen(function* () {
        const initial = readModel();
        const decided = yield* decideOrchestrationCommand({
          readModel: initial,
          command: command(type, selection("writer")),
        });
        let state = initial;
        for (const [index, event] of (Array.isArray(decided) ? decided : [decided]).entries()) {
          state = yield* projectEvent(state, { ...event, sequence: index + 1 });
        }
        expect(state.threads[0]?.modelSelection.options).toEqual([
          { id: "kiroAgent", value: "writer" },
        ]);
      }),
    );

    it.effect(`rejects changing the agent after a queued first turn through ${type}`, () =>
      Effect.gen(function* () {
        const error = yield* decideOrchestrationCommand({
          readModel: readModel({ messages: [existingMessage] }),
          command: command(type, selection("writer")),
        }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      }),
    );

    it.effect(`preserves the agent omitted by older clients through ${type}`, () =>
      Effect.gen(function* () {
        const initial = readModel({ messages: [existingMessage] });
        const decided = yield* decideOrchestrationCommand({
          readModel: initial,
          command: command(type, {
            instanceId,
            model: "another-model",
            options: [{ id: "effort", value: "high" }],
          }),
        });
        let state = initial;
        for (const [index, event] of (Array.isArray(decided) ? decided : [decided]).entries()) {
          state = yield* projectEvent(state, { ...event, sequence: index + 1 });
        }
        const emitted = Array.isArray(decided) ? decided : [decided];
        const selectedEvent = emitted.find(
          (event) =>
            event.type === "thread.meta-updated" || event.type === "thread.turn-start-requested",
        );
        expect(selectedEvent?.payload).toMatchObject({
          modelSelection: {
            instanceId,
            model: "another-model",
            options: [
              { id: "effort", value: "high" },
              { id: "kiroAgent", value: "reviewer" },
            ],
          },
        });
        expect(state.threads[0]?.modelSelection.options).toContainEqual({
          id: "kiroAgent",
          value: "reviewer",
        });
      }),
    );
  }

  it.effect("persists source supplied with the first turn even when the name is unchanged", () =>
    Effect.gen(function* () {
      const initial = readModel();
      const result = yield* decideOrchestrationCommand({
        readModel: initial,
        command: command("thread.turn.start", selection("reviewer", "project")),
      });
      const events = Array.isArray(result) ? result : [result];
      let state = initial;
      for (const [index, event] of events.entries()) {
        state = yield* projectEvent(state, { ...event, sequence: index + 1 });
      }
      expect(state.threads[0]?.modelSelection).toEqual(selection("reviewer", "project"));
    }),
  );

  it.effect("keeps the agent locked when the session outlives retained messages", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        readModel: readModel({
          session: {
            threadId,
            status: "stopped",
            providerName: "kiro",
            providerInstanceId: instanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
        }),
        command: command("thread.meta.update", selection("writer")),
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
    }),
  );

  it.effect("does not retrofit a different agent into legacy started threads", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        readModel: readModel({ modelSelection: selection(), messages: [existingMessage] }),
        command: command("thread.turn.start", selection("writer")),
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
    }),
  );

  it.effect("does not change the agent when retrying the pre-appended bootstrap message", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        readModel: readModel({
          messages: [{ ...existingMessage, id: MessageId.make("next-message") }],
        }),
        command: command("thread.turn.start", selection("writer")),
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
    }),
  );
});
