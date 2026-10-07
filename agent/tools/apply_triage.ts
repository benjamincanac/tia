import { defineTool } from "eve/tools";
import { z } from "zod";

import { applyPlan, commentProblem, MAX_COMMENT_WORDS, reporterText } from "../lib/apply";
import { skipReason } from "../lib/context";
import { emptyPlan, hasWrites } from "../lib/plan";
import { getPlan } from "../lib/store";
import { issueInput, requireContext, runId, writeApproval } from "../lib/tool";

export default defineTool({
  description:
    "Last step of a run and the only tool that writes to GitHub. Applies the plan recorded by the other tools: Issue Type, labels, and one comment. You only provide the comment text. Labels and mentions come from the plan and cannot be changed here. In dry-run it logs the intended actions and writes nothing.",
  inputSchema: issueInput.extend({
    comment: z
      .string()
      .describe(
        `The comment for the reporter, in English, friendly maintainer tone, under ${MAX_COMMENT_WORDS} words, conveying the plan's facts and nothing else. Empty string when the plan has no facts. The reproduction request and the maintainer mention are appended automatically, do not write them.`,
      ),
  }),
  approval: { request: writeApproval },
  label: { start: ({ owner, repo, issueNumber }) => `Apply triage to ${owner}/${repo}#${issueNumber}` },
  async execute({ comment: written, ...ref }, ctx) {
    const context = await requireContext(ref, ctx.abortSignal);
    const recorded = await getPlan(ref);
    const comment = reporterText(recorded, written);
    // Without a plan no tool evaluated the skip rules for this run, so they are evaluated here.
    // The activity guard is off: this path answers an explicit @-mention.
    const plan = recorded ?? { ...emptyPlan(ref, runId(ctx), context.dryRun), skipped: skipReason(context, true) };

    if (!plan.escalate && !plan.skipped && !hasWrites(plan) && !comment.trim()) {
      return { applied: false, reason: "Nothing to do: no decision was taken, the issue stays in triage." };
    }

    // Runs that ask for an approval were already checked before the prompt. Dry runs and fixtures are checked here.
    const problem = commentProblem(plan, comment, context.reproduction);
    if (problem) throw new Error(problem);

    const actions = await applyPlan(context.config, plan, comment, context.humanLabels, context.reporterLabels, context.issue.labels, context.reproduction, context.intakeLabels, context.kinds);
    return { applied: !actions.dryRun, ...actions };
  },
});
