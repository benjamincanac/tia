import { defineTool } from "eve/tools";
import { z } from "zod";

import { hasReproductionQuestions } from "../lib/jev/questions";
import { ask, clip } from "../lib/jev";
import { updatePlan } from "../lib/plan";
import { recordDecision } from "../lib/store";
import { issueInput, requireContext, runId } from "../lib/tool";

export default defineTool({
  description:
    "Call when the reporter comments on an issue that waits for them. On an issue labeled `needs reproduction` it asks Jev whether that comment provides a reproduction, and when it does, plans the label removal and a thank you. Returns classify_issue in `next` when the pipeline has to run again.",
  inputSchema: issueInput.extend({ commentId: z.number().int().positive() }),
  label: { start: ({ owner, repo, issueNumber }) => `Check new comment on ${owner}/${repo}#${issueNumber}` },
  async execute({ commentId, ...ref }, ctx) {
    const context = await requireContext(ref, ctx.abortSignal);
    const comment = context.issue.comments.find((candidate) => candidate.id === commentId);
    if (!comment) throw new Error(`Comment ${commentId} not found on the issue.`);
    // An issue that waits for a confirmation has no reproduction to look for. What the reporter answered is classified.
    if (!context.issue.labels.includes("needs reproduction")) {
      return { hasReproduction: false, next: context.issue.labels.includes("needs verification") ? ["classify_issue"] : [] };
    }

    const answers = await ask(
      hasReproductionQuestions(),
      { title: context.issue.title, body: "", comments: [{ author: comment.author, body: clip(comment.body, 6_000) }] },
      ctx.abortSignal,
    );
    const hasReproduction = answers.has_reproduction.probability >= context.config.thresholds.has_reproduction;
    const patch = hasReproduction
      ? { removeLabels: ["needs reproduction"], facts: [`Thank @${comment.author} for the reproduction.`] }
      : {};

    await updatePlan(runId(ctx), ref, context.dryRun, "check_reproduction_comment", patch);
    await recordDecision({
      at: new Date().toISOString(),
      repo: `${ref.owner}/${ref.repo}`,
      issueNumber: ref.issueNumber,
      step: "reproduction_comment",
      answers,
      actions: patch,
      dryRun: context.dryRun,
      runId: runId(ctx),
    });
    // An issue can wait for both. Without a reproduction the comment may still answer the confirmation.
    return { hasReproduction, next: hasReproduction || context.issue.labels.includes("needs verification") ? ["classify_issue"] : [] };
  },
});
