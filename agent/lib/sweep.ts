import { isEnabled, type RepoConfig } from "../config";
import { getTimeline, listOpenIssues, listReleases, loadRepoConfig, type Issue, type TimelineEvent } from "./github";
import { kindOf, loadIntakeLabels, loadIssueKinds, type IssueKind } from "./issue-forms";
import { openSetupPullRequest } from "./setup";
import { closedUpstreamPairs } from "./steps/upstream";
import { alreadyEvaluated, enqueue, markEvaluated, getClassified, getLastSeenRelease, setLastSeenRelease, takeRepoPasses, trackUpstreamPair, type Classified, type QueueItem } from "./store";

const DAY_MS = 24 * 60 * 60_000;
/** Labels tia applies that wait on someone. The intake labels of the repository are swept too. */
const SWEEP_LABELS = ["needs reproduction", "needs verification"];

/** Sessions started per minute by `schedules/dispatch_queue`. */
export const DISPATCH_BATCH = 5;

/**
 * A release re-opens one question and one only: is this fixed. It is worth asking about an open
 * report of the repository's own, and not about an issue that already waits on someone.
 * What classification remembered wins: it also knows the issues a maintainer took over, and the
 * kind of an issue the repository does not mark. An issue tia never classified is judged on its marks.
 */
export function releaseCheckApplies(
  config: RepoConfig,
  issue: Pick<Issue, "labels" | "type">,
  kinds: readonly IssueKind[],
  classified: Classified | null,
): boolean {
  if (!isEnabled(config, "fixed")) return false;
  if (issue.labels.includes("needs reproduction") || issue.labels.includes("needs verification")) return false;
  return classified?.releaseCheck ?? kindOf(issue, kinds)?.report === true;
}

/** When the label was last applied. A wait is counted from there. */
export function labeledAt(timeline: readonly TimelineEvent[], label: string): string | undefined {
  return timeline.findLast((event) => event.event === "labeled" && event.label?.name === label)?.created_at;
}

/**
 * An issue that waits on someone is measured from its label, the clock `sweep_issue` applies its
 * rules on. `updatedAt` moves with every comment, so one from a bystander would push the follow-up back.
 * A timeline that cannot be read must not stop the sweep of the repository, so it counts from `updatedAt` too.
 */
async function thresholdsCrossed(issue: Issue, config: RepoConfig): Promise<number> {
  const waiting = SWEEP_LABELS.find((label) => issue.labels.includes(label));
  const since = (waiting && labeledAt(await getTimeline(issue).catch(() => []), waiting)) || issue.updatedAt;
  const days = (Date.now() - Date.parse(since)) / DAY_MS;
  const { followUpDays, mentionDays, staleDays } = config.sweep;
  return [followUpDays, mentionDays, staleDays].filter((threshold) => days >= threshold).length;
}

export interface SweepSummary {
  repo: string;
  queued: number;
  unchanged: number;
  /** Left for the next sweep by `limit`. */
  deferred: number;
  newRelease: string | null;
  upstreamClosed: number;
}

/**
 * The issues a sweep considers: the repository's intake labels, plus the ones tia waits on.
 * A repository whose issue forms share no label has no intake label at all, and there an open issue
 * carrying no label is what waiting for triage looks like. Where the repository does have one,
 * an unlabeled issue is the opposite: a maintainer removed the intake label, which is how a
 * decision is recorded, so it is left alone.
 */
async function listSweepable(config: RepoConfig, intakeLabels: readonly string[]): Promise<Issue[]> {
  if (intakeLabels.length) return listOpenIssues(config, [...intakeLabels, ...SWEEP_LABELS]);
  const issues = await listOpenIssues(config);
  return issues.filter((issue) => issue.labels.length === 0 || issue.labels.some((label) => SWEEP_LABELS.includes(label)));
}

/**
 * Queues every sweepable issue that changed or crossed a follow-up threshold, as a `sweep`. An
 * issue that did neither but may be affected by a release published since the last sweep is queued
 * as a `release`, which only re-checks the fix.
 */
export async function sweepRepo(config: RepoConfig, options: { limit?: number; explicit?: boolean; stagger?: boolean } = {}): Promise<SweepSummary> {
  const repo = `${config.owner}/${config.repo}`;
  const [intakeLabels, kinds] = await Promise.all([loadIntakeLabels(config), loadIssueKinds(config)]);
  const [issues, releases, lastSeen] = await Promise.all([
    listSweepable(config, intakeLabels),
    listReleases(config),
    getLastSeenRelease(repo),
  ]);

  const latest = releases.find((release) => !release.prerelease)?.tag_name ?? null;
  const newRelease = latest !== null && latest !== lastSeen ? latest : null;
  const base: Pick<QueueItem, "owner" | "repo" | "explicit"> = { owner: config.owner, repo: config.repo, explicit: options.explicit };

  // `limit` caps what is queued, not what is considered. An unchanged issue costs nothing, so it
  // must not use up the budget, or a limited sweep over a quiet backlog would queue nothing at all.
  // What is left is never fingerprinted, so the next sweep starts where this one stopped.
  const limit = options.limit ?? issues.length;
  let queued = 0;
  let unchanged = 0;
  let deferred = 0;
  for (const [index, issue] of issues.entries()) {
    if (queued >= limit) {
      deferred = issues.length - index;
      break;
    }
    // The release is deliberately not part of the fingerprint. It changes whether the issue is
    // fixed, nothing about the issue itself, so a publish must not re-triage the whole backlog.
    const fingerprint = `${issue.updatedAt}:${await thresholdsCrossed(issue, config)}`;
    const changed = !(await alreadyEvaluated(issue, fingerprint));
    // An unchanged issue is only worth a session when the release could have fixed it.
    if (!changed && !(newRelease && releaseCheckApplies(config, issue, kinds, await getClassified(issue)))) {
      unchanged++;
      continue;
    }
    // Spread over time so the queue starts a few sessions per minute.
    const delay = options.stagger === false ? 0 : Math.floor(queued / DISPATCH_BATCH) * 60_000;
    await enqueue({ ...base, issueNumber: issue.issueNumber, reason: changed ? "sweep" : "release", notBefore: Date.now() + delay });
    if (changed) await markEvaluated(issue, fingerprint);
    queued++;
  }

  const closed = await closedUpstreamPairs(repo);
  for (const pair of closed) {
    await enqueue({
      ...base,
      issueNumber: pair.issueNumber,
      reason: "upstream_closed",
      text: `${pair.upstreamUrl} is closed.`,
      notBefore: Date.now(),
    });
    await trackUpstreamPair({ ...pair, notifiedClosed: true });
  }

  if (newRelease) await setLastSeenRelease(repo, newRelease);
  return { repo, queued, unchanged, deferred, newRelease, upstreamClosed: closed.length };
}

/**
 * Runs the passes the GitHub webhooks asked for: the first sweep of a repository that just merged
 * its setup pull request, and the setup pull request of a repository that has none yet. Both are
 * what the daily schedule would otherwise do up to a day later, which is the whole of the wait
 * between installing tia and seeing it work.
 */
export async function runRepoPasses(): Promise<void> {
  for (const { repo, pass } of await takeRepoPasses()) {
    const [owner = "", name = ""] = repo.split("/");
    try {
      if (pass === "setup") {
        const result = await openSetupPullRequest({ owner, repo: name });
        if (result.status !== "configured" && result.status !== "exists") console.log(`[tia] setup ${repo}`, JSON.stringify(result));
        continue;
      }
      // The config cache still holds the miss from before the merge, so a first sweep can be a few
      // minutes late. The next pass catches it, and the daily sweep is the backstop either way.
      const config = await loadRepoConfig({ owner, repo: name });
      if (config) console.log("[tia] sweep", JSON.stringify(await sweepRepo(config)));
    } catch (error) {
      // One repository must not stop the others, nor the queue waiting behind them.
      console.error(`[tia] ${pass} pass failed on ${repo}`, error);
    }
  }
}
