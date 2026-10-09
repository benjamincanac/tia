import { defineTool } from "eve/tools";
import { z } from "zod";

import { isEnabled } from "../config";
import { RECENT_ACTIVITY, skipReason } from "../lib/context";
import { hasReproductionQuestions, staleQuestions } from "../lib/jev/questions";
import { getTimeline, listReleases } from "../lib/github";
import { ask, clip } from "../lib/jev";
import { updatePlan, type PlanPatch } from "../lib/plan";
import { issueState } from "../lib/steps/classify";
import { clearEvaluated, getClassified, isMarked, recordDecision } from "../lib/store";
import { labeledAt, releaseCheckApplies } from "../lib/sweep";
import { issueInput, requireContext, runId } from "../lib/tool";

const DAY_MS = 24 * 60 * 60_000;

function daysSince(date: string | undefined): number {
  return date ? (Date.now() - Date.parse(date)) / DAY_MS : 0;
}

export default defineTool({
  description:
    "Daily sweep step for one issue. Applies the time based rules: follow up once on `needs reproduction` when Jev still finds none and the reporter did not answer, mention maintainers when it stays without one, mention them when a `needs verification` issue gets no confirmation, and ask Jev whether a long idle issue that was never triaged is still relevant. On a release pass it only re-checks whether the issue is fixed. Returns the tools to call next.",
  inputSchema: issueInput.extend({
    release: z.boolean().default(false).describe("True on a release pass, which re-checks the fix and nothing else."),
  }),
  label: { start: ({ owner, repo, issueNumber }) => `Sweep ${owner}/${repo}#${issueNumber}` },
  async execute({ release, ...ref }, ctx) {
    const context = await requireContext(ref, ctx.abortSignal);
    const { config, issue } = context;

    // The issue was queued minutes to hours ago. It may have been closed, pinned or picked up by a
    // human since, and a pass that never reaches `classify_issue` has no other place to notice.
    const skipped = skipReason(context, false);
    if (skipped) {
      // The sweep counted the issue as evaluated when it queued it. This skip is over in an hour, so the next sweep takes it again.
      if (skipped === RECENT_ACTIVITY) await clearEvaluated(ref);
      await updatePlan(runId(ctx), ref, context.dryRun, "sweep_issue", { skipped });
      return { skipped, facts: [] as string[], mentions: [] as string[], next: [] as string[] };
    }

    const { followUpDays, mentionDays, staleDays } = config.sweep;
    // Planned again until `apply_triage` writes it: an approval nobody answered must not use up the only follow-up.
    const pending = async (marker: string) => !(await isMarked(ref, marker));

    const timeline = await getTimeline(ref, ctx.abortSignal);
    const reporterReplied = (since: string | undefined) =>
      issue.comments.some((comment) => comment.author === issue.author && (!since || comment.createdAt > since));

    let patch: PlanPatch = {};
    let next: string[] = [];
    let answers: unknown = null;

    // A release changes whether the issue is fixed, nothing about its kind or the part it touches,
    // so it re-checks that alone. Anything else on the issue is a `sweep` and takes the branches below.
    if (release) {
      if (releaseCheckApplies(config, issue, context.kinds, await getClassified(ref))) next = ["check_fixed_in_release"];
    } else if (issue.labels.includes("needs reproduction")) {
      const since = labeledAt(timeline, "needs reproduction");
      // Counted like the sweep that queued the issue: from `updatedAt` when the timeline does not show the label.
      // A reply is still read against the label alone, since the reply itself moves `updatedAt`.
      const age = daysSince(since ?? issue.updatedAt);
      // A reporter who answered is not asked again, and what they said is classified. The maintainers are still told when no reproduction came of it.
      const replied = reporterReplied(since);
      if (replied) next = ["classify_issue"];
      if (age >= (replied ? mentionDays : followUpDays)) {
        // Nobody is asked twice on an old answer. The request may have been wrong, or someone other than the reporter may have answered it.
        const result = await ask(hasReproductionQuestions(), issueState(context), ctx.abortSignal);
        answers = result;
        if (result.has_reproduction.probability >= config.thresholds.has_reproduction) next = ["classify_issue"];
        else if (age >= mentionDays) {
          if (await pending("reproduction-mention")) {
            patch = { mentions: [{ template: "needs_reproduction_idle", detail: `No reproduction after ${Math.floor(age)} days.` }], once: ["reproduction-mention"] };
          }
        } else if (await pending("reproduction-follow-up")) {
          patch = {
            facts: ["Friendly follow-up: a reproduction is still needed to look into this. Ask for it in one short sentence. Nothing is appended to it."],
            once: ["reproduction-follow-up"],
          };
        }
      }
    } else if (issue.labels.includes("needs verification")) {
      const since = labeledAt(timeline, "needs verification");
      if (reporterReplied(since)) next = ["classify_issue"];
      else if (daysSince(since ?? issue.updatedAt) >= followUpDays && (await pending("verification-mention"))) {
        const evidence = issue.comments.findLast((comment) => comment.authorType === "Bot")?.body ?? "";
        patch = { mentions: [{ template: "verify_fixed", detail: clip(evidence.split("\n")[0] ?? "", 200) }], once: ["verification-mention"] };
      }
    } else if (isEnabled(config, "stale") && context.intakeLabels.some((label) => issue.labels.includes(label)) && daysSince(issue.updatedAt) >= staleDays) {
      const releases = (await listReleases(ref, ctx.abortSignal))
        .filter((release) => release.published_at && release.published_at > issue.createdAt)
        .slice(0, 10)
        .map((release) => ({ tag: release.tag_name, notes: clip(release.body ?? "", 1_500) }));
      const result = await ask(staleQuestions, { issue: issueState(context), releases }, ctx.abortSignal);
      answers = result;
      if (1 - result.still_relevant.probability >= config.thresholds.stale) {
        patch = {
          addLabels: issue.labels.includes("stale") ? [] : ["stale"],
          mentions: [{ template: "stale", detail: `Idle for ${Math.floor(daysSince(issue.updatedAt))} days and likely obsolete given the releases since.` }],
        };
      } else next = ["classify_issue"];
    } else {
      next = ["classify_issue"];
    }

    await updatePlan(runId(ctx), ref, context.dryRun, "sweep_issue", patch);
    await recordDecision({
      at: new Date().toISOString(),
      repo: `${ref.owner}/${ref.repo}`,
      issueNumber: ref.issueNumber,
      step: "sweep",
      answers,
      actions: patch,
      dryRun: context.dryRun,
      runId: runId(ctx),
    });
    return { skipped: null, facts: patch.facts ?? [], mentions: (patch.mentions ?? []).map((mention) => mention.template), next };
  },
});
