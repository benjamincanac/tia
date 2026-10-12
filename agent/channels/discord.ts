import { defaultDiscordAuth, discordChannel, discordContinuationToken, renderInputRequestComponents } from "eve/channels/discord";
import { z } from "zod";

import { isMaintainer, requireApproval } from "../config";
import { buildComment, reporterText } from "../lib/apply";
import { loadTriageContext } from "../lib/context";
import { discordCredentials } from "../lib/discord";
import { emptyPlan } from "../lib/plan";
import { getPlan } from "../lib/store";

const applyInput = z.object({ owner: z.string(), repo: z.string(), issueNumber: z.number(), comment: z.string() });

/**
 * What an approval would write, in the prompt itself. "Approve tool call: apply_triage" alone asks
 * a maintainer to say yes to something they cannot see.
 */
async function describeWrite(input: unknown, runId: string): Promise<string> {
  const parsed = applyInput.safeParse(input);
  if (!parsed.success) return "";
  const { owner, repo, issueNumber, comment } = parsed.data;
  const ref = { owner, repo, issueNumber };
  const context = await loadTriageContext(ref).catch(() => null);
  const recorded = await getPlan(ref);
  const plan = recorded ?? emptyPlan(ref, runId, true);

  const lines = [`**[${owner}/${repo}#${issueNumber}](<https://github.com/${owner}/${repo}/issues/${issueNumber}>)**`];
  if (plan.setType) lines.push(`Type: ${context?.issue.type ? `${context.issue.type} → ` : ""}${plan.setType}`);
  // The plan is what the steps asked for. Only labels the issue carries can be removed, and only ones it lacks added.
  const current = context?.issue.labels ?? [];
  const add = plan.addLabels.filter((label) => !current.includes(label));
  const remove = plan.removeLabels.filter((label) => !context || current.includes(label));
  if (add.length) lines.push(`Add: ${add.join(", ")}`);
  if (remove.length) lines.push(`Remove: ${remove.join(", ")}`);

  // What `apply_triage` would post, built the same way.
  const body = context ? buildComment(context.config, plan, reporterText(recorded, comment), context.reproduction) : reporterText(recorded, comment);
  if (body) lines.push("", body.length > 900 ? `${body.slice(0, 900)}…` : body);
  return lines.join("\n");
}

const appliedOutput = z.object({
  dryRun: z.boolean(),
  blocked: z.string().nullable(),
  setType: z.string().nullable(),
  addedLabels: z.array(z.string()),
  removedLabels: z.array(z.string()),
  comment: z.string().nullable(),
});

/** A real write only happens behind an approval when approvals are on, so a written result was approved. */
function wasApproved(output: unknown): boolean {
  const applied = appliedOutput.safeParse(output);
  if (!applied.success || !requireApproval()) return false;
  const { dryRun, blocked, setType, addedLabels, removedLabels, comment } = applied.data;
  return !dryRun && blocked === null && Boolean(setType || addedLabels.length || removedLabels.length || comment);
}

/**
 * Two uses without a server: `/ask` in a DM with the app, and the DM channel that receives
 * approval prompts and the weekly digest.
 */
export default discordChannel({
  credentials: discordCredentials,
  onCommand(_ctx, interaction) {
    // The backlog conversation can trigger re-triage, so it is limited to maintainers.
    if (!isMaintainer(interaction.user.id)) return null;
    return { auth: defaultDiscordAuth(interaction) };
  },
  // eve drops every press while `onCommand` is custom and this is not set. Same gate as `/ask`.
  onInputResponse(ctx, interaction) {
    if (!isMaintainer(interaction.user.id)) return null;
    return { auth: ctx.defaultAuth };
  },
  events: {
    // A scheduled run speaks through its approval prompt alone. The prompt says what would be written
    // and its button what was decided, so the model's own summary is noise, and a run that asked
    // nothing posts nothing: a sweep would otherwise notify once per issue.
    async "message.completed"(event, channel) {
      if (event.finishReason === "tool-calls") return;
      if (!channel.discord.interactionToken) return;
      if (event.message) await channel.discord.post(event.message);
    },
    async "input.requested"(event, channel, ctx) {
      const { channelId, interactionToken } = channel.discord;
      let anchored = false;
      for (const request of event.requests) {
        const detail = request.action?.toolName === "apply_triage" ? await describeWrite(request.action.input, `${ctx.session.id}:${ctx.session.turn.id}`) : "";
        const body = {
          allowed_mentions: { parse: [] },
          components: renderInputRequestComponents(request),
          content: (detail ? `${detail}\n\n${request.prompt}` : request.prompt).slice(0, 1_900),
        };
        // A run started from a schedule has posted nothing so far. Discord sends the id of the message
        // the button sits on, so the session takes the prompt as its address, or the click would
        // resolve to no session and the approval would be dropped.
        if (!anchored && !interactionToken) {
          const posted = await channel.discord.sendChannelMessage(body);
          if (posted.id) {
            channel.continuation?.alias(discordContinuationToken(channelId, posted.id));
            channel.state.conversationId = posted.id;
          }
          anchored = true;
          continue;
        }
        await channel.discord.post(body);
      }
    },
    // eve acknowledges a click and leaves the message as it is, so the buttons of an answered prompt
    // stay clickable. They are replaced by the answer when the result shows there was a prompt, and
    // cleared otherwise. A run that asked nothing still has its placeholder id and no message to edit.
    async "action.result"(event, channel) {
      const { channelId, conversationId, interactionToken } = channel.discord;
      if (event.result.kind !== "tool-result" || event.result.toolName !== "apply_triage") return;
      if (interactionToken || !/^\d+$/.test(conversationId)) return;
      const answer = event.status === "rejected" ? "Cancelled" : event.status === "completed" && wasApproved(event.result.output) ? "Approved" : null;
      const components = answer
        ? [{ type: 1, components: [{ type: 2, style: answer === "Approved" ? 3 : 2, label: answer, custom_id: "tia:answered", disabled: true }] }]
        : [];
      await channel.discord
        .request(`/channels/${channelId}/messages/${conversationId}`, { components }, { botAuth: true, method: "PATCH" })
        .catch(() => undefined);
    },
  },
});
