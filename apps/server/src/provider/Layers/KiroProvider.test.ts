import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { KiroSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { KIRO_DRIVER } from "../acp/KiroAcpSupport.ts";
import { makeKiroProvider } from "./KiroProvider.ts";

const policy = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  shouldRunScopeWork: () => Effect.succeed(false),
});
const services = Layer.mergeAll(NodeServices.layer, policy, ServerSettingsService.layerTest());
const decodeSettings = Schema.decodeSync(KiroSettings);
const fixture = Effect.fn("KiroProviderTest.fixture")(function* (
  mode: "logged-in" | "logged-out" | "disabled" | "missing",
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "kiro cli test " });
  const log = `${directory}/calls.txt`;
  const binary = writeFakeCli({
    directory,
    name: "kiro-cli",
    env: { KIRO_TEST_LOG: log, KIRO_TEST_MODE: mode },
    source: `
    import { appendFileSync } from "node:fs";
    const args = process.argv.slice(2);
    appendFileSync(process.env.KIRO_TEST_LOG, args.join(" ") + "\\n");
    if (args[0] === "--version") { console.log("kiro-cli 2.22.0"); process.exit(0); }
    if (args.join(" ") === "whoami --format json") {
      console.log(JSON.stringify({ account: process.env.KIRO_TEST_MODE === "logged-in" ? "test-account" : null }));
      process.exit(process.env.KIRO_TEST_MODE === "logged-in" ? 0 : 1);
    }
    process.exit(99);
  `,
  });
  const settings = decodeSettings({
    enabled: mode !== "disabled",
    binaryPath: mode === "missing" ? `${directory}/missing` : binary,
  });
  const provider = yield* makeKiroProvider(settings, process.env, (draft) => ({
    ...draft,
    driver: KIRO_DRIVER,
    instanceId: ProviderInstanceId.make("kiro-test"),
  }));
  const snapshot = yield* provider.snapshot.refresh;
  const calls = yield* fs.readFileString(log).pipe(Effect.orElseSucceed(() => ""));
  return { snapshot, calls: calls.trim().split("\n").filter(Boolean) };
});

it.effect(
  "checks the existing login without opening ACP sessions or leaking account metadata",
  () =>
    Effect.gen(function* () {
      const { snapshot, calls } = yield* fixture("logged-in");
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "cli",
        label: "Kiro CLI login",
      });
      expect(snapshot.models[0]?.slug).toBe("kiro-default");
      expect(calls.every((call) => ["--version", "whoami --format json"].includes(call))).toBe(
        true,
      );
      expect(calls).toContain("whoami --format json");
    }).pipe(Effect.scoped, Effect.provide(services)),
);
it.effect("reports a missing login with a CLI login instruction", () =>
  Effect.gen(function* () {
    const { snapshot } = yield* fixture("logged-out");
    expect(snapshot.installed).toBe(true);
    expect(snapshot.version).toBe("2.22.0");
    expect(snapshot.auth.status).toBe("unauthenticated");
    expect(snapshot.message).toContain("kiro-cli login");
  }).pipe(Effect.scoped, Effect.provide(services)),
);
it.effect("does not launch a disabled provider", () =>
  Effect.gen(function* () {
    const { snapshot, calls } = yield* fixture("disabled");
    expect(snapshot.status).toBe("disabled");
    expect(calls).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(services)),
);
it.effect("distinguishes a missing executable from a signed-out CLI", () =>
  Effect.gen(function* () {
    const { snapshot } = yield* fixture("missing");
    expect(snapshot.installed).toBe(false);
    expect(snapshot.auth.status).toBe("unknown");
    expect(snapshot.message).toContain("not found");
  }).pipe(Effect.scoped, Effect.provide(services)),
);
