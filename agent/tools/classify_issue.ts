import { defineTool } from "eve/tools";
import { z } from "zod";

import { quietReason, skipReason } from "../lib/context";
import { updatePlan } from "../lib/plan";
import { classify } from "../lib/steps/classify";
import { recordDecision, rememberClassified } from "../lib/store";
import { issueInput, requireContext, runId } from "../lib/tool";

export default defineTool({
  description:
    "First step of the triage pipeline. Classifies an issue with Jev in a single request and records the resulting decisions in the run's plan. Returns the decisions and the tools to call next. Never returns probabilities.",
  inputSchema: issueInput.extend({
    force: z.boolean().default(false).describe("True only when the bot was explicitly @-mentioned to re-triage."),
  }),
  label: { start: ({ owner, repo, issueNumber }) => `Classify ${owner}/${repo}#${issueNumber}` },
  async execute({ force, ...ref }, ctx) {
    const context = await requireContext(ref, ctx.abortSignal);
    const run = runId(ctx);

    const skipped = skipReason(context, force);
    if (skipped) {
      await updatePlan(run, ref, context.dryRun, "classify", { skipped });
      return { skipped, next: [] as string[] };
    }

    const outcome = await classify(context, ctx.abortSignal);
    const quiet = force ? null : quietReason(context);
    const plan = await updatePlan(run, ref, context.dryRun, "classify", { ...outcome.patch, quiet, ...(outcome.type ? { type: outcome.type } : {}) });
    // Kept for the release passes, which re-check the fix without classifying again.
    await rememberClassified(ref, { releaseCheck: outcome.report && !plan.escalate && !plan.security, areas: plan.areas });
    await recordDecision({
      at: new Date().toISOString(),
      repo: `${ref.owner}/${ref.repo}`,
      issueNumber: ref.issueNumber,
      step: "classify",
      answers: outcome.answers,
      actions: outcome.patch,
      dryRun: context.dryRun,
      runId: run,
    });

    return {
      skipped: null,
      dryRun: context.dryRun,
      escalate: plan.escalate,
      security: plan.security,
      type: outcome.type,
      upstream: plan.addLabels.find((label) => label.startsWith("upstream/")) ?? null,
      plannedLabels: plan.addLabels,
      areas: plan.areas,
      facts: plan.quiet ? [] : plan.facts,
      // Nothing is said on the issue: the comment is empty whatever the later tools find.
      quiet: plan.quiet ?? null,
      next: plan.escalate || plan.security ? [] : outcome.next,
    };
  },
});
