import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const CONFIG_PATH = ".github/tia.yml";

export const DECISIONS = [
  "type",
  "question",
  "upstream",
  "reproduction",
  "fixed",
  "duplicate",
  "answered",
  "breaking",
  "regression",
  "area",
  "stale",
] as const;

export type Decision = (typeof DECISIONS)[number];

export const DEFAULT_THRESHOLDS = {
  labels: 0.8,
  has_reproduction: 0.6,
  duplicate: 0.85,
  answered: 0.85,
  is_fixed: 0.8,
  needs_human: 0.5,
  // Jev rarely calls an idle issue obsolete with confidence. Measured on nuxt/ui, 0.55 flags only issues a maintainer closed.
  stale: 0.55,
} as const;

const probability = z.number().min(0).max(1);

const thresholdsSchema = z
  .strictObject({
    labels: probability,
    has_reproduction: probability,
    duplicate: probability,
    answered: probability,
    is_fixed: probability,
    needs_human: probability,
    stale: probability,
  })
  .partial();

const repoSlug = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/repo");

export const repoConfigSchema = z.strictObject({
  maintainers: z.array(z.string().min(1)).min(1),
  /** Issues authored by a maintainer are skipped. Turn on for a test repository you open issues on yourself. */
  triageMaintainerIssues: z.boolean().default(false),
  /**
   * The code lives in another repository. Areas, releases and the next major branch are read from there.
   * Meant for a test repository that mirrors the issues of a real one.
   */
  source: repoSlug.optional(),
  /**
   * Named parts of the codebase an issue can be about: the components of a UI library, the packages
   * of a monorepo, the commands of a CLI. Each area gets one Jev question. What Jev finds is recorded
   * with the run and used to match changelog scopes and to cluster the backlog. A label is optional.
   */
  areas: z
    .array(
      z
        .strictObject({
          /** Singular noun used in the question, such as `component`, `package` or `command`. */
          kind: z.string().min(1).default("area"),
          /** Optional label template, applied when set. `{name}` is replaced by the kebab-case name. */
          label: z.string().includes("{name}").optional(),
          /** One area per match of this single-level glob, named after the file or directory. */
          glob: z.string().min(1).optional(),
          /** Explicit names, alone or on top of `glob`. */
          names: z.array(z.string().min(1)).default([]),
        })
        .refine((area) => area.glob !== undefined || area.names.length > 0, "Expected `glob` or `names`"),
    )
    .default([]),
  upstreams: z.array(repoSlug).default([]),
  /** npm package the repo publishes. Without it, version checks are skipped. */
  package: z
    .strictObject({
      name: z.string().regex(/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/, "Expected an npm package name"),
    })
    .optional(),
  /** Label for the next major version. An issue that needs a breaking change gets it. */
  nextMajor: z.string().min(1).optional(),
  reproduction: z
    .strictObject({
      guide: z.url().optional(),
      templates: z.array(z.strictObject({ name: z.string(), url: z.url() })).default([]),
      /** Substrings of links that point at an unmodified starter, such as a template id or `owner/repo`. */
      blank: z.array(z.string().min(1)).default([]),
    })
    .default({ templates: [], blank: [] }),
  securityPolicy: z.url().optional(),
  /** Where general questions that are not triage requests get pointed to. */
  help: z.url().optional(),
  decisions: z.array(z.enum(DECISIONS)).default([...DECISIONS]),
  thresholds: thresholdsSchema.default({}),
  sweep: z
    .strictObject({
      followUpDays: z.number().int().positive().default(14),
      mentionDays: z.number().int().positive().default(30),
      staleDays: z.number().int().positive().default(60),
    })
    .default({ followUpDays: 14, mentionDays: 30, staleDays: 60 }),
  discord: z
    .strictObject({
      digestChannel: z.string().default(""),
      approvalsChannel: z.string().default(""),
    })
    .default({ digestChannel: "", approvalsChannel: "" }),
});

export type RepoConfigInput = z.input<typeof repoConfigSchema>;
export type RepoConfigFile = z.output<typeof repoConfigSchema>;
export type Thresholds = { [K in keyof typeof DEFAULT_THRESHOLDS]: number };

export interface RepoConfig extends Omit<RepoConfigFile, "thresholds" | "discord"> {
  owner: string;
  repo: string;
  thresholds: Thresholds;
  discord: { digestChannel: string; approvalsChannel: string };
}

export type ParsedConfig =
  | { ok: true; config: RepoConfigFile }
  | { ok: false; error: string };

/** Parses and validates the raw YAML of a `.github/tia.yml` file. */
export function parseRepoConfig(source: string): ParsedConfig {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const result = repoConfigSchema.safeParse(raw);
  if (!result.success) return { ok: false, error: z.prettifyError(result.error) };
  return { ok: true, config: result.data };
}

export function resolveRepoConfig(owner: string, repo: string, file: RepoConfigFile): RepoConfig {
  return {
    ...file,
    owner,
    repo,
    thresholds: { ...DEFAULT_THRESHOLDS, ...file.thresholds },
    discord: {
      digestChannel: file.discord.digestChannel || env("DISCORD_DIGEST_CHANNEL_ID") || "",
      approvalsChannel:
        file.discord.approvalsChannel || env("DISCORD_APPROVALS_CHANNEL_ID") || "",
    },
  };
}

export function isEnabled(config: RepoConfig, decision: Decision): boolean {
  return config.decisions.includes(decision);
}

export function upstreamLabel(upstream: string): string {
  return `upstream/${upstream.split("/")[1] ?? upstream}`;
}

export function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

/** One named part of the codebase, resolved from the repo's `areas` config. */
export interface Area {
  name: string;
  /** Kebab-case name. Also what a conventional-commit scope is compared to. */
  slug: string;
  kind: string;
  /** `null` when the repo does not want a label for this kind of area. */
  label: string | null;
}

export function toArea(name: string, group: { kind: string; label?: string | undefined }): Area {
  const slug = kebabCase(name);
  return { name, slug, kind: group.kind, label: group.label?.replaceAll("{name}", slug) ?? null };
}

/** Whether a label was produced by one of the repo's area templates. */
export function isAreaLabel(config: Pick<RepoConfig, "areas">, label: string): boolean {
  return config.areas.some((group) => {
    if (!group.label) return false;
    const [prefix = "", suffix = ""] = group.label.split("{name}");
    return label.length > prefix.length + suffix.length && label.startsWith(prefix) && label.endsWith(suffix);
  });
}

/** The repository that holds the code: `source` when set, the repo itself otherwise. */
export function sourceRepo(config: Pick<RepoConfig, "owner" | "repo" | "source">): { owner: string; repo: string } {
  const [owner = config.owner, repo = config.repo] = (config.source ?? "").split("/");
  return config.source ? { owner, repo } : { owner: config.owner, repo: config.repo };
}

/** An environment variable, trimmed. A value set from a shell pipe often carries a newline. */
export function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Connector used for every GitHub call. Previews and local dev never share the production app. */
export function githubConnector(): string {
  const override = env("GITHUB_CONNECTOR");
  if (override) return override;
  return isProduction() ? "github/tia" : "github/tia-preview";
}

export function discordConnector(): string {
  return env("DISCORD_CONNECTOR") ?? "discord/tia";
}

export function isProduction(): boolean {
  return env("VERCEL_ENV") === "production";
}

/** Write tools pause for a maintainer unless `TIA_REQUIRE_APPROVAL=false`. */
export function requireApproval(): boolean {
  return env("TIA_REQUIRE_APPROVAL") !== "false";
}
