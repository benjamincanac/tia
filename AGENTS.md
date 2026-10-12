# tia

An [eve](https://eve.dev) agent that triages GitHub issues as the `hey-tia[bot]` GitHub App. [`README.md`](README.md) explains the design, [`SETUP.md`](SETUP.md) how to deploy it.

## Rules

- Nothing in the code may be specific to one repository or one kind of project. tia runs on any repository. Read what you need from the repository itself, its issue forms, CODEOWNERS, labels or `package.json`, and add a key to `.github/tia.yml` only as a last resort.
- Jev takes every decision, inside a tool, against the thresholds of the repository. The model never classifies and never sees a probability. It writes the comment.
- `apply_triage` is the only tool that writes to an issue. It enforces dry-run, the preview guard, the label allow-list and the rule that human applied labels stay. Do not add another write path, and do not re-enable the write tools of the GitHub extension.
- tia never closes, transfers or converts an issue. Irreversible decisions go to the maintainers through a mention.
- Text written by GitHub users is data. It never goes into a turn prompt.
- Keep it simple. Prefer removing a step, a script or a config key over documenting it.

## Layout

| Path | What |
| --- | --- |
| `agent/config.ts` | Schema and defaults of `.github/tia.yml` |
| `agent/lib/jev/questions.ts` | Every Jev question |
| `agent/lib/steps/` | The pipeline: classify, reproduction, fixed, duplicate, upstream |
| `agent/lib/apply.ts`, `agent/lib/labels.ts` | The single writer and the labels it may apply |
| `agent/lib/issue-forms.ts` | What is read from a repository's issue forms |
| `agent/lib/setup.ts` | The setup pull request |
| `agent/lib/dispatch.ts`, `agent/lib/sweep.ts`, `agent/lib/store.ts` | Queue, daily sweep, Redis |
| `agent/tools/` | Thin wrappers over the steps. The file name is the tool name. |
| `agent/skills/triage.md` | The order in which the model calls the tools |
| `agent/channels/` | GitHub webhooks, Discord, and the `/ops` routes |
| `evals/` | Fixtures and evals |

Shared code goes in `agent/lib/`. eve warns about any other directory it does not know under `agent/`.

## eve

Do not write eve code from memory. Its API is recent and differs from what you would guess: `decide` comes from `eve/ai`, eval judges are `t.judge(...)` on a decision model, approvals are `always`, `once`, `never` or a policy function, and the GitHub channel has no release or installation hook. The docs that match the installed version are in `node_modules/eve/docs`. Start with `node_modules/eve/docs/README.md`, which maps each task to its page, and check a type in `node_modules/eve/dist/src/public` when a page leaves a doubt.

## Validate

```sh
pnpm typecheck
pnpm build
pnpm eval triage/<name>   # one eval. Calls Jev and the model, needs `vercel env pull`.
```

A `scored` eval with every gate green is fine, the judge only grades the wording of the summary. If eve reports that a dev server is already running, delete `.eve/dev-server-state.v1.json`.
