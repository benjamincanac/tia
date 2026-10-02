---
description: Use when you need to know what a triage label means, which labels the bot manages, and which ones it must never touch.
---

# Label taxonomy

You never pick labels. This page explains what the plan contains so you can describe it.

## Applied by the bot

| Label | Meaning | Removes the intake labels |
| --- | --- | --- |
| `question` | Usage question. Maintainers are asked to convert it to a Q&A discussion. | yes |
| `upstream/<name>` | Root cause in a configured upstream repository. | yes |
| `needs reproduction` | Bug without a usable reproduction. | no |
| `needs verification` | Likely fixed in a release, waiting for the reporter to confirm. | yes |
| `duplicate` | Same problem as another issue. Maintainers are asked to close. | yes |
| `answered` | The thread is explicitly resolved. Maintainers are asked to close. | yes |
| `regression` | A report that names the version it worked in or the upgrade that broke it. Maintainers are told right away. | no |
| the repo's next major label | Requires a breaking change. | yes |
| `stale` | Idle and likely obsolete. Maintainers are asked to decide. | no |
| an area label | Only when the repository opted in. Part of the codebase involved, as declared by the repository: a package, a command, a component. The label format is the repository's own, such as `pkg: kit`. Most repositories record areas without labeling them, `classify_issue` then returns them in `areas` and nothing shows on the issue. | no |

The kind of issue is marked the way the repository's issue forms mark it: an Issue Type, labels such as `bug`, or both. It is only added when missing, and a repository without forms gets neither.

## Removed by the bot

The intake labels, once a decision from the first table is taken, and `needs reproduction` when the reporter provides one, in a comment or by editing the description. Intake labels are the ones several of the repository's issue forms apply, such as `triage` or `pending triage`. A repository without them has nothing to remove. A label applied by a human is never removed. `apply_triage` enforces this and reports the labels it kept in `keptHumanLabels`.

## Never applied by the bot

`closed-by-bot`, priority labels, `help wanted`, framework labels such as `vue` or `typescript`, and anything not listed above. These belong to maintainers.
