import { kebabCase } from "../../config";
import { fixedQuestions } from "../jev/questions";
import type { FixedCandidate, TriageContext } from "../context";
import { getTimeline, listReleases, searchIssues, type Release } from "../github";
import { ask, clip, RECENT_COMMENTS } from "../jev";
import type { PlanPatch } from "../plan";
import { issueState } from "./classify";

const MAX_CANDIDATES = 8;

/** `* **SelectMenu:** description ([#123](...))`. A scope can list several areas separated by `/`. */
const CHANGELOG_ENTRY = /^[*-]\s+\*\*([^:*]+):\*\*\s+(.+)$/;

export function changelogEntries(release: Release): { scopes: string[]; text: string; pr: number | null }[] {
  const entries: { scopes: string[]; text: string; pr: number | null }[] = [];
  for (const line of (release.body ?? "").split("\n")) {
    const match = CHANGELOG_ENTRY.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    const pr = /\[#(\d+)\]/.exec(match[2])?.[1];
    entries.push({
      scopes: match[1].split("/").map((scope) => kebabCase(scope.trim())),
      text: match[2].replace(/\s*\(\[[0-9a-f]{7}\]\([^)]*\)\)\s*$/, ""),
      pr: pr ? Number(pr) : null,
    });
  }
  return entries;
}

function referencingSummary(title: string, release: string | null): string {
  return `Merged pull request that references this issue${release ? `, released in ${release}` : ", not released yet"}: ${title}`;
}

function releaseContaining(releases: Release[], pr: number): string | null {
  const found = releases.find((release) => (release.body ?? "").includes(`#${pr}]`) || (release.body ?? "").includes(`#${pr})`));
  return found?.tag_name ?? null;
}

/** Deterministic pass: merged PRs referencing the issue, plus changelog entries whose scope is one of its areas. */
export async function findFixedCandidates(context: TriageContext, areaSlugs: string[], signal?: AbortSignal): Promise<FixedCandidate[]> {
  const { issue } = context;
  if (context.fixture) return context.fixture.fixedCandidates;

  const created = Date.parse(issue.createdAt);
  const [timeline, referencing, allReleases] = await Promise.all([
    getTimeline(issue, signal),
    searchIssues(`repo:${issue.owner}/${issue.repo} is:pr is:merged ${issue.issueNumber} in:body`, 10, signal),
    listReleases(issue, signal),
  ]);
  const releases = allReleases.filter((release) => release.published_at && Date.parse(release.published_at) > created);
  const candidates = new Map<string, FixedCandidate>();

  for (const event of timeline) {
    const source = event.source?.issue;
    const mergedAt = source?.pull_request?.merged_at;
    if (event.event !== "cross-referenced" || !source || !mergedAt || Date.parse(mergedAt) < created) continue;
    candidates.set(`#${source.number}`, {
      id: `#${source.number}`,
      summary: referencingSummary(source.title, releaseContaining(releases, source.number)),
      url: source.html_url,
      release: releaseContaining(releases, source.number),
    });
  }

  const reference = new RegExp(`#${issue.issueNumber}\\b`);
  for (const pr of referencing) {
    if (!reference.test(pr.body ?? "") || candidates.has(`#${pr.number}`)) continue;
    candidates.set(`#${pr.number}`, {
      id: `#${pr.number}`,
      summary: referencingSummary(pr.title, releaseContaining(releases, pr.number)),
      url: pr.html_url,
      release: releaseContaining(releases, pr.number),
    });
  }

  const scopes = areaSlugs;
  for (const release of releases) {
    for (const entry of changelogEntries(release)) {
      if (!entry.scopes.some((scope) => scopes.includes(scope))) continue;
      const id = entry.pr ? `#${entry.pr}` : `${release.tag_name}:${entry.text.slice(0, 40)}`;
      if (candidates.has(id)) continue;
      candidates.set(id, {
        id,
        summary: `${release.tag_name} changelog: ${clip(entry.text, 200)}`,
        url: release.html_url,
        release: release.tag_name,
      });
    }
  }

  return [...candidates.values()].slice(0, MAX_CANDIDATES);
}

/** Areas found in this run, plus the ones already labeled on the issue. */
export function knownAreas(context: TriageContext, planned: readonly string[]): string[] {
  const labeled = context.areas.filter((area) => area.label !== null && context.issue.labels.includes(area.label)).map((area) => area.slug);
  return [...new Set([...planned, ...labeled])];
}

export interface FixedOutcome {
  answers: unknown;
  candidates: FixedCandidate[];
  fixedBy: FixedCandidate | null;
  patch: PlanPatch;
}

export async function checkFixedInRelease(
  context: TriageContext,
  areaSlugs: string[],
  signal?: AbortSignal,
): Promise<FixedOutcome> {
  const { config, issue } = context;
  const candidates = await findFixedCandidates(context, areaSlugs, signal);
  if (candidates.length === 0) return { answers: null, candidates, fixedBy: null, patch: {} };

  const answers = await ask(
    fixedQuestions(candidates),
    { issue: issueState(context, RECENT_COMMENTS), candidates: candidates.map(({ id, summary, release }) => ({ id, summary, release })) },
    signal,
  );
  const fixedBy = candidates.find((candidate) => candidate.id === answers.fixed_by.choice) ?? null;
  if (fixedBy === null) return { answers, candidates, fixedBy: null, patch: {} };

  // A merged fix that no release carries yet. There is nothing for the reporter to verify, so the
  // issue keeps its labels and only learns that the fix exists. The release pass does the rest.
  if (fixedBy.release === null) {
    if (answers.is_addressed.probability < config.thresholds.is_fixed) return { answers, candidates, fixedBy: null, patch: {} };
    return { answers, candidates, fixedBy, patch: { facts: [`A fix was merged in ${fixedBy.id}. It is not in a release yet.`] } };
  }

  if (answers.is_fixed.probability < config.thresholds.is_fixed) return { answers, candidates, fixedBy: null, patch: {} };

  const evidence = `This looks fixed by ${fixedBy.id} in ${fixedBy.release}.`;

  return {
    answers,
    candidates,
    fixedBy,
    patch: {
      addLabels: issue.labels.includes("needs verification") ? [] : ["needs verification"],
      removeLabels: context.intakeLabels,
      facts: [`${evidence} Ask the reporter to confirm on the latest version.`],
    },
  };
}
