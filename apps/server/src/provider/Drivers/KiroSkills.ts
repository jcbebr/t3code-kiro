import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MAX_SKILL_BYTES = FileSystem.Size(1_000_000);
const SKILL_MENTION_PATTERN =
  /(^|\s)\$(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/g;

/** T3 composers insert `$name`; Kiro invokes a skill with `/name`. */
export function rewriteKiroSkillMentions(prompt: string, skillNames: ReadonlySet<string>): string {
  return prompt.replace(SKILL_MENTION_PATTERN, (match, prefix: string, name: string) =>
    skillNames.has(name) ? `${prefix}/${name}` : match,
  );
}

function parseSkillFrontmatter(contents: string): Record<string, unknown> | undefined {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return undefined;
  try {
    const parsed: unknown = parseYamlDocument(match[1] ?? "");
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Kiro resolves same-name workspace skills before global skills. */
export const discoverKiroSkills = Effect.fn("discoverKiroSkills")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = environment.HOME || environment.USERPROFILE || NodeOS.homedir();
  const globalRoot = environment.KIRO_HOME
    ? path.resolve(cwd, environment.KIRO_HOME)
    : path.join(home, ".kiro");
  const roots = [
    { directory: path.join(globalRoot, "skills"), scope: "user" },
    { directory: path.join(cwd, ".kiro", "skills"), scope: "project" },
  ] as const;
  const skillsByName = new Map<string, ServerProviderSkill>();

  for (const root of roots) {
    const entries = yield* fs
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of [...entries].sort()) {
      const skillPath = path.join(root.directory, entry, "SKILL.md");
      const stat = yield* fs.stat(skillPath).pipe(Effect.orElseSucceed(() => undefined));
      if (stat?.type !== "File" || stat.size > MAX_SKILL_BYTES) continue;
      const contents = yield* fs
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      const record = contents && parseSkillFrontmatter(contents);
      if (!record) continue;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const description = typeof record.description === "string" ? record.description.trim() : "";
      if (!name || !description || name !== entry) continue;

      skillsByName.set(name, {
        name,
        description,
        path: skillPath,
        scope: root.scope,
        enabled: true,
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
