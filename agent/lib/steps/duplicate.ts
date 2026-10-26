import { duplicateQuestions } from "../jev/questions";
import type { SimilarCandidate, TriageContext } from "../context";
import { searchIssues, type RepoRef } from "../github";
import { ask, choiceConfidence, clip, RECENT_COMMENTS } from "../jev";
import type { PlanPatch } from "../plan";
import { issueState } from "./classify";

const STOP_WORDS = new Set(["the", "and", "for", "with", "when", "not", "does", "doesn", "from", "that", "this", "bug", "issue", "error", "using", "after", "work", "working"]);

export function keywords(title: string, max = 6): string[] {
  return title
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word.toLowerCase()))
    .slice(0, max);
}

/** Top similar issues, open and closed, from GitHub search. */
export async function findSimilarIssues(
  repo: RepoRef,
  title: string,
  exclude: number | null,
  limit: number,
  signal?: AbortSignal,
): Promise<SimilarCandidate[]> {
  const words = keywords(title);
  if (words.length === 0) return [];
  const seen = new Map<number, SimilarCandidate>();
  // Narrow query first, then a looser one to fill the list.
  for (const terms of [words, words.slice(0, 3)]) {
    const items = await searchIssues(`repo:${repo.owner}/${repo.repo} is:issue ${terms.join(" ")}`, limit * 2, signal);
    for (const item of items) {
      // An issue can only duplicate one opened before it. Two reports opened together would
      // otherwise each be labeled a duplicate of the other.
      if ((exclude !== null && item.number >= exclude) || seen.has(item.number)) continue;
      seen.set(item.number, {
        number: item.number,
        title: item.title,
        state: item.state,
        url: item.html_url,
        body: clip(item.body ?? "", 1_000),
      });
    }
    if (seen.size >= limit) break;
  }
  return [...seen.values()].slice(0, limit);
}

export interface DuplicateOutcome {
  answers: unknown;
  candidates: SimilarCandidate[];
  duplicateOf: SimilarCandidate | null;
  patch: PlanPatch;
}

export async function checkDuplicate(context: TriageContext, signal?: AbortSignal): Promise<DuplicateOutcome> {
  const { config, issue } = context;
  const candidates = context.fixture?.similar ?? (await findSimilarIssues(issue, issue.title, issue.issueNumber, 8, signal));
  if (candidates.length === 0) return { answers: null, candidates, duplicateOf: null, patch: {} };

  const answers = await ask(
    duplicateQuestions(candidates),
    // Two reports are compared on what they describe, not on their threads.
    { issue: issueState(context, RECENT_COMMENTS), candidates: candidates.map(({ number, title, state, body }) => ({ number, title, state, body })) },
    signal,
  );

  const duplicateOf = candidates.find((candidate) => `#${candidate.number}` === answers.duplicate_of.choice) ?? null;
  const confident =
    duplicateOf !== null &&
    answers.is_duplicate.probability >= config.thresholds.duplicate &&
    choiceConfidence(answers.duplicate_of) >= config.thresholds.duplicate;

  // Matching a closed issue is not a duplicate to close: the problem is being raised again, and the
  // issue is triaged on its own. Telling the reporter about a closed issue gives them nothing to do.
  if (!confident || !duplicateOf || duplicateOf.state !== "open") return { answers, candidates, duplicateOf: null, patch: {} };

  return {
    answers,
    candidates,
    duplicateOf,
    patch: {
      addLabels: issue.labels.includes("duplicate") ? [] : ["duplicate"],
      removeLabels: context.intakeLabels,
      supersedesReproduction: true,
      mentions: [{ template: "close_duplicate", detail: `See #${duplicateOf.number}.` }],
      facts: [`This looks like a duplicate of #${duplicateOf.number}. Link it.`],
    },
  };
}
