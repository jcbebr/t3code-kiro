import { TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import { TextGeneration } from "./TextGeneration.ts";
import { sanitizeThreadTitle } from "./TextGenerationUtils.ts";

// These helpers never start an agent or send company code to another provider.
export const kiroTextGeneration = TextGeneration.of({
  generateThreadTitle: ({ message }) => Effect.succeed({ title: sanitizeThreadTitle(message) }),
  generateBranchName: ({ message }) =>
    Effect.succeed({ branch: sanitizeBranchFragment(message.slice(0, 80)) || "kiro-work" }),
  generateCommitMessage: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateCommitMessage",
        detail:
          "Kiro automatic commit messages are not supported yet. Write the commit message manually.",
      }),
    ),
  generatePrContent: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generatePrContent",
        detail:
          "Kiro automatic pull request descriptions are not supported yet. Write the description manually.",
      }),
    ),
});
