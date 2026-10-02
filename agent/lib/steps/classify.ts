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
    existingLabels: issue.labels,
    comments: clipComments(issue.comments, maxComments).map((comment) => ({
      author: comment.author,
      authorAssociation: comment.authorAssociation,
      isReporter: comment.author === issue.author,
      body: comment.body,
    })),
  };
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

  // What the issue already carries wins. Below the threshold the kind is unknown, and the steps for reports do not run on a guess.
  const chosen = choiceConfidence(answers.type) >= t.labels ? context.kinds.find((candidate) => candidate.name === answers.type.choice) : null;
  const kind = kindOf(issue, context.kinds) ?? chosen ?? null;
  const type = kind?.type ?? kind?.name ?? issue.type;
  const report = kind?.report === true;
  const patch: PlanPatch = { addLabels: [], removeLabels: [], facts: [], mentions: [] };
  const labels = patch.addLabels ?? [];
  const facts = patch.facts ?? [];
  const mentions = patch.mentions ?? [];
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
    if (!issue.type && kind.type) patch.setType = kind.type;
    labels.push(...kind.labels);
  }

  // A decision already on the issue is not announced twice: re-evaluations stay silent about it.
  const has = (label: string) => issue.labels.includes(label);

  if (has("question")) {
    decided = true;
  } else if (isEnabled(config, "question") && answers.is_question.probability >= t.labels) {
    labels.push("question");
    mentions.push({ template: "convert_to_discussion", detail: summary.trim() });
    facts.push(`This reads as a usage question. A Q&A discussion is a better place for it${config.help ? `, and ${config.help} may already answer it` : ""}. A maintainer may convert it.`);
    decided = true;
  } else {
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
  if (decided) patch.removeLabels = context.intakeLabels;

  return { answers, patch, next, type, report };
}
