import type { IssueRef } from "./github";
import { getPlan, savePlan } from "./store";

export const MENTION_TEMPLATES = {
  convert_to_discussion: "this looks like a usage question, consider converting it to a Q&A discussion.",
  close_duplicate: "this looks like a duplicate, consider closing it.",
  close_answered: "this looks resolved, consider closing it.",
  verify_fixed: "this looks fixed in a release but the reporter has not confirmed.",
  upstream_closed: "the linked upstream issue was closed, worth a retest or a dependency bump.",
  needs_reproduction_idle: "still no reproduction after the follow-up.",
  stale: "this looks obsolete.",
  security: "this looks like a publicly disclosed security report and needs your attention now.",
} as const;

export type MentionTemplate = keyof typeof MENTION_TEMPLATES;

export interface PlannedMention {
  template: MentionTemplate;
  /** One sentence of evidence. Also carries the English summary of a non-English issue. */
  detail: string;
}

/** Everything the run intends to do to one issue. Tools add to it, `apply_triage` executes it. */
export interface TriagePlan {
  issue: IssueRef;
  runId: string;
  dryRun: boolean;
  setType: string | null;
  addLabels: string[];
  removeLabels: string[];
  mentions: PlannedMention[];
  /** Slugs of the areas Jev found involved. Recorded whether or not the repo labels them. */
  areas: string[];
  /** Facts the comment must convey. The writing model rephrases them and adds nothing. */
  facts: string[];
  /** `needs_human`: nothing is written, the intake labels stay. */
  escalate: boolean;
  /** Security report: the mention is the only comment. */
  security: boolean;
  skipped: string | null;
  /** Versions for the templated retest request, set with the `RETEST_REQUEST` fact. */
  retest?: RetestRequest | null;
  /** Labels no step may remove, whatever an earlier step planned. */
  keepLabels?: string[];
  /** Issue Type after classification, existing or proposed. */
  type: string | null;
  steps: string[];
}

export interface RetestRequest {
  name: string;
  version: string;
  latest: string;
}

export function emptyPlan(issue: IssueRef, runId: string, dryRun: boolean): TriagePlan {
  return {
    issue: { owner: issue.owner, repo: issue.repo, issueNumber: issue.issueNumber },
    runId,
    dryRun,
    setType: null,
    addLabels: [],
    removeLabels: [],
    mentions: [],
    areas: [],
    facts: [],
    escalate: false,
    security: false,
    skipped: null,
    retest: null,
    keepLabels: [],
    type: null,
    steps: [],
  };
}

export interface PlanPatch {
  setType?: string;
  addLabels?: string[];
  removeLabels?: string[];
  mentions?: PlannedMention[];
  areas?: string[];
  facts?: string[];
  escalate?: boolean;
  security?: boolean;
  skipped?: string;
  type?: string;
  retest?: RetestRequest;
  keepLabels?: string[];
  /** A duplicate needs no reproduction: drops the planned `needs reproduction`, its request and a retest request. */
  supersedesReproduction?: boolean;
}

export function mergePlan(plan: TriagePlan, step: string, patch: PlanPatch): TriagePlan {
  const unique = (values: string[]) => [...new Set(values)];
  const drop = patch.supersedesReproduction === true;
  const mentions = [...plan.mentions];
  const keepLabels = unique([...(plan.keepLabels ?? []), ...(patch.keepLabels ?? [])]);
  for (const mention of patch.mentions ?? []) {
    if (!mentions.some((existing) => existing.template === mention.template)) mentions.push(mention);
  }
  return {
    ...plan,
    setType: patch.setType ?? plan.setType,
    addLabels: unique([...plan.addLabels, ...(patch.addLabels ?? [])]).filter((label) => !drop || label !== "needs reproduction"),
    removeLabels: unique([...plan.removeLabels, ...(patch.removeLabels ?? [])]).filter((label) => !keepLabels.includes(label)),
    mentions,
    areas: unique([...plan.areas, ...(patch.areas ?? [])]),
    // A retest asks about a reproduction too, so it goes with it.
    // Two steps can reach the same fact, such as the thanks for a reproduction. It is said once.
    facts: unique([...plan.facts, ...(patch.facts ?? [])]).filter((fact) => !drop || (fact !== "REPRODUCTION_REQUEST" && fact !== "RETEST_REQUEST")),
    escalate: plan.escalate || (patch.escalate ?? false),
    security: plan.security || (patch.security ?? false),
    skipped: patch.skipped ?? plan.skipped,
    retest: drop ? null : (patch.retest ?? plan.retest ?? null),
    keepLabels,
    type: patch.type ?? plan.type,
    steps: unique([...plan.steps, step]),
  };
}

export async function updatePlan(
  runId: string,
  issue: IssueRef,
  dryRun: boolean,
  step: string,
  patch: PlanPatch,
): Promise<TriagePlan> {
  const current = (await getPlan(issue)) ?? emptyPlan(issue, runId, dryRun);
  const next = mergePlan(current, step, patch);
  await savePlan(runId, next);
  return next;
}

export function hasWrites(plan: TriagePlan): boolean {
  return (
    plan.setType !== null ||
    plan.addLabels.length > 0 ||
    plan.removeLabels.length > 0 ||
    plan.mentions.length > 0 ||
    plan.facts.length > 0
  );
}
