import { isEnabled, upstreamLabel } from "../../config";
import {
  classifyQuestions,
  areaQuestionId,
  areaQuestions,
  kindQuestion,
  upstreamQuestion,
} from "../jev/questions";
import { kindOf, sectionOf } from "../issue-forms";
import type { TriageContext } from "../context";
import { ask, choiceConfidence, clipBody, clipComments } from "../jev";
import { isManagedLabel } from "../labels";
import type { PlanPatch } from "../plan";
import { markOnce } from "../store";

export type NextStep =
  | "validate_reproduction"
  | "track_upstream"
  | "check_fixed_in_release"
  | "check_duplicate";

export interface ClassifyOutcome {
  answers: unknown;
  patch: PlanPatch;
  next: NextStep[];
  type: string | null;
  /** The kind asks for a reproduction: something is broken, and a release can fix it. */
  report: boolean;
}

/** `maxComments` is how much of the thread the step reads. It defaults to all of it. */
export function issueState(context: TriageContext, maxComments?: number) {
  const { issue } = context;
  return {
    title: issue.title,
    body: clipBody(issue.body),
    authorAssociation: issue.authorAssociation,
    // What the reporter's form applied is a claim the questions are here to check: one of tia's labels, or the label of a kind. Shown as a fact, it tilts the answers toward itself.
    existingLabels: issue.labels.filter(
      (label) => !(context.reporterLabels.has(label) && (isManagedLabel(label) || isKindLabel(context, label))),
    ),
    comments: clipComments(issue.comments, maxComments).map((comment) => ({
      author: comment.author,
      authorAssociation: comment.authorAssociation,
      isReporter: comment.author === issue.author,
      body: comment.body,
    })),
  };
}

/** A label a kind applies and the intake does not: several forms share the intake labels, so they say nothing of the kind. */
function isKindLabel(context: TriageContext, label: string): boolean {
  return !context.intakeLabels.includes(label) && context.kinds.some((kind) => kind.labels.includes(label));
}

export async function classify(context: TriageContext, signal?: AbortSignal): Promise<ClassifyOutcome> {
  const { config, issue, areas } = context;
  const t = config.thresholds;

  const answers = await ask(
    {
      ...classifyQuestions,
      type: kindQuestion(context.kinds),
      upstream: upstreamQuestion(config.upstreams),
      ...areaQuestions(areas),
    },
    issueState(context),
    signal,
  );

  // Below the threshold the kind is unknown, and the steps for reports do not run on a guess.
  const chosen = choiceConfidence(answers.type) >= t.labels ? context.kinds.find((candidate) => candidate.name === answers.type.choice) : null;
  // What a maintainer or tia marked on the issue wins. What the reporter's form marked is a claim, and a confident answer replaces it.
  const marked = kindOf(issue, context.kinds);
  const byType = marked !== null && marked.type !== null && marked.type === issue.type;
  const claimed = marked !== null && (byType ? context.reporterType : marked.labels.some((label) => context.reporterLabels.has(label)));
  // A kind without an Issue Type cannot replace one that has it: the type would stay on the issue and contradict the labels.
  const replacement = byType && !chosen?.type ? null : chosen;
  const kind = (claimed ? (replacement ?? marked) : (marked ?? chosen)) ?? null;
  const type = kind?.type ?? kind?.name ?? issue.type;
  const report = kind?.report === true;
  const patch: PlanPatch = { addLabels: [], removeLabels: [], facts: [], mentions: [] };
  const labels = patch.addLabels ?? [];
  const facts = patch.facts ?? [];
  const mentions = patch.mentions ?? [];
  const replaced: string[] = [];
  const next: NextStep[] = [];
  let decided = false;

  const summary = answers.is_english.probability < 0.5 ? ` The issue is not written in English: "${issue.title}".` : "";

  if (answers.is_security.probability >= t.labels) {
    return {
      answers,
      type,
      report,
      next: [],
      patch: {
        security: true,
        mentions: [{ template: "security", detail: `Publicly disclosed security report.${summary}` }],
        facts: [
          `Ask the author to report it privately${config.securityPolicy ? ` following ${config.securityPolicy}` : " through the repository's security policy"}. Do not discuss the details.`,
        ],
      },
    };
  }

  if (answers.needs_human.probability >= t.needs_human) {
    return { answers, type, report, next: [], patch: { escalate: true } };
  }

  // The kind is marked the way the repository's form marks it: an Issue Type, labels, or both.
  if (isEnabled(config, "type") && kind) {
    if (kind.type && (!issue.type || (context.reporterType && kind.type !== issue.type))) patch.setType = kind.type;
    labels.push(...kind.labels);
    // The labels of the kind the reporter picked go with it.
    if (marked && marked !== kind) replaced.push(...marked.labels.filter((label) => isKindLabel(context, label) && !kind.labels.includes(label)));
  }

  // A decision already on the issue is not announced twice: re-evaluations stay silent about it.
  const has = (label: string) => issue.labels.includes(label);

  // A `question` the reporter's form applied is not a decision. It is checked like any other issue, and the label is never added twice.
  // A report often ends on a question. When the kind is confidently one that asks for a reproduction, the report wins.
  if (has("question") && !context.reporterLabels.has("question")) {
    decided = true;
  } else if (isEnabled(config, "question") && answers.is_question.probability >= t.labels && !chosen?.report) {
    labels.push("question");
    mentions.push({ template: "convert_to_discussion", detail: summary.trim() });
    facts.push(`This reads as a usage question. A Q&A discussion is a better place for it${config.help ? `, and ${config.help} may already answer it` : ""}. A maintainer may convert it.`);
    decided = true;
  } else {
    // The reporter's form said question and the issue is confidently another kind: the label goes, like the label of a kind would.
    if (has("question") && kind) replaced.push("question");

    const upstream = answers.upstream.choice;
    if (isEnabled(config, "upstream") && upstream !== "none" && choiceConfidence(answers.upstream) >= t.labels) {
      if (!has(upstreamLabel(upstream))) {
        labels.push(upstreamLabel(upstream));
        next.push("track_upstream");
      }
      decided = true;
    }

    // A resolved thread wins over everything below: nobody needs a reproduction for a solved problem.
    const resolved = has("answered") || (isEnabled(config, "answered") && answers.is_answered.probability >= t.answered);
    if (resolved) {
      if (!has("answered")) {
        labels.push("answered");
        mentions.push({ template: "close_answered", detail: summary.trim() });
      }
      decided = true;
    }

    // Asking for a reproduction ends the run. "Please reproduce" next to "this is fixed" or
    // "this is a duplicate" in the same comment would contradict itself.
    let waitsForReproduction = false;
    if (!resolved && kind?.report && isEnabled(config, "reproduction")) {
      if (answers.has_reproduction.probability < t.has_reproduction) {
        waitsForReproduction = true;
        if (!has("needs reproduction")) {
          labels.push("needs reproduction");
          facts.push("REPRODUCTION_REQUEST");
        }
        // Not a decision: the issue stays in triage, so it is still there once the reproduction lands.
      } else {
        next.push("validate_reproduction");
      }
    }

    // The form asks for a version and the report has none. Asked once, in the same comment as
    // whatever else the run says: the reporter may answer in a comment, which the body never shows.
    const versionHeading = context.reproduction.versionHeading;
    const reported = sectionOf(issue.body, versionHeading)?.match(/\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?/)?.[0] ?? null;
    if (!resolved && kind?.report && isEnabled(config, "reproduction") && versionHeading && !reported) {
      const first = context.dryRun ? true : await markOnce(issue, "version-request");
      if (first) facts.push(`Ask which version of ${config.package?.name ?? "the project"} they are using.`);
    }

    // Not a decision either: a regression is urgent, not triaged. The maintainers are told now, and the issue stays where it is.
    if (!resolved && kind?.report && isEnabled(config, "regression") && !has("regression") && answers.is_regression.probability >= t.labels) {
      labels.push("regression");
      mentions.push({ template: "regression", detail: `${reported ? `Reported on ${reported}.` : ""}${summary}`.trim() });
    }

    if (!resolved && !waitsForReproduction && isEnabled(config, "fixed") && kind?.report && !has("needs verification")) {
      next.push("check_fixed_in_release");
    }
    // Still checked without a reproduction: a confident duplicate replaces the request, see `supersedesReproduction`.
    if (!resolved && isEnabled(config, "duplicate") && !has("duplicate")) next.push("check_duplicate");

    if (!resolved && !waitsForReproduction && isEnabled(config, "breaking") && config.nextMajor && answers.needs_breaking_change.probability >= t.labels) {
      labels.push(config.nextMajor);
      decided = true;
    }
  }

  if (isEnabled(config, "area")) {
    const byId = answers as Record<string, { type: string; probability?: number }>;
    const found: string[] = [];
    patch.areas = found;
    for (const area of areas) {
      const probability = byId[areaQuestionId(area)]?.probability ?? 0;
      if (probability < t.labels) continue;
      found.push(area.slug);
      if (area.label) labels.push(area.label);
    }
  }

  patch.addLabels = labels.filter((label) => !issue.labels.includes(label));
  patch.removeLabels = [...replaced, ...(decided ? context.intakeLabels : [])];

  return { answers, patch, next, type, report };
}
