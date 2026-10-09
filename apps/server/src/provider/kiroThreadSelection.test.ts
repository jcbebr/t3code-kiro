import { ProviderInstanceId, withKiroAgentSelection } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { kiroThreadSelection } from "./kiroThreadSelection.ts";
const current = {
  instanceId: ProviderInstanceId.make("kiro"),
  model: "auto",
  options: withKiroAgentSelection([], "reviewer", "project"),
};
it("keeps the pinned agent and source when an official client changes models", () => {
  expect(
    kiroThreadSelection(current, { instanceId: current.instanceId, model: "opus" }, true),
  ).toEqual({ selection: { ...current, model: "opus" } });
});
it("rejects changing the agent or only its source after work has started", () => {
  for (const options of [
    withKiroAgentSelection([], "builder", "project"),
    withKiroAgentSelection([], "reviewer", "global"),
  ]) {
    expect(kiroThreadSelection(current, { ...current, options }, true)).toHaveProperty("error");
    expect(kiroThreadSelection(current, { ...current, options }, false)).toEqual({
      selection: { ...current, options },
    });
  }
});
it("does not transfer the Kiro agent when switching to another provider", () => {
  const requested = { instanceId: ProviderInstanceId.make("codex"), model: "default" };
  expect(kiroThreadSelection(current, requested, true)).toEqual({ selection: requested });
});
it("rejects duplicate or malformed agent selections", () => {
  for (const options of [
    [{ id: "kiroAgent", value: "" }],
    [
      { id: "kiroAgent", value: "a" },
      { id: "kiroAgent", value: "b" },
    ],
    [{ id: "kiroAgentSource", value: "project" }],
  ]) {
    expect(kiroThreadSelection(current, { ...current, options }, false)).toHaveProperty("error");
  }
});
