import { expect, it } from "@effect/vitest";
import { getKiroAgentSource, withKiroAgentSelection } from "./kiroAgent.ts";

it("keeps provenance only when retaining the same agent, unless explicitly selected", () => {
  const original = withKiroAgentSelection([{ id: "effort", value: "high" }], "reviewer", "project");
  expect(getKiroAgentSource(withKiroAgentSelection(original, "reviewer"))).toBe("project");
  expect(getKiroAgentSource(withKiroAgentSelection(original, "writer"))).toBeUndefined();
  expect(getKiroAgentSource(withKiroAgentSelection(original, "reviewer", "global"))).toBe("global");
  expect(withKiroAgentSelection(original, undefined)).toEqual([{ id: "effort", value: "high" }]);
});
