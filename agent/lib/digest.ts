import type { RepoConfig } from "../config";
import { listOpenIssues, searchCount, searchIssues } from "./github";
import { loadIntakeLabels, loadIssueKinds, type IssueKind } from "./issue-forms";
import { closedUpstreamPairs } from "./steps/upstream";
import { listDecisions } from "./store";

const WEEK_MS = 7 * 24 * 60 * 60_000;

interface Link {
  number: number;
  title: string;
  url: string;
}

export interface Digest {
  repo: string;
  awaiting: { reason: string; issues: Link[] }[];
  duplicatesDetected: number;
  areaClusters: { label: string; count: number }[];
  topRequests: (Link & { thumbsUp: number })[];
  /** `untriaged` counts the open issues that still carry an intake label. `null` when the repository has none. */
  totals: { untriaged: number | null; intakeLabels: string[]; resolvedThisWeek: number };
}

/** Most upvoted open requests: the kinds that do not report something broken, found the way the repository marks them. */
async function topRequests(repo: string, kinds: readonly IssueKind[], signal?: AbortSignal) {
  const marks = kinds
    .filter((kind) => !kind.report)
    .map((kind) => (kind.type ? `type:"${kind.type}"` : kind.labels.length ? `label:${kind.labels.map((label) => `"${label}"`).join(",")}` : null))
    .filter((mark) => mark !== null);
  const found = await Promise.all([...new Set(marks)].map((mark) => searchIssues(`repo:${repo} is:issue is:open ${mark} sort:reactions-+1-desc`, 10, signal)));
  const unique = new Map(found.flat().map((item) => [item.number, item]));
  return [...unique.values()].sort((a, b) => (b.reactions?.["+1"] ?? 0) - (a.reactions?.["+1"] ?? 0)).slice(0, 10);
}

async function labeled(repo: string, label: string, signal?: AbortSignal): Promise<Link[]> {
  const items = await searchIssues(`repo:${repo} is:issue is:open label:"${label}"`, 25, signal);
  return items.map((item) => ({ number: item.number, title: item.title, url: item.html_url }));
}

export async function buildDigest(config: RepoConfig, signal?: AbortSignal): Promise<Digest> {
  const repo = `${config.owner}/${config.repo}`;
  const since = new Date(Date.now() - WEEK_MS).toISOString().slice(0, 10);

  const [intakeLabels, kinds] = await Promise.all([loadIntakeLabels(config, signal), loadIssueKinds(config, signal)]);
  const intake = intakeLabels.map((label) => `"${label}"`).join(",");

  const [regression, duplicate, answered, verification, question, upstreamClosed, open, requests, untriaged, resolved, decisions] =
    await Promise.all([
      labeled(repo, "regression", signal),
      labeled(repo, "duplicate", signal),
      labeled(repo, "answered", signal),
      labeled(repo, "needs verification", signal),
      labeled(repo, "question", signal),
      closedUpstreamPairs(repo, signal),
      listOpenIssues(config, [], signal),
      topRequests(repo, kinds, signal),
      intake ? searchCount(`repo:${repo} is:issue is:open label:${intake}`, signal) : null,
      searchCount(`repo:${repo} is:issue closed:>=${since}`, signal),
      listDecisions(),
    ]);

  const recent = decisions.filter((decision) => decision.repo.toLowerCase() === repo.toLowerCase() && Date.parse(decision.at) > Date.now() - WEEK_MS);
  // Latest classification per open issue. Areas come from the decision log, so no label is required.
  const openNumbers = new Set(open.map((issue) => issue.issueNumber));
  const latest = new Map<number, string[]>();
  for (const decision of decisions) {
    if (decision.step !== "classify" || decision.repo.toLowerCase() !== repo.toLowerCase() || !openNumbers.has(decision.issueNumber)) continue;
    latest.set(decision.issueNumber, (decision.actions as { areas?: string[] } | null)?.areas ?? []);
  }
  const clusters = new Map<string, number>();
  for (const areas of latest.values()) {
    for (const area of areas) clusters.set(area, (clusters.get(area) ?? 0) + 1);
  }

  return {
    repo,
    awaiting: [
      { reason: "Regressions", issues: regression },
      { reason: "Close as duplicate", issues: duplicate },
      { reason: "Close as answered", issues: answered },
      { reason: "Verify fixed", issues: verification },
      { reason: "Convert to Q&A", issues: question },
      {
        reason: "Upstream closed",
        issues: upstreamClosed.map((pair) => ({ number: pair.issueNumber, title: `${pair.upstreamRepo}#${pair.upstreamIssueNumber} closed`, url: `https://github.com/${pair.repo}/issues/${pair.issueNumber}` })),
      },
    ].filter((group) => group.issues.length > 0),
    duplicatesDetected: recent.filter((decision) => decision.step === "duplicate" && JSON.stringify(decision.actions).includes("close_duplicate")).length,
    areaClusters: [...clusters].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    topRequests: requests.map((item) => ({ number: item.number, title: item.title, url: item.html_url, thumbsUp: item.reactions?.["+1"] ?? 0 })),
    totals: { untriaged, intakeLabels, resolvedThisWeek: resolved },
  };
}

function links(items: Link[], max = 10): string {
  const lines = items.slice(0, max).map((item) => `[#${item.number}](${item.url}) ${item.title.slice(0, 70)}`);
  if (items.length > max) lines.push(`and ${items.length - max} more`);
  return lines.join("\n").slice(0, 1_024);
}

/** Discord embeds for the weekly digest. One message per repo. */
export function digestEmbeds(digest: Digest): Record<string, unknown>[] {
  const fields = digest.awaiting.map((group) => ({ name: `${group.reason} (${group.issues.length})`, value: links(group.issues) }));
  if (digest.areaClusters.length) {
    fields.push({ name: "Top clusters", value: digest.areaClusters.map((cluster) => `\`${cluster.label}\` ${cluster.count}`).join("\n") });
  }

  const embeds: Record<string, unknown>[] = [
    {
      title: `${digest.repo} weekly triage`,
      url: `https://github.com/${digest.repo}/issues`,
      description: [
        digest.totals.untriaged === null ? "" : `**${digest.totals.untriaged}** still in ${digest.totals.intakeLabels.map((label) => `\`${label}\``).join(" or ")}`,
        `**${digest.totals.resolvedThisWeek}** closed this week`,
        `**${digest.duplicatesDetected}** duplicates detected.`,
      ].filter(Boolean).join(", "),
      color: 0x00dc82,
      fields: fields.slice(0, 25),
    },
  ];
  if (digest.topRequests.length) {
    embeds.push({
      title: "Top requests by 👍",
      color: 0xa2eeef,
      description: digest.topRequests.map((item) => `${item.thumbsUp} 👍 [#${item.number}](${item.url}) ${item.title.slice(0, 70)}`).join("\n").slice(0, 4_000),
    });
  }
  return embeds;
}
