import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { Redis } from "@upstash/redis";

import type { IssueRef } from "./github";
import type { TriagePlan } from "./plan";

/** One line per evaluated decision. Raw Jev answers are kept untouched for threshold tuning. */
export interface DecisionRecord {
  at: string;
  repo: string;
  issueNumber: number;
  step: string;
  answers: unknown;
  actions: unknown;
  dryRun: boolean;
  runId?: string;
}

export interface UpstreamPair {
  repo: string;
  issueNumber: number;
  upstreamRepo: string;
  upstreamIssueNumber: number;
  upstreamUrl: string;
  notifiedClosed: boolean;
}

export type QueueReason =
  | "issue"
  | "mention"
  | "comment"
  | "sweep"
  | "release"
  | "upstream_closed"
  | "manual";

export interface QueueItem extends IssueRef {
  reason: QueueReason;
  notBefore: number;
  commentId?: number;
  /** Text of the @-mention, or evidence for `upstream_closed`. */
  text?: string;
  /** Explicit trigger from the ops route: allowed to write from a preview deployment. */
  explicit?: boolean;
  /** Backfills: the run must not write, whatever the repo config says. */
  dryRun?: boolean;
  /** Failed dispatches so far. The item is dropped after `MAX_DISPATCH_ATTEMPTS`. */
  attempts?: number;
}

interface KeyValue {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  rpush(key: string, value: unknown): Promise<void>;
  lpush(key: string, value: unknown): Promise<void>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  lrange<T>(key: string, start: number, stop: number): Promise<T[]>;
  lpop<T>(key: string): Promise<T | null>;
  hset(key: string, field: string, value: unknown): Promise<void>;
  hgetall<T>(key: string): Promise<Record<string, T>>;
  hdel(key: string, field: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
}

function redisStore(redis: Redis): KeyValue {
  return {
    get: (key) => redis.get(key),
    async set(key, value, ttlSeconds) {
      if (ttlSeconds) await redis.set(key, value, { ex: ttlSeconds });
      else await redis.set(key, value);
    },
    async del(key) {
      await redis.del(key);
    },
    async rpush(key, value) {
      await redis.rpush(key, value);
    },
    async lpush(key, value) {
      await redis.lpush(key, value);
    },
    async ltrim(key, start, stop) {
      await redis.ltrim(key, start, stop);
    },
    lrange: (key, start, stop) => redis.lrange(key, start, stop),
    lpop: (key) => redis.lpop(key),
    async hset(key, field, value) {
      await redis.hset(key, { [field]: value });
    },
    async hgetall<T>(key: string) {
      return (await redis.hgetall<Record<string, T>>(key)) ?? {};
    },
    async hdel(key, field) {
      await redis.hdel(key, field);
    },
    async keys(pattern) {
      const found: string[] = [];
      let cursor: string | number = 0;
      do {
        const [next, batch]: [string | number, string[]] = await redis.scan(cursor, { match: pattern, count: 500 });
        found.push(...batch);
        cursor = next;
      } while (String(cursor) !== "0");
      return found;
    },
  };
}

/** Local development and scripts. Nothing survives the process except the JSONL export. */
function memoryStore(): KeyValue {
  const values = new Map<string, { value: unknown; expires: number }>();
  const lists = new Map<string, unknown[]>();
  const hashes = new Map<string, Map<string, unknown>>();
  return {
    async get<T>(key: string) {
      const entry = values.get(key);
      if (!entry || entry.expires < Date.now()) return null;
      return entry.value as T;
    },
    async set(key, value, ttlSeconds) {
      values.set(key, { value, expires: ttlSeconds ? Date.now() + ttlSeconds * 1_000 : Infinity });
    },
    async ltrim(key, start) {
      lists.set(key, (lists.get(key) ?? []).slice(start));
    },
    async del(key) {
      values.delete(key);
      lists.delete(key);
      hashes.delete(key);
    },
    async rpush(key, value) {
      lists.set(key, [...(lists.get(key) ?? []), value]);
    },
    async lpush(key, value) {
      lists.set(key, [value, ...(lists.get(key) ?? [])]);
    },
    async lrange<T>(key: string, start: number, stop: number) {
      const list = lists.get(key) ?? [];
      return list.slice(start, stop === -1 ? undefined : stop + 1) as T[];
    },
    async lpop<T>(key: string) {
      return ((lists.get(key) ?? []).shift() as T | undefined) ?? null;
    },
    async hset(key, field, value) {
      const hash = hashes.get(key) ?? new Map<string, unknown>();
      hash.set(field, value);
      hashes.set(key, hash);
    },
    async hgetall<T>(key: string) {
      return Object.fromEntries(hashes.get(key) ?? []) as Record<string, T>;
    },
    async hdel(key, field) {
      hashes.get(key)?.delete(field);
    },
    async keys(pattern) {
      const matcher = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
      return [...values.keys(), ...lists.keys(), ...hashes.keys()].filter((key) => matcher.test(key));
    },
  };
}

function hasRedis(): boolean {
  return Boolean(
    (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
      (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
  );
}

let instance: KeyValue | undefined;

function kv(): KeyValue {
  instance ??= hasRedis() ? redisStore(Redis.fromEnv()) : memoryStore();
  return instance;
}

const DECISIONS_KEY = "tia:decisions";
const UPSTREAM_KEY = "tia:upstream";
const INSTALLATIONS_KEY = "tia:installations";
const QUEUE_KEY = "tia:queue";
const PENDING_KEY = "tia:pending";
const MAX_DECISIONS = 5_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
// Per issue markers outlive any run, not the issue: a year after the last write they are dead weight.
const YEAR_SECONDS = 365 * 24 * 60 * 60;

function issueKey(ref: IssueRef): string {
  return `${ref.owner}/${ref.repo}#${ref.issueNumber}`.toLowerCase();
}

export async function recordDecision(record: DecisionRecord): Promise<void> {
  await kv().rpush(DECISIONS_KEY, record);
  await kv().ltrim(DECISIONS_KEY, -MAX_DECISIONS, -1);
  const path = process.env.TIA_DECISIONS_JSONL;
  if (path) {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`);
  }
}

export function listDecisions(): Promise<DecisionRecord[]> {
  return kv().lrange<DecisionRecord>(DECISIONS_KEY, 0, -1);
}

/**
 * The plan is keyed by issue, not by turn. An approval resumes the original tool call in a new turn,
 * so a turn scoped plan is gone by the time `apply_triage` runs and the write would be empty.
 * `dispatch` clears the key before each run, which is what keeps one plan per run.
 */
export function getPlan(ref: IssueRef): Promise<TriagePlan | null> {
  return kv().get<TriagePlan>(`tia:plan:${issueKey(ref)}`);
}

export async function savePlan(runId: string, plan: TriagePlan): Promise<void> {
  await kv().set(`tia:plan:${issueKey(plan.issue)}`, plan, WEEK_SECONDS);
  await kv().set(`tia:run:${runId}`, true, WEEK_SECONDS);
}

export async function clearPlan(ref: IssueRef): Promise<void> {
  await kv().del(`tia:plan:${issueKey(ref)}`);
}

/** Whether this run is a triage run, meaning a tool has already recorded a plan for it. */
export async function isTriageRun(runId: string): Promise<boolean> {
  return (await kv().get<boolean>(`tia:run:${runId}`)) === true;
}

/** A scheduled Discord run whose opening message became an approval prompt. The others leave no message behind. */
export function markPrompted(messageId: string): Promise<void> {
  return kv().set(`tia:prompted:${messageId}`, Date.now(), WEEK_SECONDS);
}

export async function wasPrompted(messageId: string): Promise<boolean> {
  return (await kv().get<number>(`tia:prompted:${messageId}`)) !== null;
}

/**
 * Which GitHub App installation covers an account. Every webhook carries it, so installing the app
 * on a new account is enough: there is nothing to configure and nothing to redeploy.
 */
export function rememberInstallation(owner: string, installationId: number | string): Promise<void> {
  return kv().hset(INSTALLATIONS_KEY, owner.toLowerCase(), String(installationId));
}

export async function listInstallations(): Promise<Record<string, string>> {
  // Redis parses a stored id back as a number, and Connect only accepts a string.
  const stored = await kv().hgetall<string | number>(INSTALLATIONS_KEY);
  return Object.fromEntries(Object.entries(stored).map(([owner, id]) => [owner, String(id)]));
}

export function trackUpstreamPair(pair: UpstreamPair): Promise<void> {
  return kv().hset(UPSTREAM_KEY, `${pair.repo}#${pair.issueNumber}`.toLowerCase(), pair);
}

export async function listUpstreamPairs(): Promise<UpstreamPair[]> {
  return Object.values(await kv().hgetall<UpstreamPair>(UPSTREAM_KEY));
}

/** Follow-ups and mentions are sent once. The marker is the memory of having sent them. */
export async function markOnce(ref: IssueRef, marker: string): Promise<boolean> {
  if (await isMarked(ref, marker)) return false;
  await kv().set(`tia:once:${issueKey(ref)}:${marker}`, Date.now(), YEAR_SECONDS);
  return true;
}

/** Read by the step that plans a once-only request. `applyPlan` sets the marker when the request is written. */
export async function isMarked(ref: IssueRef, marker: string): Promise<boolean> {
  return (await kv().get<number>(`tia:once:${issueKey(ref)}:${marker}`)) !== null;
}

/** Set by the ops trigger so an explicit run on a preview deployment may write for one hour. */
export function allowPreviewWrite(ref: IssueRef): Promise<void> {
  return kv().set(`tia:explicit:${issueKey(ref)}`, Date.now(), 60 * 60);
}

export async function isPreviewWriteAllowed(ref: IssueRef): Promise<boolean> {
  return (await kv().get<number>(`tia:explicit:${issueKey(ref)}`)) !== null;
}

/** Fingerprint of the last comment posted on an issue, so a re-evaluation never repeats itself. */
export function getLastAnnounced(ref: IssueRef): Promise<string | null> {
  return kv().get<string>(`tia:announced:${issueKey(ref)}`);
}

export function setLastAnnounced(ref: IssueRef, fingerprint: string): Promise<void> {
  return kv().set(`tia:announced:${issueKey(ref)}`, fingerprint, YEAR_SECONDS);
}

/** Backfills run the real pipeline on a repo that may have `dryRun: false`. They must not write. */
// Set when the run is dispatched and keyed by issue, since the run id is not known yet. The window is
// kept short: a real event on the same issue within it also runs dry, and the daily sweep catches up.
export function forceDryRun(ref: IssueRef): Promise<void> {
  return kv().set(`tia:dry:${issueKey(ref)}`, Date.now(), 20 * 60);
}

export async function isDryRunForced(ref: IssueRef): Promise<boolean> {
  return (await kv().get<number>(`tia:dry:${issueKey(ref)}`)) !== null;
}

/**
 * What classification found that a release does not change. A release pass runs without
 * `classify_issue`, and the issue itself only says this much when the repository marks kinds and areas.
 */
export interface Classified {
  /** A report a maintainer did not have to take over: worth re-checking for a fix when a release lands. */
  releaseCheck: boolean;
  areas: string[];
}

export function rememberClassified(ref: IssueRef, classified: Classified): Promise<void> {
  return kv().set(`tia:classified:${issueKey(ref)}`, classified, YEAR_SECONDS);
}

export function getClassified(ref: IssueRef): Promise<Classified | null> {
  return kv().get<Classified>(`tia:classified:${issueKey(ref)}`);
}

/** Skips the daily re-evaluation when the issue did not change and crossed no follow-up threshold. */
export async function alreadyEvaluated(ref: IssueRef, fingerprint: string): Promise<boolean> {
  return (await kv().get<string>(`tia:evaluated:${issueKey(ref)}`)) === fingerprint;
}

/** Written once the issue is queued, so a failed queue write leaves it for the next sweep. */
export function markEvaluated(ref: IssueRef, fingerprint: string): Promise<void> {
  return kv().set(`tia:evaluated:${issueKey(ref)}`, fingerprint, YEAR_SECONDS);
}

/** A queued run that never started was not evaluated. The next sweep queues the issue again. */
export function clearEvaluated(ref: IssueRef): Promise<void> {
  return kv().del(`tia:evaluated:${issueKey(ref)}`);
}

export type RepoPass = "setup" | "sweep";

/**
 * A repository pass a webhook noticed but must not run inline: opening a setup pull request or
 * sweeping a backlog takes far longer than a webhook may. `dispatch_queue` runs it within the minute.
 * One entry per repository, so repeated webhooks collapse into a single pass.
 */
export function requestRepoPass(repo: string, pass: RepoPass): Promise<void> {
  return kv().hset(PENDING_KEY, repo.toLowerCase(), pass);
}

/**
 * Takes the pending passes and clears them. A pass requested between the read and the delete is
 * dropped, which costs it a day at worst: the daily sweep does the same work.
 */
export async function takeRepoPasses(): Promise<{ repo: string; pass: RepoPass }[]> {
  const stored = await kv().hgetall<RepoPass>(PENDING_KEY);
  const entries = Object.entries(stored);
  if (entries.length) await kv().del(PENDING_KEY);
  return entries.map(([repo, pass]) => ({ repo, pass }));
}

/**
 * Forgets everything tia remembers about a repository's issues: fingerprints, once-only markers,
 * announced comments, classifications, plans, the last seen release and its queued runs. The next
 * sweep then evaluates the whole backlog as if it were the first. The decision log is kept.
 */
export async function forgetRepo(repo: string): Promise<number> {
  const slug = repo.toLowerCase();
  const keys = [...(await kv().keys(`tia:*:${slug}#*`)), `tia:release:${slug}`];
  for (const key of keys) await kv().del(key);
  const queued = await kv().lrange<QueueItem>(QUEUE_KEY, 0, -1);
  const kept = queued.filter((item) => `${item.owner}/${item.repo}`.toLowerCase() !== slug);
  await kv().del(QUEUE_KEY);
  for (const item of kept) await kv().rpush(QUEUE_KEY, item);
  return keys.length + queued.length - kept.length;
}

/**
 * An event someone waits on goes to the front. A scheduled pass or a run that is not due yet goes
 * to the back, so a sweep spread over an hour does not hold a new issue behind it.
 */
export function enqueue(item: QueueItem): Promise<void> {
  const scheduled = item.reason === "sweep" || item.reason === "release" || item.notBefore > Date.now();
  return scheduled ? kv().rpush(QUEUE_KEY, item) : kv().lpush(QUEUE_KEY, item);
}

export async function drainQueue(limit: number): Promise<QueueItem[]> {
  const due: QueueItem[] = [];
  const later: QueueItem[] = [];
  for (let i = 0; i < limit * 4 && due.length < limit; i++) {
    const item = await kv().lpop<QueueItem>(QUEUE_KEY);
    if (!item) break;
    if (item.notBefore <= Date.now()) due.push(item);
    else later.push(item);
  }
  for (const item of later) await kv().rpush(QUEUE_KEY, item);
  return due;
}

// Prefixed: Upstash parses stored values as JSON, and a tag such as `2024` would come back as a number.
export async function getLastSeenRelease(repo: string): Promise<string | null> {
  const stored = await kv().get<string>(`tia:release:${repo.toLowerCase()}`);
  return typeof stored === "string" ? stored.replace(/^tag:/, "") : null;
}

export function setLastSeenRelease(repo: string, tag: string): Promise<void> {
  return kv().set(`tia:release:${repo.toLowerCase()}`, `tag:${tag}`);
}

export function saveBackfillRow(runId: string, row: unknown): Promise<void> {
  return kv().rpush(`tia:backfill:${runId}`, row);
}

export function listBackfillRows<T>(runId: string): Promise<T[]> {
  return kv().lrange<T>(`tia:backfill:${runId}`, 0, -1);
}
