import { KiroSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "@effect/vitest";
import { kiroSpawnInput } from "./KiroAcpSupport.ts";

const settings = Schema.decodeSync(KiroSettings)({ enabled: true });

it("passes an agent name as one CLI argument without changing the native default when absent", () => {
  expect(kiroSpawnInput(settings, "/workspace", {}).args).toEqual(["acp"]);
  expect(kiroSpawnInput({ ...settings, agent: "my-reviewer" }, "/workspace", {}).args).toEqual([
    "acp",
    "--agent",
    "my-reviewer",
  ]);
});
