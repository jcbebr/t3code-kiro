import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { discoverKiroSkills, rewriteKiroSkillMentions } from "./KiroSkills.ts";

it("sends known skill picks as Kiro slash commands", () => {
  expect(
    rewriteKiroSkillMentions("Use $review and $missing; budget $20", new Set(["review"])),
  ).toBe("Use /review and $missing; budget $20");
});

it.effect("discovers global and project skills, preferring the project copy", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-skills-" });
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const writeSkill = (directory: string, name: string, description: string) =>
      Effect.gen(function* () {
        const folder = path.join(directory, "skills", name);
        yield* fs.makeDirectory(folder, { recursive: true });
        yield* fs.writeFileString(
          path.join(folder, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${description}\n---\nInstructions\n`,
        );
      });
    yield* writeSkill(path.join(home, ".kiro"), "shared", "Global copy");
    yield* writeSkill(path.join(home, ".kiro"), "global", "Global only");
    yield* writeSkill(path.join(project, ".kiro"), "shared", "Project copy");
    yield* writeSkill(path.join(project, ".kiro"), "project", "Project only");

    const skills = yield* discoverKiroSkills(project, { HOME: home });
    expect(skills.map(({ name, scope, description }) => ({ name, scope, description }))).toEqual([
      { name: "global", scope: "user", description: "Global only" },
      { name: "project", scope: "project", description: "Project only" },
      { name: "shared", scope: "project", description: "Project copy" },
    ]);
    expect(skills[2]?.path).toBe(path.join(project, ".kiro", "skills", "shared", "SKILL.md"));

    const alternateHome = path.join(root, "alternate-kiro-home");
    yield* writeSkill(alternateHome, "alternate", "Alternate global root");
    const overridden = yield* discoverKiroSkills(project, {
      HOME: home,
      KIRO_HOME: alternateHome,
    });
    expect(overridden.map((skill) => skill.name)).toEqual(["alternate", "project", "shared"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("skips files Kiro cannot load as skills", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-skills-" });
    const skillsRoot = path.join(root, ".kiro", "skills");
    for (const [folder, content] of [
      ["missing-frontmatter", "# Instructions"],
      ["invalid-yaml", "---\nname: [oops\n---\n"],
      ["wrong-name", "---\nname: other\ndescription: Wrong name\n---\n"],
      ["missing-description", "---\nname: missing-description\n---\n"],
    ] as const) {
      const directory = path.join(skillsRoot, folder);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, "SKILL.md"), content);
    }
    expect(yield* discoverKiroSkills(root, { KIRO_HOME: path.join(root, "home") })).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
