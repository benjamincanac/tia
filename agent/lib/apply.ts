import { createHash } from "node:crypto";

import { isProduction, type RepoConfig } from "../config";
import { addComment, addLabels, ensureLabel, removeLabel, setIssueType } from "./github";
import type { IssueKind, ReproductionSettings } from "./issue-forms";
import { isManagedLabel, labelStyle } from "./labels";
import { MENTION_TEMPLATES, type RetestRequest, type TriagePlan } from "./plan";
import { getLastAnnounced, isPreviewWriteAllowed, markOnce, recordDecision, setLastAnnounced } from "./store";

export const MAX_COMMENT_WORDS = 80;

/** Why a reproduction is asked for, whatever the project. Used when the repository links no guide of its own. */
const DEFAULT_REPRODUCTION_GUIDE = "https://antfu.me/posts/why-reproductions-are-required";

/** Short templated request, built from what the repo's issue form says about reproductions. */
export function reproductionRequest(settings: ReproductionSettings): string {
  const { templates } = settings;
  const ask = `Would you be able to provide a [reproduction](${settings.guide ?? DEFAULT_REPRODUCTION_GUIDE})? 🙏`;
  if (templates.length === 0) return `${ask} Please keep it as minimal as possible.`;
  const links = templates.map((template) => `[${template.name.replace(/^the\s+/i, "")}](${template.url})`);
  const list = links.length > 1 ? `${links.slice(0, -1).join(", ")} or ${links.at(-1)}` : links[0];
  return `${ask} You can start from ${list}, and keep it as minimal as possible.`;
}

/** Fixed wording, so a retest ask never claims the reproduction was run or promises a follow-up. */
export function retestRequest(retest: RetestRequest): string {
  return `Could you check whether it still happens on ${retest.name} ${retest.latest}, the latest release? This was reported on ${retest.version}.`;
}

/** What `apply_triage` appends after the model's sentence, one entry per templated fact. */
function templated(plan: TriagePlan, reproduction: ReproductionSettings): string[] {
  const parts: string[] = [];
  if (plan.facts.includes("REPRODUCTION_REQUEST")) parts.push(reproductionRequest(reproduction));
  if (plan.facts.includes("RETEST_REQUEST") && plan.retest) parts.push(retestRequest(plan.retest));
  return parts;
}

const TEMPLATED_FACTS = ["REPRODUCTION_REQUEST", "RETEST_REQUEST"];

/** The bot only ever applies its own labels. `closed-by-bot`, priorities and the rest belong to maintainers. */
export function isAllowedLabel(config: RepoConfig, label: string): boolean {
  return labelStyle(config, label) !== null;
}

export function countWords(text: string): number {
  // Links count as their text, not their URL.
  const visible = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "link");
  return visible.split(/\s+/).filter(Boolean).length;
}

export function mentionLine(config: RepoConfig, plan: TriagePlan): string {
  if (plan.mentions.length === 0) return "";
  const handles = config.maintainers.map((login) => `@${login}`).join(" ");
  const reasons = plan.mentions.map((mention) => `${MENTION_TEMPLATES[mention.template]} ${mention.detail}`.trim());
  return `cc ${handles}: ${reasons.join(" ")}`;
}

export function buildComment(config: RepoConfig, plan: TriagePlan, written: string, reproduction: ReproductionSettings): string {
  const parts: string[] = [];
  if (plan.security) {
    // Fixed wording. Nothing the model writes is posted next to a disclosed vulnerability.
    const where = config.securityPolicy ? `following our [security policy](${config.securityPolicy})` : "through the repository's security policy";
    parts.push(`Thanks for the report. Please report security issues privately ${where} rather than in a public issue.`);
  } else if (written.trim()) parts.push(written.trim());
  parts.push(...templated(plan, reproduction));
  const mention = mentionLine(config, plan);
  if (mention) parts.push(mention);
  return parts.join("\n\n");
}

export interface AppliedActions {
  dryRun: boolean;
  blocked: string | null;
  setType: string | null;
  addedLabels: string[];
  removedLabels: string[];
  keptHumanLabels: string[];
  comment: string | null;
  commentUrl: string | null;
}

/**
 * The model's text only goes out to convey facts. A triage run that recorded none has nothing to tell
 * the reporter, and a small model fills the silence with "noted, nothing else needed". Without a
 * recorded plan the run answers an explicit mention, and its text is the answer.
 */
export function reporterText(plan: TriagePlan | null, comment: string): string {
  return plan && plan.facts.length === 0 ? "" : comment.trim();
}

/** Why the model has to rewrite its comment, or `null`. The message tells it what to change. */
export function commentProblem(plan: TriagePlan, comment: string, reproduction: ReproductionSettings): string | null {
  const appended = templated(plan, reproduction).join(" ");
  // The requests are appended in full. When they are the only facts, a comment that makes one
  // says the same thing twice. A run that also found an unusable link still has to explain it.
  const onlyTemplated = plan.facts.every((fact) => TEMPLATED_FACTS.includes(fact));
  if (appended && onlyTemplated && /reproduc|sandbox|stackblitz|codesandbox|minimal|retest|latest|version|\d+\.\d+/i.test(comment)) {
    return "The request is appended for you, so the comment must not make it. Keep one short sentence thanking the reporter, and call apply_triage again.";
  }
  const words = countWords(`${comment} ${appended}`);
  if (words > MAX_COMMENT_WORDS) return `The comment is ${words} words with the appended request, the limit is ${MAX_COMMENT_WORDS}. Shorten it and call apply_triage again.`;
  return null;
}

/** The only place that writes to an issue. */
export async function applyPlan(
  config: RepoConfig,
  plan: TriagePlan,
  written: string,
  humanLabels: ReadonlySet<string>,
  reporterLabels: ReadonlySet<string>,
  currentLabels: readonly string[],
  reproduction: ReproductionSettings,
  intakeLabels: readonly string[],
  kinds: readonly IssueKind[],
): Promise<AppliedActions> {
  // Labels of a kind are the repository's own, from its issue forms. Everything else has to be one of the bot's.
  const allowed = (label: string) => isAllowedLabel(config, label) || kinds.some((kind) => kind.labels.includes(label));
  const addedLabels = plan.addLabels.filter((label) => allowed(label) && !currentLabels.includes(label));
  const removable = plan.removeLabels.filter((label) => currentLabels.includes(label));
  // Intake labels come from the issue forms, so they count as applied by the reporter. So does what the reporter picked
  // with a form, the label of a kind or one of tia's own, which goes when the issue turns out to be something else.
  // They are the only ones of those the bot removes.
  const fromForm = (label: string) =>
    intakeLabels.includes(label) || (reporterLabels.has(label) && (isManagedLabel(label) || kinds.some((kind) => kind.labels.includes(label))));
  const removedLabels = removable.filter((label) => fromForm(label) || !humanLabels.has(label));
  const keptHumanLabels = removable.filter((label) => !removedLabels.includes(label));
  const comment = plan.escalate ? "" : buildComment(config, plan, written, reproduction);

  const actions: AppliedActions = {
    dryRun: plan.dryRun,
    blocked: null,
    setType: plan.escalate ? null : plan.setType,
    addedLabels: plan.escalate ? [] : addedLabels,
    removedLabels: plan.escalate ? [] : removedLabels,
    keptHumanLabels,
    comment: comment || null,
    commentUrl: null,
  };

  if (plan.escalate) actions.blocked = "needs_human: left in triage for a maintainer";
  else if (plan.skipped) actions.blocked = `skipped: ${plan.skipped}`;
  else if (!isProduction() && !plan.dryRun && !(await isPreviewWriteAllowed(plan.issue))) {
    actions.blocked = "not a production deployment and not triggered explicitly";
  }

  // The bot's own comment bumps `updated_at`, which makes the next sweep look at the issue again.
  // Same facts and mentions as last time means there is nothing new to say.
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([plan.facts, plan.mentions.map((mention) => mention.template)]))
    .digest("hex");
  const repeated = comment !== "" && plan.facts.length + plan.mentions.length > 0 && (await getLastAnnounced(plan.issue)) === fingerprint;
  if (repeated) actions.comment = null;

  const write = !plan.dryRun && actions.blocked === null;
  if (write) {
    // Issue Types belong to the organization. A repository without them, or without this one, keeps the rest of the write.
    if (actions.setType && !(await setIssueType(plan.issue, actions.setType).catch(() => false))) actions.setType = null;
    // Labels are created on first use, with their color and description. An existing label is never edited.
    for (const label of actions.addedLabels) {
      const style = labelStyle(config, label);
      if (style) await ensureLabel(plan.issue, label, style.color, style.description).catch(() => undefined);
    }
    await addLabels(plan.issue, actions.addedLabels);
    for (const label of actions.removedLabels) await removeLabel(plan.issue, label);
    if (actions.comment) {
      actions.commentUrl = await addComment(plan.issue, actions.comment);
      await setLastAnnounced(plan.issue, fingerprint);
    }
    for (const marker of plan.once ?? []) await markOnce(plan.issue, marker);
  } else {
    console.log(`[tia] ${plan.dryRun ? "dry-run" : "blocked"} ${plan.issue.owner}/${plan.issue.repo}#${plan.issue.issueNumber}`, JSON.stringify(actions));
  }

  await recordDecision({
    at: new Date().toISOString(),
    repo: `${plan.issue.owner}/${plan.issue.repo}`,
    issueNumber: plan.issue.issueNumber,
    step: "apply",
    answers: null,
    actions,
    dryRun: !write,
    runId: plan.runId,
  });

  return actions;
}
