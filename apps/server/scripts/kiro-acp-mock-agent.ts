import * as NodeReadline from "node:readline";
import * as Schema from "effect/Schema";

const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.Number),
      method: Schema.String,
      params: Schema.optional(
        Schema.Struct({
          sessionId: Schema.optional(Schema.String),
          modelId: Schema.optional(Schema.String),
          value: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

// Both Kiro engines negotiate ACP v1, but expose different model selection methods.
const modern = process.env.T3_KIRO_MOCK_MODEL_CONFIG === "1";
let model = "auto";
const models = () => ({
  currentModelId: model,
  availableModels: [
    { modelId: "auto", name: "Auto" },
    { modelId: "claude-opus", name: "Opus" },
  ],
});
const configOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: models().availableModels.map(({ modelId, name }) => ({ value: modelId, name })),
  },
];

NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = decodeRequest(line);
  if (request.id === undefined) return;
  let result: unknown;
  switch (request.method) {
    case "initialize":
      result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
      break;
    case "session/new":
    case "session/load":
      result = {
        sessionId: request.params?.sessionId ?? "kiro-mock-session",
        ...(modern ? { configOptions: configOptions() } : { models: models() }),
      };
      break;
    case "session/set_model":
      if (modern) break;
      model = request.params?.modelId ?? "auto";
      result = {};
      break;
    case "session/set_config_option":
      if (!modern) break;
      model = request.params?.value ?? "auto";
      result = { configOptions: configOptions() };
      break;
    case "session/prompt":
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: request.params?.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: model },
            },
          },
        }) + "\n",
      );
      result = { stopReason: "end_turn" };
      break;
  }
  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      ...(result === undefined
        ? { error: { code: -32601, message: "Method not found", data: request.method } }
        : { result }),
    }) + "\n",
  );
});
