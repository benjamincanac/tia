# Deploy and set up tia

Everything is done from the terminal, inside a clone of this repository.

You need:

- Node 24 and pnpm.
- The [Vercel CLI](https://vercel.com/docs/cli), logged in: `pnpm add -g vercel`, then `vercel login`.
- The [GitHub CLI](https://cli.github.com), logged in: `gh auth login`. The local scripts use its token.
- A Vercel team on the Pro plan. One schedule runs every minute, which Hobby rejects at deploy time.
- A GitHub account where you can create a GitHub App.
- A Discord account. A server is optional, a direct message with the app is enough.

## 1. Create the project

```sh
git clone https://github.com/benjamincanac/tia.git && cd tia
pnpm install

# Asks for a team and a project. Creates the project when it does not exist.
vercel link

# Writes .env.local with VERCEL_OIDC_TOKEN, which authenticates AI Gateway and Connect locally.
# It expires after 12 hours. Pull again when local calls return 401.
vercel env pull

# Check. `pnpm eval` is the first real run of Jev and the models, and never calls GitHub.
pnpm typecheck && pnpm build && pnpm eval
```

## 2. Add Redis and the secret

```sh
# Pick Redis when asked. It holds the event queue, the decision log and the once-only markers.
vercel integration add upstash -e production

# Protects the /ops routes. Print it too: Vercel stores it as sensitive and never shows it again.
export INTERNAL_API_SECRET=$(openssl rand -hex 32) && echo $INTERNAL_API_SECRET
echo $INTERNAL_API_SECRET | vercel env add INTERNAL_API_SECRET production

# Comma separated GitHub accounts tia answers to. A public app can be installed by anyone,
# and every other installation is ignored. It cannot live in `.github/tia.yml`,
# since whoever installs the app writes that file.
vercel env add TIA_ALLOWED_OWNERS production

# Check
vercel env ls production
```

## 3. Create the GitHub app

```sh
# Opens the browser on the connector form, see below.
# Without --trigger-event a connector only forwards pull_request,
# and tia would never hear about a new issue.
vercel connect create github --name tia --triggers \
  --trigger-event issues --trigger-event issue_comment --trigger-event pull_request

# Connect verifies GitHub's signature and forwards the webhooks to this path.
# There is no webhook secret or private key to store.
vercel connect attach github/tia -e production --triggers --trigger-path /eve/v1/github
```

In the form, keep **Managed** and pick your account as the namespace. Under **Permissions**, select **Deselect all**, then set:

| Permission | Level | Used for |
| --- | --- | --- |
| `issues` | write | Labels, the Issue Type, comments |
| `pull_requests` | write | Reading linked pull requests, opening the setup pull request |
| `contents` | write | Reading `.github/tia.yml` and issue forms, pushing the `tia/setup` branch |
| `workflows` | write | Removing the workflows tia replaces, in the setup pull request |
| `metadata` | read | Required by GitHub |

**App Name** is the slug people mention and what comments are signed with, `@hey-tia` and `hey-tia[bot]`. It has to be free across GitHub users, organizations and apps, and it has to match `BOT_NAME` in [`agent/channels/github.ts`](agent/channels/github.ts). Keep **Connector Name** as the UID the code looks up, `tia`.

Only `issues` write is used by triage. The rest is for the setup pull request. If you write `.github/tia.yml` by hand, `pull_requests` and `contents` on read are enough.

## 4. Set up Discord

Every write waits for an approval in Discord, with Approve and Cancel buttons. Without a channel to ask in, runs that want to write are forced to dry-run: eve's GitHub channel would otherwise post the approval prompt as a public comment on the issue.

```sh
# Asks for the bot token of a Discord application, new or existing, from
# https://discord.com/developers/applications. Creates the discord/tia connector,
# registers /ask, and points the Interactions Endpoint URL at Connect.
# It refuses to overwrite agent/channels/discord.ts at the end, which is what you want:
# the connector is already created by then.
pnpm eve add channel/discord

vercel connect attach discord/tia -e production
```

Install the app: in **Installation**, keep **User Install**, add the `applications.commands` scope, open the install link and add it to your account. For a server, use **Guild Install** with `bot` and `applications.commands`, Send Messages and Embed Links.

Turn on **Developer Mode** in Discord's advanced settings to copy ids. Send the app a direct message, then right-click that conversation to copy its channel id. A direct message is a channel like any other, and both variables can hold the same id.

```sh
vercel env add DISCORD_APPROVALS_CHANNEL_ID production
vercel env add DISCORD_DIGEST_CHANNEL_ID production

# Your Discord user id. Who can use /ask and press Approve.
vercel env add DISCORD_MAINTAINER_IDS production
```

> [!NOTE]
> Only the users in `DISCORD_MAINTAINER_IDS` can press Approve or Cancel. The prompt shows what would be written, so keep the channel a direct message or a private channel.

## 5. Deploy

```sh
# Once the repository is connected to the Vercel project, pushing to main deploys.
git push

# Without that connection, or to deploy the working tree
pnpm run deploy
```

> [!IMPORTANT]
> Deploy after steps 2, 3 and 4, not before. A deployment keeps the variables it was built with, and an installation token is minted for the repositories selected at that moment. Redeploy after changing either.

## 6. Add a repository

Install the app on it. The setup pull request opens within a minute of the repository's first issue or pull request activity, and at 03:00 UTC otherwise, unless the app is installed on more than 10 repositories or `TIA_AUTO_SETUP=false`. To ask for it right away:

```sh
export TIA_URL=https://<production-url>
export INTERNAL_API_SECRET=<value from step 2>

# The proposal, writing nothing. Add "write": true to open the pull request.
curl -X POST $TIA_URL/ops/setup/trigger \
  -H "authorization: Bearer $INTERNAL_API_SECRET" -H "content-type: application/json" \
  -d '{ "repo": "<owner>/<repo>" }'
```

`pnpm propose-setup <owner>/<repo>` prints the same thing from your machine.

1. Review the pull request and fix what its "To check" section lists. Closing it is a final no, tia never opens it again.
2. Merge. tia picks the repository up and sweeps its open backlog within a few minutes.
3. Open an issue without a reproduction. Within a minute or two Discord shows an Approve prompt with what it would write. Approve, and the issue gets `needs reproduction`, loses the label its issue forms apply, and receives one comment.
4. Reply with a repository link. tia removes the label and runs again.
5. Comment `@hey-tia can you triage this again?` on another issue.
6. In Discord, `/ask message: what's waiting on me?`.

Set `triageMaintainerIssues: true` in the repository's config if you want your own issues triaged, which is what makes a test repository usable.

## 7. Tune it

```sh
# Every decision with the raw Jev answers behind it, as JSONL.
curl "$TIA_URL/ops/decisions?repo=<owner>/<repo>&since=<iso date>" \
  -H "authorization: Bearer $INTERNAL_API_SECRET"

# The whole open backlog through the pipeline on your machine, as a CSV. Writes nothing.
pnpm backfill <owner>/<repo>

# Forget what tia remembers about the repository, then sweep it again from scratch.
curl -X POST $TIA_URL/ops/reset/trigger \
  -H "authorization: Bearer $INTERNAL_API_SECRET" -H "content-type: application/json" \
  -d '{ "repo": "<owner>/<repo>" }'
curl -X POST $TIA_URL/ops/sweep/trigger \
  -H "authorization: Bearer $INTERNAL_API_SECRET" -H "content-type: application/json" \
  -d '{ "repo": "<owner>/<repo>", "write": true }'
```

Read either one, adjust `thresholds` in the repository's config, and when you stop disagreeing with the prompts, set `TIA_REQUIRE_APPROVAL=false` and redeploy to let it write on its own.

```sh
# The digest, now instead of Monday 09:00 Paris.
curl -X POST $TIA_URL/ops/digest/trigger \
  -H "authorization: Bearer $INTERNAL_API_SECRET" -H "content-type: application/json" \
  -d '{ "repo": "<owner>/<repo>", "write": true }'
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Nothing happens after opening an issue | No valid `.github/tia.yml` on the default branch, check with `pnpm validate-config`. Or the connector was created without the `issues` event. Or the author is a maintainer and `triageMaintainerIssues` is off. |
| `"dryRun": true` in the decision log | No approvals channel is set, or the run came from a preview or a backfill. |
| `/ask` answers nothing | Your id is not in `DISCORD_MAINTAINER_IDS`. |
| Approve does nothing | Your id is not in `DISCORD_MAINTAINER_IDS`, or the session expired. Runs park for 10 minutes. Trigger the issue again. |
| `tia didn't respond in time` on Approve | The Interactions Endpoint URL is empty. Editing the application in Discord's portal clears it. Set it back to `https://connect.vercel.com/trigger/<connector id>`. |
| 401 locally | `VERCEL_OIDC_TOKEN` expired, run `vercel env pull`. |
| 403 on a GitHub write | The app lacks the permission. |
| 404 on a repository the deployment reads | The app is not installed on it, or the installation does not select it. Check <https://github.com/settings/installations>. |
| `A dev server is already running` | Delete `.eve/dev-server-state.v1.json`. |
