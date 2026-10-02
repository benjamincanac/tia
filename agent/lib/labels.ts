import { isAreaLabel, type RepoConfig } from "../config";

interface LabelStyle {
  color: string;
  description: string;
}

const MANAGED: Record<string, LabelStyle> = {
  duplicate: { color: "cfd3d7", description: "This issue already exists" },
  answered: { color: "c5def5", description: "Answered, a maintainer decides whether to close" },
  question: { color: "d876e3", description: "Usage question, better suited to a discussion" },
  "needs verification": { color: "fbca04", description: "Likely fixed, waiting for the reporter to confirm" },
  "needs reproduction": { color: "e99695", description: "Needs a minimal reproduction to act on" },
  regression: { color: "d93f0b", description: "Worked in an earlier version" },
  stale: { color: "eeeeee", description: "Idle and likely obsolete" },
};

/**
 * Color and description for a label tia is about to apply, or `null` when the label is not one of its own.
 * Labels are created on first use. There is no setup step: a repository only ever gets the labels it needs.
 */
export function labelStyle(config: RepoConfig, label: string): LabelStyle | null {
  if (MANAGED[label]) return MANAGED[label];
  if (label === config.nextMajor) return { color: "b60205", description: "Requires a breaking change, targets the next major version" };
  if (label.startsWith("upstream/")) return { color: "1d76db", description: "Root cause in an upstream dependency" };
  if (isAreaLabel(config, label)) return { color: "bfd4f2", description: "Part of the codebase involved" };
  return null;
}

export function isManagedLabel(label: string): boolean {
  return label in MANAGED;
}
