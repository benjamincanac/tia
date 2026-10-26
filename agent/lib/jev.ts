import { env } from "../config";
import type { Experimental_DecisionQuestion as Question, Experimental_DecisionState as State } from "ai";
import { decide } from "eve/ai";

/** Resolved through AI Gateway. */
export function jevModel(): string {
  return env("JEV_MODEL") ?? "typesafe-ai/jev";
}

export async function ask<const Q extends Record<string, Question>>(
  questions: Q,
  state: State,
  abortSignal?: AbortSignal,
) {
  const result = await decide({ model: jevModel(), state, questions, abortSignal });
  return result.answers;
}

interface ChoiceAnswer<C extends string> {
  choice: C;
  probabilities?: Record<C, number>;
}

/** Probability of the selected option. Providers without a distribution count as certain. */
export function choiceConfidence<C extends string>(answer: ChoiceAnswer<C>): number {
  return answer.probabilities?.[answer.choice] ?? 1;
}

const MAX_BODY = 8_000;
const MAX_COMMENT = 1_500;
/** Maintainers and contributors write the diagnosis, and it rarely fits in a reporter's budget. */
const MAX_INFORMED_COMMENT = 4_000;
const INFORMED = ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"];
const MAX_COMMENTS = 30;
/**
 * What a step gets when it does not read the thread, only the report: the last few comments, in
 * case one of them corrects the description. The whole thread is thirty comments of evidence a
 * comparison never uses, sent again at every step.
 */
export const RECENT_COMMENTS = 5;

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

export function clipBody(text: string): string {
  return clip(text, MAX_BODY);
}

export function clipComments<T extends { body: string; authorAssociation?: string }>(comments: readonly T[], max = MAX_COMMENTS): T[] {
  // `slice(-0)` is the whole array, so a budget of none is answered before it.
  const kept = max <= 0 ? [] : comments.slice(-max);
  return kept.map((comment) => ({ ...comment, body: clip(comment.body, INFORMED.includes(comment.authorAssociation ?? "") ? MAX_INFORMED_COMMENT : MAX_COMMENT) }));
}
