import { connectGitHubCredentials } from "@vercel/connect/eve";
import { githubChannel, type GitHubInboundContext } from "eve/channels/github";
import { z } from "zod";

import { githubConnector, isProduction } from "../config";
import { isBot, loadRepoConfig, noteInstallation, referencedIssues } from "../lib/github";
import { SETUP_BRANCH } from "../lib/setup";
import { enqueue, requestRepoPass, type QueueItem } from "../lib/store";

// The GitHub App slug. `@tia` belongs to a GitHub user, so mentioning it would ping a stranger.
const BOT_NAME = "hey-tia";
const MENTION = new RegExp(`(^|\\s)@${BOT_NAME}\\b`, "i");

const mergedPullRequest = z.object({
  merged: z.boolean().default(false),
  head: z.object({ ref: z.string().default("") }).default({ ref: "" }),
  title: z.string().default(""),
  body: z.string().nullable().default(null),
  user: z.object({ login: z.string(), type: z.string() }).nullable().default(null),
});

const openIssue = z.object({
  state: z.string(),
  pull_request: z.unknown().optional(),
});

const issueLabels = z.object({
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  user: z.object({ login: z.string() }).nullable(),
});

/**
 * Hooks never dispatch a turn themselves. They queue the event and `schedules/dispatch_queue`
 * starts the session, on the issue thread or in the Discord approvals channel.
 * Previews receive no webhook driven triage: they are triggered through the ops route.
 */
async function queue(ctx: GitHubInboundContext, item: Omit<QueueItem, "owner" | "repo" | "notBefore">): Promise<null> {
  if (!isProduction()) return null;
  if (isBot(ctx.sender.login, ctx.sender.type)) return null;
  const ref = { owner: ctx.repository.owner, repo: ctx.repository.name };
  // No config means the repository never got its setup pull request. Asking for one here is what
  // makes installing the app enough: the daily schedule would otherwise open it up to a day later.
  if (!(await loadRepoConfig(ref))) {
    await requestRepoPass(ctx.repository.fullName, "setup");
    return null;
  }
  await enqueue({ ...ref, ...item, notBefore: Date.now() });
  return null;
}

/**
 * Every hook starts here, before it decides whether the event is one it acts on. An account tia
 * has never minted a token for is learned from the first webhook of any kind, which is the only
 * step installing the app on a new account takes.
 */
async function seen(ctx: GitHubInboundContext): Promise<void> {
  if (!isProduction()) return;
  await noteInstallation(ctx.repository.owner, ctx.github.installationId);
}

export default githubChannel({
  botName: BOT_NAME,
  credentials: connectGitHubCredentials(githubConnector()),
  // The eyes reaction is a write. Dry runs must leave no trace on the issue.
  progress: { reactions: false },

  async onIssue(ctx, issue) {
    await seen(ctx);
    if (issue.action === "opened" || issue.action === "reopened") return queue(ctx, { issueNumber: issue.issueNumber, reason: "issue" });
    // A reporter who adds the reproduction to the description instead of a comment is not left
    // waiting for the daily sweep. Any other edit is not worth a run.
    if (issue.action !== "edited") return null;
    const parsed = issueLabels.safeParse(issue.raw);
    if (!parsed.success || parsed.data.user?.login !== ctx.sender.login) return null;
    const labels = parsed.data.labels.map((label) => (typeof label === "string" ? label : label.name));
    if (!labels.includes("needs reproduction")) return null;
    return queue(ctx, { issueNumber: issue.issueNumber, reason: "issue" });
  },

  async onComment(ctx, comment) {
    await seen(ctx);
    const issueNumber = ctx.conversation.issueNumber;
    if (ctx.conversation.kind !== "issue" || issueNumber === null) return null;

    if (MENTION.test(comment.body)) {
      return queue(ctx, { issueNumber, reason: "mention", commentId: comment.id, text: comment.body.slice(0, 2_000) });
    }

    // Only the reporter's reply on an issue that waits for them re-runs the pipeline.
    const { owner, name } = ctx.repository;
    const issue = await ctx.github.request<unknown>({ method: "GET", path: `/repos/${owner}/${name}/issues/${issueNumber}` });
    const parsed = issueLabels.safeParse(issue.body);
    if (!parsed.success) return null;
    const labels = parsed.data.labels.map((label) => (typeof label === "string" ? label : label.name));
    const waiting = labels.includes("needs reproduction") || labels.includes("needs verification");
    if (!waiting || parsed.data.user?.login !== comment.author?.login) return null;
    return queue(ctx, { issueNumber, reason: "comment", commentId: comment.id });
  },

  async onPullRequest(ctx, pullRequest) {
    await seen(ctx);
    // Merging the setup pull request is the moment a repository becomes tia's, and the only signal
    // of it: there is no installation hook. It sweeps the backlog instead of waiting for 03:00 UTC.
    const merged = mergedPullRequest.safeParse(pullRequest.raw);
    if (pullRequest.action !== "closed" || !merged.success || !merged.data.merged) return null;
    if (merged.data.head.ref === SETUP_BRANCH) {
      if (isProduction()) await requestRepoPass(ctx.repository.fullName, "sweep");
      return null;
    }
    // A dependency update quotes the changelog of another project, whose numbers are not issues
    // of this repository. The sender is whoever merged it, so `queue` does not catch the author.
    const author = merged.data.user;
    if (author && isBot(author.login, author.type)) return null;
    // A merged fix is news for the open issues it mentions. They get the pass a release gives:
    // the fix is re-checked and nothing else, instead of waiting for 03:00 UTC or the next release.
    const numbers = referencedIssues(`${merged.data.title}\n${merged.data.body ?? ""}`).filter((number) => number !== pullRequest.pullRequestNumber);
    const { owner, name } = ctx.repository;
    for (const issueNumber of numbers) {
      // A number in a pull request is not always an open issue of this repository: it can be
      // another pull request, a closed issue or a reference copied from another changelog.
      const issue = await ctx.github.request<unknown>({ method: "GET", path: `/repos/${owner}/${name}/issues/${issueNumber}` }).catch(() => null);
      const parsed = openIssue.safeParse(issue?.body);
      if (!issue?.ok || !parsed.success || parsed.data.state !== "open" || parsed.data.pull_request !== undefined) continue;
      await queue(ctx, { issueNumber, reason: "release" });
    }
    return null;
  },

  events: {
    // The default handlers check out the repo and post the model's reply as a comment.
    // Triage needs neither: `apply_triage` is the only writer, and it honors dry-run.
    "turn.started"() {},
    // The default posts the approval prompt as a public comment. Runs that need an approval are
    // dispatched to Discord, so reaching this means a misconfiguration. Stay silent.
    "input.requested"(event, channel) {
      console.warn(`[tia] input requested on ${channel.repository.fullName}, ignored`, JSON.stringify(event.requests.map((request) => request.kind)));
    },
    "message.completed"(event, channel) {
      if (event.finishReason !== "tool-calls" && event.message) {
        console.log(`[tia] ${channel.repository.fullName}#${channel.conversation.issueNumber ?? channel.conversation.pullRequestNumber}: ${event.message}`);
      }
    },
    "turn.failed"(event, channel) {
      console.error(`[tia] turn failed on ${channel.repository.fullName}`, event);
    },
    "session.failed"(event, channel) {
      console.error(`[tia] session failed on ${channel.repository.fullName}`, event);
    },
  },
});
