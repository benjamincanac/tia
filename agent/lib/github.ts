import { deleteTokenCacheEntry, getToken, type ConnectTokenParams } from "@vercel/connect";
import { z } from "zod";

import { listInstallations, rememberInstallation } from "./store";

import {
  CONFIG_PATH,
  env,
  githubConnector,
  parseRepoConfig,
  resolveRepoConfig,
  sourceRepo,
  toArea,
  type Area,
  type RepoConfig,
} from "../config";

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface IssueRef extends RepoRef {
  issueNumber: number;
}

/**
 * Which installation to mint a token from. The app is installed once per account, and every webhook
 * says which installation it came from, so the map builds itself. An account tia has not heard
 * from yet falls back to the connector's default installation.
 */
const installationCache = new Map<string, string>();

async function connectInstallationId(owner: string): Promise<string | undefined> {
  const key = owner.toLowerCase();
  const known = installationCache.get(key);
  if (known) return known;
  const stored = (await listInstallations())[key];
  if (stored) installationCache.set(key, stored);
  return stored;
}

function tokenParams(installationId?: string): ConnectTokenParams {
  return { subject: { type: "app" }, ...(installationId ? { installationId } : {}) };
}

/** Records the installation a webhook came from. Called before anything else reads the repository. */
export async function noteInstallation(owner: string, installationId: number | undefined): Promise<void> {
  if (installationId === undefined) return;
  const key = owner.toLowerCase();
  const id = String(installationId);
  if (installationCache.get(key) === id) return;
  installationCache.set(key, id);
  await rememberInstallation(key, id);
}

export async function githubToken(owner?: string): Promise<string> {
  // Scripts run outside Vercel and may use a personal token instead of Connect.
  const script = env("TIA_SCRIPT_TOKEN");
  if (script) return script;
  return getToken(githubConnector(), tokenParams(owner ? await connectInstallationId(owner) : undefined));
}

const REFRESH_COOLDOWN_MS = 10 * 60_000;
const lastRefresh = new Map<string, number>();

/**
 * An installation token is scoped to the repositories selected when it was minted, and Connect
 * caches it for its lifetime. Adding a repository to the installation would otherwise answer 404
 * until the cache expired or the deployment was replaced. A missing file is a 404 too, and tia
 * reads a config file from every repository it looks at, so this runs at most once per owner
 * per cooldown and returns false the rest of the time.
 */
async function forgetToken(owner?: string): Promise<boolean> {
  if (env("TIA_SCRIPT_TOKEN")) return false;
  const key = owner ?? "";
  const previous = lastRefresh.get(key) ?? 0;
  if (Date.now() - previous < REFRESH_COOLDOWN_MS) return false;
  lastRefresh.set(key, Date.now());
  deleteTokenCacheEntry(githubConnector(), tokenParams(owner ? await connectInstallationId(owner) : undefined));
  return true;
}

export class GitHubRequestError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(`GitHub ${status} on ${path}: ${body.slice(0, 300)}`);
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  accept?: string;
  owner?: string;
  signal?: AbortSignal;
}

/** Seconds to wait when GitHub asks us to slow down, or `null` when the response is not a rate limit. */
function retryAfterSeconds(response: Response): number | null {
  if (response.status !== 403 && response.status !== 429) return null;
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, 120);
  // Primary limits report a reset timestamp and a remaining count of zero.
  if (response.headers.get("x-ratelimit-remaining") !== "0") return null;
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (!Number.isFinite(reset)) return 60;
  return Math.min(Math.max(Math.ceil(reset - Date.now() / 1000), 1), 120);
}

const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * One GitHub request, retried when GitHub rate limits us. Search allows 30 requests a minute,
 * which a backlog pass reaches quickly, and it answers 403 rather than 429.
 */
async function rawRequest(path: string, options: RequestOptions = {}): Promise<Response> {
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const token = await githubToken(options.owner);
    const response = await fetch(`https://api.github.com${path}`, {
      method: options.method ?? "GET",
      headers: {
        accept: options.accept ?? "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "tia-triage",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });

    // A 404 on a repository the app was just added to means the cached token predates the change.
    if (response.status === 404 && !refreshed) {
      refreshed = true;
      if (await forgetToken(options.owner)) continue;
    }

    const wait = attempt < MAX_RATE_LIMIT_RETRIES ? retryAfterSeconds(response) : null;
    if (wait === null) return response;
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    options.signal?.throwIfAborted();
  }
}

export async function gh<T extends z.ZodType>(
  schema: T,
  path: string,
  options: RequestOptions = {},
): Promise<z.output<T>> {
  const response = await rawRequest(path, options);
  if (!response.ok) throw new GitHubRequestError(response.status, path, await response.text());
  if (response.status === 204) return schema.parse(null);
  return schema.parse(await response.json());
}

export async function ghText(path: string, options: RequestOptions = {}): Promise<string | null> {
  const response = await rawRequest(path, { ...options, accept: "application/vnd.github.raw" });
  if (response.status === 404) return null;
  if (!response.ok) throw new GitHubRequestError(response.status, path, await response.text());
  return response.text();
}

export async function graphql<T extends z.ZodType>(
  schema: T,
  query: string,
  variables: Record<string, unknown>,
  options: Pick<RequestOptions, "owner" | "signal"> = {},
): Promise<z.output<T>> {
  const envelope = z.object({
    data: z.unknown().optional(),
    errors: z.array(z.object({ message: z.string() })).optional(),
  });
  const result = await gh(envelope, "/graphql", {
    ...options,
    method: "POST",
    body: { query, variables },
  });
  if (result.errors?.length) {
    throw new Error(`GitHub GraphQL: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  return schema.parse(result.data);
}

async function paginate<T extends z.ZodType>(
  item: T,
  path: string,
  options: RequestOptions & { maxPages?: number } = {},
): Promise<z.output<T>[]> {
  const out: z.output<T>[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= (options.maxPages ?? 10); page++) {
    const batch = await gh(z.array(item), `${path}${separator}per_page=100&page=${page}`, options);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

const userSchema = z.object({ login: z.string(), type: z.string().default("User") });
const labelSchema = z.union([z.string(), z.object({ name: z.string() })]);

const issueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  html_url: z.string(),
  user: userSchema.nullable(),
  author_association: z.string().default("NONE"),
  labels: z.array(labelSchema),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable().optional(),
  comments: z.number().default(0),
  reactions: z.object({ "+1": z.number() }).partial().optional(),
  pull_request: z.unknown().optional(),
  type: z.object({ name: z.string() }).nullable().optional(),
});

const commentSchema = z.object({
  id: z.number(),
  body: z.string().nullable(),
  user: userSchema.nullable(),
  author_association: z.string().default("NONE"),
  created_at: z.string(),
});

export interface IssueComment {
  id: number;
  author: string;
  authorType: string;
  authorAssociation: string;
  body: string;
  createdAt: string;
}

export interface Issue extends IssueRef {
  title: string;
  body: string;
  state: string;
  url: string;
  author: string;
  authorType: string;
  authorAssociation: string;
  labels: string[];
  type: string | null;
  createdAt: string;
  updatedAt: string;
  thumbsUp: number;
  isPullRequest: boolean;
  comments: IssueComment[];
}

function toIssue(ref: RepoRef, raw: z.output<typeof issueSchema>, comments: IssueComment[]): Issue {
  return {
    ...ref,
    issueNumber: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state,
    url: raw.html_url,
    author: raw.user?.login ?? "ghost",
    authorType: raw.user?.type ?? "User",
    authorAssociation: raw.author_association,
    labels: raw.labels.map((label) => (typeof label === "string" ? label : label.name)),
    type: raw.type?.name ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    thumbsUp: raw.reactions?.["+1"] ?? 0,
    isPullRequest: raw.pull_request !== undefined,
    comments,
  };
}

function toComment(raw: z.output<typeof commentSchema>): IssueComment {
  return {
    id: raw.id,
    author: raw.user?.login ?? "ghost",
    authorType: raw.user?.type ?? "User",
    authorAssociation: raw.author_association,
    body: raw.body ?? "",
    createdAt: raw.created_at,
  };
}

export async function getIssue(ref: IssueRef, signal?: AbortSignal): Promise<Issue> {
  const base = `/repos/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}`;
  const raw = await gh(issueSchema, base, { owner: ref.owner, signal });
  // Comments are listed oldest first. On long threads only the last pages matter.
  const lastPage = Math.max(1, Math.ceil(raw.comments / 100));
  const pages = [lastPage - 2, lastPage - 1, lastPage].filter((page) => page >= 1);
  const batches = await Promise.all(
    pages.map((page) => gh(z.array(commentSchema), `${base}/comments?per_page=100&page=${page}`, { owner: ref.owner, signal })),
  );
  return toIssue(ref, raw, batches.flat().map(toComment));
}

/** Open issues carrying any of the given labels, without comments. */
export async function listOpenIssues(
  ref: RepoRef,
  labels: string[] = [],
  signal?: AbortSignal,
): Promise<Issue[]> {
  const seen = new Map<number, Issue>();
  const queries = labels.length ? labels : [""];
  for (const label of queries) {
    const filter = label ? `&labels=${encodeURIComponent(label)}` : "";
    const batch = await paginate(
      issueSchema,
      `/repos/${ref.owner}/${ref.repo}/issues?state=open${filter}`,
      { owner: ref.owner, signal, maxPages: 20 },
    );
    for (const raw of batch) {
      if (raw.pull_request === undefined) seen.set(raw.number, toIssue(ref, raw, []));
    }
  }
  return [...seen.values()];
}

const searchSchema = z.object({ items: z.array(issueSchema) });

/** Search has no repository in its path. The token comes from the installation of the account the query is scoped to. */
function searchOwner(query: string): string | undefined {
  return /\brepo:([\w.-]+)\//.exec(query)?.[1];
}

export async function searchIssues(query: string, limit: number, signal?: AbortSignal): Promise<z.output<typeof issueSchema>[]> {
  const result = await gh(
    searchSchema,
    `/search/issues?q=${encodeURIComponent(query)}&per_page=${Math.min(limit, 100)}`,
    { owner: searchOwner(query), signal },
  );
  return result.items;
}

export async function searchCount(query: string, signal?: AbortSignal): Promise<number> {
  const result = await gh(z.object({ total_count: z.number() }), `/search/issues?q=${encodeURIComponent(query)}&per_page=1`, { owner: searchOwner(query), signal });
  return result.total_count;
}

const installationRepositoriesSchema = z.object({
  repositories: z.array(z.object({ name: z.string(), owner: z.object({ login: z.string() }), archived: z.boolean().default(false) })),
});

/**
 * Repositories every known installation can access. A repo without a valid config file is ignored
 * later. `/installation/repositories` answers for the installation the token belongs to, so an
 * account tia has heard from is listed under its own token and the rest under the default one.
 */
export async function listInstalledRepositories(signal?: AbortSignal): Promise<RepoRef[]> {
  const owners = [undefined, ...Object.keys(await listInstallations())];
  const results = await Promise.all(
    owners.map((owner) =>
      gh(installationRepositoriesSchema, "/installation/repositories?per_page=100", { owner, signal })
        // One revoked installation must not blind the sweep to the others.
        .catch(() => ({ repositories: [] })),
    ),
  );
  const repositories = results.flatMap((result) => result.repositories);
  return repositories
    .filter((repo, index) => repositories.findIndex((other) => other.owner.login === repo.owner.login && other.name === repo.name) === index)
    .filter((repo) => !repo.archived && isAllowedOwner(repo.owner.login))
    .map((repo) => ({ owner: repo.owner.login, repo: repo.name }));
}

/** Installed repositories with a valid `.github/tia.yml`. */
export async function listEnabledRepositories(signal?: AbortSignal): Promise<RepoConfig[]> {
  // Public repos can be followed read-only before the app is installed on them.
  const extra = (env("TIA_EXTRA_REPOS") ?? "")
    .split(",")
    .map((slug) => slug.trim().split("/"))
    .filter((parts): parts is [string, string] => parts.length === 2 && Boolean(parts[0]) && Boolean(parts[1]))
    .map(([owner, repo]) => ({ owner, repo }));
  const refs = [...(await listInstalledRepositories(signal)), ...extra];
  const unique = refs.filter((ref, index) => refs.findIndex((other) => `${other.owner}/${other.repo}` === `${ref.owner}/${ref.repo}`) === index);
  const configs = await Promise.all(unique.map((ref) => loadRepoConfig(ref, signal)));
  return configs.filter((config): config is RepoConfig => config !== null);
}

const timelineEventSchema = z.object({
  event: z.string().optional(),
  created_at: z.string().optional(),
  actor: userSchema.nullable().optional(),
  label: z.object({ name: z.string() }).optional(),
  source: z
    .object({
      issue: z
        .object({
          number: z.number(),
          title: z.string(),
          html_url: z.string(),
          pull_request: z.object({ merged_at: z.string().nullable().optional() }).optional(),
          repository: z.object({ full_name: z.string() }).optional(),
        })
        .optional(),
    })
    .optional(),
});

export type TimelineEvent = z.output<typeof timelineEventSchema>;

export function getTimeline(ref: IssueRef, signal?: AbortSignal): Promise<TimelineEvent[]> {
  return paginate(
    timelineEventSchema,
    `/repos/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}/timeline`,
    { owner: ref.owner, signal, maxPages: 10 },
  );
}

const repoIdSchema = z.object({ id: z.number() });
const repoIdCache = new Map<string, number>();

/** Numeric id of a repository, cached. Lets a caller skip a metadata lookup. */
export async function repositoryId(ref: RepoRef, signal?: AbortSignal): Promise<number> {
  const key = `${ref.owner}/${ref.repo}`.toLowerCase();
  const cached = repoIdCache.get(key);
  if (cached !== undefined) return cached;
  const { id } = await gh(repoIdSchema, `/repos/${ref.owner}/${ref.repo}`, { owner: ref.owner, signal });
  repoIdCache.set(key, id);
  return id;
}

export function isBot(login: string, type: string): boolean {
  return type === "Bot" || login.endsWith("[bot]");
}

const MAX_REFERENCED_ISSUES = 10;

/**
 * Issues a pull request mentions without closing them. GitHub closes the ones behind a closing
 * keyword itself, so a run on those would only find them closed.
 */
export function referencedIssues(text: string): number[] {
  const closing = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi;
  const closed = new Set([...text.matchAll(closing)].map((match) => Number(match[1])));
  const numbers = [...text.matchAll(/(?<![\w/])#(\d+)\b/g)].map((match) => Number(match[1]));
  return [...new Set(numbers)].filter((number) => !closed.has(number)).slice(0, MAX_REFERENCED_ISSUES);
}

/** Labels currently on the issue that were applied by a human. The bot never removes those. */
export function humanAppliedLabels(timeline: TimelineEvent[]): Set<string> {
  const appliedBy = new Map<string, boolean>();
  for (const event of timeline) {
    if (!event.label) continue;
    if (event.event === "labeled") {
      appliedBy.set(event.label.name, !isBot(event.actor?.login ?? "", event.actor?.type ?? ""));
    } else if (event.event === "unlabeled") {
      appliedBy.delete(event.label.name);
    }
  }
  return new Set([...appliedBy].filter(([, human]) => human).map(([name]) => name));
}

const releaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string(),
  body: z.string().nullable(),
  published_at: z.string().nullable(),
  prerelease: z.boolean(),
  draft: z.boolean(),
});

export type Release = z.output<typeof releaseSchema>;

export async function listReleases(ref: RepoRef, signal?: AbortSignal): Promise<Release[]> {
  const releases = await gh(
    z.array(releaseSchema),
    `/repos/${ref.owner}/${ref.repo}/releases?per_page=30`,
    { owner: ref.owner, signal },
  );
  return releases.filter((release) => !release.draft);
}

const treeSchema = z.object({
  tree: z.array(z.object({ path: z.string(), type: z.string() })),
});

const repoSchema = z.object({ default_branch: z.string() });

/**
 * Names matching a single-level glob. `src/components/*.vue` yields file names without their
 * extension, `packages/*` yields directory names.
 */
export async function listGlobNames(ref: RepoRef, glob: string, signal?: AbortSignal): Promise<string[]> {
  const { default_branch } = await gh(repoSchema, `/repos/${ref.owner}/${ref.repo}`, { owner: ref.owner, signal });
  const { tree } = await gh(
    treeSchema,
    `/repos/${ref.owner}/${ref.repo}/git/trees/${default_branch}?recursive=1`,
    { owner: ref.owner, signal },
  );
  const pattern = new RegExp(
    `^${glob
      .replace(/\/+$/, "")
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*")}$`,
  );
  // `dir/*.ext` names files, a bare `dir/*` names sub-directories.
  const wanted = /\*\.[\w.]+$/.test(glob) ? "blob" : "tree";
  const names = tree
    .filter((entry) => entry.type === wanted && pattern.test(entry.path))
    .map((entry) => {
      const base = entry.path.split("/").pop() ?? "";
      return entry.type === "blob" ? base.replace(/\.[^.]+$/, "") : base;
    })
    .filter((name) => name.length > 0);
  return [...new Set(names)].sort();
}

const CACHE_TTL_MS = 5 * 60_000;
const configCache = new Map<string, { expires: number; value: RepoConfig | null }>();
const areaCache = new Map<string, { expires: number; value: Area[] }>();

/** Returns `null` when the file is missing or invalid, which disables triage for the repo. */
/**
 * A GitHub App that has to be installable on another organization is public, so anyone can install
 * it. `TIA_ALLOWED_OWNERS` lists the accounts tia answers to, and everything else is ignored as if
 * it had no config file. Unset, every installation is answered, which is what a private app wants.
 */
function isAllowedOwner(owner: string): boolean {
  const allowed = (env("TIA_ALLOWED_OWNERS") ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
  return allowed.length === 0 || allowed.includes(owner.toLowerCase());
}

export async function loadRepoConfig(ref: RepoRef, signal?: AbortSignal): Promise<RepoConfig | null> {
  const key = `${ref.owner}/${ref.repo}`.toLowerCase();
  if (!isAllowedOwner(ref.owner)) return null;
  const cached = configCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  let value: RepoConfig | null = null;
  const source = await ghText(`/repos/${ref.owner}/${ref.repo}/contents/${CONFIG_PATH}`, {
    owner: ref.owner,
    signal,
  });
  if (source !== null) {
    const parsed = parseRepoConfig(source);
    if (parsed.ok) value = resolveRepoConfig(ref.owner, ref.repo, parsed.config);
    else console.warn(`[tia] invalid ${CONFIG_PATH} in ${key}, triage disabled:\n${parsed.error}`);
  }
  configCache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
  return value;
}

/** The repo's areas, from every `areas` entry: glob matches in the source repo plus explicit names. */
export async function loadAreas(config: RepoConfig, signal?: AbortSignal): Promise<Area[]> {
  if (config.areas.length === 0) return [];
  const source = sourceRepo(config);
  const key = `${source.owner}/${source.repo}:${JSON.stringify(config.areas)}`;
  const cached = areaCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  const areas = new Map<string, Area>();
  for (const group of config.areas) {
    const names = [...group.names, ...(group.glob ? await listGlobNames(source, group.glob, signal) : [])];
    for (const name of names) {
      const area = toArea(name, group);
      const key = `${area.kind}:${area.slug}`;
      if (!areas.has(key)) areas.set(key, area);
    }
  }
  const value = [...areas.values()];
  areaCache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
  return value;
}

// Writes. Only `applyPlan` in lib/apply.ts calls these.

/** Creates a label when it does not exist yet. An existing label is never edited. */
export async function ensureLabel(ref: RepoRef, name: string, color: string, description: string): Promise<void> {
  const response = await rawRequest(`/repos/${ref.owner}/${ref.repo}/labels`, {
    owner: ref.owner,
    method: "POST",
    body: { name, color, description: description.slice(0, 100) },
  });
  // 422: it already exists.
  if (!response.ok && response.status !== 422) throw new GitHubRequestError(response.status, "labels", await response.text());
}

export async function addLabels(ref: IssueRef, labels: string[]): Promise<void> {
  if (!labels.length) return;
  await gh(z.unknown(), `/repos/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}/labels`, {
    owner: ref.owner,
    method: "POST",
    body: { labels },
  });
}

export async function removeLabel(ref: IssueRef, label: string): Promise<void> {
  const response = await rawRequest(
    `/repos/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}/labels/${encodeURIComponent(label)}`,
    { owner: ref.owner, method: "DELETE" },
  );
  if (!response.ok && response.status !== 404) {
    throw new GitHubRequestError(response.status, "labels", await response.text());
  }
}

export async function addComment(ref: IssueRef, body: string): Promise<string> {
  const created = await gh(
    z.object({ html_url: z.string() }),
    `/repos/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}/comments`,
    { owner: ref.owner, method: "POST", body: { body } },
  );
  return created.html_url;
}

/**
 * Issue Types belong to an organization. A repository owned by a user has none, and GitHub accepts
 * the field then ignores it, so the answer is read back from the response rather than assumed.
 */
export async function setIssueType(ref: IssueRef, type: string): Promise<boolean> {
  const issue = await gh(
    z.object({ type: z.object({ name: z.string() }).nullish() }),
    `/repos/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}`,
    { owner: ref.owner, method: "PATCH", body: { type } },
  );
  return issue.type?.name === type;
}

const pinnedSchema = z.object({
  repository: z.object({
    pinnedIssues: z.object({ nodes: z.array(z.object({ issue: z.object({ number: z.number() }) })) }),
  }),
});

export async function listPinnedIssues(ref: RepoRef, signal?: AbortSignal): Promise<number[]> {
  const data = await graphql(
    pinnedSchema,
    `query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) { pinnedIssues(first: 10) { nodes { issue { number } } } }
    }`,
    { owner: ref.owner, repo: ref.repo },
    { owner: ref.owner, signal },
  );
  return data.repository.pinnedIssues.nodes.map((node) => node.issue.number);
}
