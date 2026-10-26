import { buildComment } from "./apply";
import { quietReason, skipReason, type TriageContext } from "./context";
import { emptyPlan, mergePlan, type TriagePlan } from "./plan";
import { classify } from "./steps/classify";
import { checkDuplicate } from "./steps/duplicate";
import { checkFixedInRelease, knownAreas } from "./steps/fixed";
import { validateReproduction } from "./steps/reproduction";
import { trackUpstream } from "./steps/upstream";

export interface PipelineResult {
  plan: TriagePlan;
  /** Raw Jev answers per step, as persisted next to every action. */
  answers: Record<string, unknown>;
  /** The comment minus the model written sentence: templated request and maintainer mention. */
  commentPreview: string;
}

/**
 * The pipeline without an agent session, in the order the `triage` skill prescribes.
 * Used by the local backfill, which has no model to write comments.
 */
export async function runPipeline(context: TriageContext, options: { signal?: AbortSignal } = {}): Promise<PipelineResult> {
  context = { ...context, dryRun: true };
  const { config, issue } = context;
  const { signal } = options;
  let plan = emptyPlan(issue, "backfill", true);
  const answers: Record<string, unknown> = {};

  const skipped = skipReason(context, false);
  if (skipped) return { plan: mergePlan(plan, "classify", { skipped }), answers, commentPreview: "" };

  const classified = await classify(context, signal);
  answers.classify = classified.answers;
  plan = mergePlan(plan, "classify", { ...classified.patch, quiet: quietReason(context), ...(classified.type ? { type: classified.type } : {}) });

  if (!plan.escalate && !plan.security) {
    if (classified.next.includes("validate_reproduction")) {
      const reproduction = await validateReproduction(context, signal);
      plan = mergePlan(plan, "validate_reproduction", reproduction.patch);
    }

    if (classified.next.includes("track_upstream")) {
      const label = plan.addLabels.find((candidate) => candidate.startsWith("upstream/"));
      const upstream = config.upstreams.find((slug) => `upstream/${slug.split("/")[1]}` === label);
      if (upstream) {
        const tracked = await trackUpstream(context, upstream, signal);
        answers.upstream = tracked.answers;
        plan = mergePlan(plan, "track_upstream", tracked.patch);
      }
    }

    if (classified.next.includes("check_fixed_in_release")) {
      const areaSlugs = knownAreas(context, plan.areas);
      const fixed = await checkFixedInRelease(context, areaSlugs, signal);
      answers.fixed = fixed.answers;
      plan = mergePlan(plan, "check_fixed_in_release", fixed.patch);
    }

    if (classified.next.includes("check_duplicate")) {
      const duplicate = await checkDuplicate(context, signal);
      answers.duplicate = duplicate.answers;
      plan = mergePlan(plan, "check_duplicate", duplicate.patch);
    }
  }

  return { plan, answers, commentPreview: plan.escalate ? "" : buildComment(config, plan, "", context.reproduction) };
}
