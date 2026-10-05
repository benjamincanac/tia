import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";

import { requireApproval } from "../config";
import { commentProblem, reporterText } from "./apply";
import { FIXTURE_OWNER, loadTriageContext, type TriageContext } from "./context";
import { loadRepoConfig, type IssueRef } from "./github";
import { hasWrites } from "./plan";
import { getPlan, isDryRunForced, isTriageRun } from "./store";

export const issueInput = z.object({
  owner: z.string().min(1).describe("Repository owner"),
  repo: z.string().min(1).describe("Repository name"),
  issueNumber: z.number().int().positive(),
});

/** One plan per turn. A session is reused for every event on the same issue thread. */
export function runId(ctx: { session: { id: string; turn: { id: string } } }): string {
  return `${ctx.session.id}:${ctx.session.turn.id}`;
}

export async function requireContext(ref: IssueRef, signal?: AbortSignal): Promise<TriageContext> {
  const context = await loadTriageContext(ref, signal);
  if (!context) throw new Error(`Triage is disabled for ${ref.owner}/${ref.repo}: no valid .github/tia.yml.`);
  if (await isDryRunForced(ref)) context.dryRun = true;
  return context;
}

/**
 * Backlog tools answer a maintainer's questions. Inside a triage run they are a detour, and a small
 * model will take it, so they refuse once the run has a plan.
 */
export async function refuseDuringTriage(ctx: { session: { id: string; turn: { id: string } } }): Promise<void> {
  if (await isTriageRun(runId(ctx))) {
    throw new Error("Not available during a triage run. Follow the triage skill and finish with apply_triage.");
  }
}

const approvalInput = issueInput.extend({ comment: z.string().default("") });

/** Pauses for a maintainer before a real write. Dry runs write nothing, so they never ask. */
export async function writeApproval<T>({ toolInput }: ApprovalContext<T>): Promise<ApprovalStatus> {
  const input = approvalInput.safeParse(toolInput);
  if (!input.success) return "user-approval";
  if (input.data.owner === FIXTURE_OWNER) return "not-applicable";
  const config = await loadRepoConfig(input.data);
  if (!config) return { type: "denied", reason: "Triage is disabled for this repository." };
  if (await isDryRunForced(input.data)) return "not-applicable";
  // A sweep asks about every open issue and most of them need nothing. Asking a maintainer to
  // approve a run that writes nothing is the fastest way to teach them to approve without reading.
  // An escalated or skipped plan is blocked in `applyPlan`, so it never writes either.
  const plan = await getPlan(input.data);
  if (plan && (plan.escalate || plan.skipped)) return "not-applicable";
  const comment = reporterText(plan, input.data.comment);
  if (plan && !hasWrites(plan) && !comment) return "not-applicable";
  if (!requireApproval()) return "not-applicable";
  // A comment the tool would refuse is sent back to the model first. Otherwise the maintainer approves
  // it, the tool throws, and they are asked a second time for the rewrite.
  // An issue that cannot be read, a number that was never one or an issue deleted since it was
  // queued, has nothing to approve. The tool would throw right after the maintainer's click.
  const context = await loadTriageContext(input.data).catch(() => null);
  if (!context) return { type: "denied", reason: "The issue could not be read. End the run without calling apply_triage again." };
  const problem = plan ? commentProblem(plan, comment, context.reproduction) : null;
  return problem ? { type: "denied", reason: problem } : "user-approval";
}
