import { z } from "zod";

import type { RepoConfig } from "../../config";
import type { TriageContext } from "../context";
import { isBot } from "../github";
import { sectionOf, type ReproductionSettings } from "../issue-forms";
import type { PlanPatch } from "../plan";
import { isMarked } from "../store";

const LINK_PATTERN = /https?:\/\/[^\s)>\]"'`]+/gi;

export interface ReproductionLink {
  url: string;
  kind: "stackblitz" | "codesandbox" | "github" | "playground";
  /** The unmodified starter from the repository's issue form. */
  blankTemplate: boolean;
}

function parseRepository(segments: string[]): { owner: string; repo: string } | null {
  const [owner, repo] = segments;
  if (!owner || !repo) return null;
  return { owner, repo: repo.replace(/\.git$/, "") };
}

/** First path segments on github.com that are not an account. */
const NOT_ACCOUNTS = new Set([
  "user-attachments",
  "orgs",
  "apps",
  "marketplace",
  "sponsors",
  "settings",
  "topics",
  "collections",
  "features",
  "enterprise",
  "notifications",
  "search",
  "explore",
  "login",
  "join",
  "about",
  "pricing",
  "security",
]);

/** Repositories that show up as context in a report: the repo itself and its upstreams. */
function contextRepositories(config: RepoConfig): Set<string> {
  return new Set([`${config.owner}/${config.repo}`, ...config.upstreams].map((slug) => slug.toLowerCase()));
}

export function extractReproductionLinks(text: string, config: RepoConfig, settings: ReproductionSettings): ReproductionLink[] {
  const ignored = contextRepositories(config);
  const blank = settings.blank.map((entry) => entry.toLowerCase());
  const links: ReproductionLink[] = [];
  const push = (url: URL, kind: ReproductionLink["kind"]) => {
    const href = url.href.toLowerCase();
    const bare = href.replace(/[#?].*$/, "").replace(/\/+$/, "");
    // A sandbox starter is recognized by its id. A playground is blank when the link carries no state.
    const blankTemplate =
      kind === "playground"
        ? href.replace(/\/+$/, "") === bare && blank.some((entry) => entry.replace(/\/+$/, "") === bare)
        : blank.some((entry) => href.includes(entry));
    links.push({ url: url.href, kind, blankTemplate });
  };
  for (const match of text.matchAll(LINK_PATTERN)) {
    // Reporters paste broken links. One that does not parse is not a reproduction.
    const url = URL.parse(match[0].replace(/[.,;]+$/, ""));
    if (!url) continue;
    const segments = url.pathname.split("/").filter(Boolean);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "stackblitz.com") push(url, "stackblitz");
    else if (host === "codesandbox.io") push(url, "codesandbox");
    // A host the repo's issue form points reporters to, such as its own playground.
    else if (settings.hosts.includes(host)) push(url, "playground"); else if (host === "github.com") {
      const repository = parseRepository(segments);
      const reserved = ["issues", "pull", "blob", "commit", "discussions", "releases"];
      // Links to issues or to files are context, not reproductions.
      if (!repository || (segments[2] && reserved.includes(segments[2]))) continue;
      // github.com/user-attachments/assets/<id> is a file a reporter dropped on the issue, and it
      // parses as the repository "user-attachments/assets". The rest are site paths, not accounts.
      if (NOT_ACCOUNTS.has(repository.owner.toLowerCase())) continue;
      if (ignored.has(`${repository.owner}/${repository.repo}`.toLowerCase())) continue;
      push(url, "github");
    }
  }
  return links.filter((link, index) => links.findIndex((other) => other.url === link.url) === index);
}

const latestSchema = z.object({ version: z.string() });

export async function latestPackageVersion(name: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, { signal });
  if (!response.ok) throw new Error(`npm registry ${response.status}`);
  return latestSchema.parse(await response.json()).version;
}

/**
 * Whether a retest is worth asking for: a minor or major behind, not a patch. Bug fixes ship in
 * patches, so "you are on 4.11.0, latest is 4.11.1" is noise on almost every report.
 */
export function isBehind(version: string, latest: string): boolean {
  const parse = (value: string) => value.split("-")[0]?.split(".").map(Number) ?? [];
  const [a, b] = [parse(version), parse(latest)];
  for (let i = 0; i < 2; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

export interface ReproductionOutcome {
  links: ReproductionLink[];
  valid: ReproductionLink | null;
  latestVersion: string | null;
  patch: PlanPatch;
}

/**
 * Nothing is fetched. Sandboxes put bot challenges in front of every link, real or not, so a fetch
 * says nothing about the reproduction. A link is taken as given, unless it is the bare starter.
 */
export async function validateReproduction(context: TriageContext, signal?: AbortSignal): Promise<ReproductionOutcome> {
  const { config, issue, fixture, reproduction: settings } = context;
  // The form field comes first. Reporters also paste links in the description or in later comments.
  const field = sectionOf(issue.body, settings.reproductionHeading) ?? "";
  const reported = sectionOf(issue.body, settings.versionHeading)?.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0] ?? null;
  const text = [field, issue.body, ...issue.comments.filter((c) => c.author === issue.author).map((c) => c.body)].join("\n");

  const latestVersion = fixture?.latestVersion ?? (config.package ? await latestPackageVersion(config.package.name, signal) : null);
  const links = extractReproductionLinks(text, config, settings);
  const valid = links.find((link) => !link.blankTemplate) ?? null;
  // Someone else can reproduce a report the reporter could not. Their link is not the reporter's to be thanked for.
  const helper = valid
    ? null
    : issue.comments.findLast(
        (comment) =>
          comment.author !== issue.author &&
          !isBot(comment.author, comment.authorType) &&
          extractReproductionLinks(comment.body, config, settings).some((link) => !link.blankTemplate),
      );
  const patch: PlanPatch = {};

  if (links.length > 0 && !valid && !helper) {
    patch.addLabels = issue.labels.includes("needs reproduction") ? [] : ["needs reproduction"];
    patch.facts = [`The reproduction is the unmodified starter template: ${links.map((link) => link.url).join(", ")}.`, "REPRODUCTION_REQUEST"];
  } else if (issue.labels.includes("needs reproduction")) {
    // The label was waiting for this. Written steps count as much as a link, so no link is not a reason to keep it.
    patch.removeLabels = ["needs reproduction"];
    patch.facts = [`Thank @${helper?.author ?? issue.author} for the reproduction.`];
  }
  if (valid && valid.kind !== "playground" && reported && latestVersion && isBehind(reported, latestVersion)) {
    // Only a sandbox or a repository pins a version. The repository's own playground and docs run its current release.
    // Asked once. The sweep would otherwise repeat it on every run.
    if (config.package && !(await isMarked(issue, "retest-on-latest"))) {
      patch.facts = [...(patch.facts ?? []), "RETEST_REQUEST"];
      patch.retest = { name: config.package.name, version: reported, latest: latestVersion };
      patch.once = ["retest-on-latest"];
    }
  }

  return { links, valid, latestVersion, patch };
}
