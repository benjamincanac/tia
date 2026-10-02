# tia

An [eve](https://eve.dev) agent that triages GitHub issues. It runs as the `hey-tia[bot]` GitHub App through [Vercel Connect](https://vercel.com/docs/connect) and triages new issues by taking one decision per issue.

It never closes, transfers or converts an issue, and never removes a label a human applied. Anything irreversible is handed to the maintainers with an @-mention.

To deploy it, follow [`SETUP.md`](SETUP.md).

## How it works

```
webhook, daily sweep or ops route ─▶ queue ─▶ session
classify_issue ─▶ track_upstream ─▶ validate_reproduction
               ─▶ check_fixed_in_release ─▶ check_duplicate ─▶ apply_triage
```

- Every decision is taken by Jev (`typesafe-ai/jev`) inside a tool and compared with the repository's thresholds. The model never classifies and never sees a probability. It only follows the skill and writes the comment, so it is a cheap one, see [`agent/agent.ts`](agent/agent.ts). Questions live in [`agent/lib/jev/questions.ts`](agent/lib/jev/questions.ts).
- The model sees only tia's own tools. eve's built-ins are off and there is no GitHub tool library: the pipeline tools read GitHub themselves, and `search_issues` covers a maintainer's questions.
- [`apply_triage`](agent/tools/apply_triage.ts) is the only tool that writes to an issue. It enforces dry-run, one comment of 80 words per run, the label allow-list, and the rule that human applied labels stay.
- Runs that need an approval happen in a Discord channel, with Approve and Cancel buttons. Without that channel they are forced to dry-run.
- Text written by GitHub users never reaches the model's prompt. An @-mention is reduced by Jev to "triage request or not".
- A report that says it worked in an earlier version gets the `regression` label and a mention, and shows first in the weekly digest.
- A merged pull request that mentions an open issue without closing it re-checks that issue right away. The reporter is told the fix is merged, and asked to verify once a release carries it.
- Raw Jev answers are stored next to every action, for threshold tuning.

## Configuration

Each repository owns its config in `.github/tia.yml`. A repository without a valid file is ignored. Only `maintainers` is required.

```yaml
maintainers: [benjamincanac]  # mentioned for decisions, their own issues are skipped

upstreams: [unovue/reka-ui]   # root cause candidates, labeled `upstream/<repo>`
package: { name: "@nuxt/ui" } # enables reproduction version checks
nextMajor: v5                 # label for issues that need a breaking change

# Named parts of the codebase: packages, commands, components. Jev says which ones an issue is about.
# Used to match changelog scopes and to cluster the backlog. No label unless an entry sets `label`.
areas:
  - { kind: package, glob: packages/* }

securityPolicy: https://github.com/nuxt/.github/blob/main/SECURITY.md
help: https://nuxt.com        # where non-triage questions are pointed
```

The other keys are `decisions`, `thresholds`, `sweep`, `discord`, `reproduction`, `source` and `triageMaintainerIssues`. The schema with its defaults is [`agent/config.ts`](agent/config.ts), and [`examples/`](examples) has a full file for `nuxt/ui`.

What a repository already declares is not repeated. The reproduction guide, the starter links and the playground host come from the reproduction field of its issue form. Without a guide there, the request links [Why Reproductions are Required](https://antfu.me/posts/why-reproductions-are-required).

Global settings are environment variables, listed in [`.env.example`](.env.example).

## Setup pull request

When the app is installed on a repository without the file, tia opens one pull request from a `tia/setup` branch. It contains a config detected from the repository and removes the workflows tia replaces: `Hebilicious/reproduire`, and `actions/stale` jobs that only target tia's labels. Closing the PR is a final no.

There is no install webhook, so the first webhook a repository sends asks for it and it opens within the minute. The daily sweep is the backstop. `POST /ops/setup/trigger` opens it on demand, and `pnpm propose-setup <owner/repo>` previews it.

## Labels

Nothing to set up. tia creates a label the first time it applies it and never edits an existing one. It can apply `duplicate`, `answered`, `question`, `needs verification`, `needs reproduction`, `regression`, `stale`, the next major label and `upstream/<repo>`. It only removes the labels that several issue forms of the repository apply, such as `triage`. A repository without such a label has nothing to remove.

The kind of issue is read from the forms too. Each form says how the repository marks it, with an Issue Type, with labels such as `bug`, or with both, and tia marks an unmarked issue the same way. The form with a reproduction field is the one that gets the reproduction and fixed checks. A repository without forms gets neither type nor label.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Local agent with the eve terminal UI |
| `pnpm eval triage/<name>` | One eval |
| `pnpm eval` | Runs the [evals](evals), which call Jev and the model but never GitHub |
| `pnpm typecheck`, `pnpm build` | Validation |
| `pnpm validate-config [file]` | Checks a `tia.yml`, `.github/tia.yml` by default |
| `pnpm propose-setup <owner/repo>` | Prints the setup pull request, writes nothing |
| `pnpm backfill <owner/repo>` | Dry-runs a whole backlog into `backfill.csv` |
| `pnpm run deploy` | Deploys to production |

## Schedules and routes

| | When | What |
| --- | --- | --- |
| `dispatch_queue` | every minute | Starts up to 5 queued sessions |
| `daily_sweep` | 03:00 UTC | Re-evaluates waiting issues, follows up on `needs reproduction` at 14 days and mentions maintainers at 30, re-checks open reports for a fix when a release is published, picks up closed upstream issues and new installs |
| `weekly_digest` | Monday 09:00 Paris | One Discord message per repository |

`POST /ops/<triage|sweep|reset|backfill|digest|setup|check>/trigger` and `GET /ops/decisions` are protected by `INTERNAL_API_SECRET`. A preview deployment never writes unless the request carries `"write": true` and approvals are off for Preview with `TIA_REQUIRE_APPROVAL=false`.
