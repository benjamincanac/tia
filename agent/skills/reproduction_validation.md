---
description: Use when a bug has or lacks a reproduction, to phrase the request, the validation result and the outdated version ask.
---

# Reproduction validation

## No reproduction

`classify_issue` plans `needs reproduction` and returns the fact `REPRODUCTION_REQUEST`. The templated request is appended by `apply_triage`, with the guide and the starter links taken from the repository's own issue form. Write nothing about it. When it is the only fact, pass an empty comment. Never say that a reproduction is needed, that a link would help, that none was found, or that the label was added: the appended request says all of it.

The fact `VERSION_REQUEST` works the same way: the question naming the package is appended for you.

## A reproduction is present

`validate_reproduction` never opens a link. It returns the reproduction `links` it found and flags the ones that are the unmodified starter template. Never say that a link does not open, that the reproduction works or that the bug was confirmed.

When every link is the starter, the plan switches to `needs reproduction`. Say that the link is the unmodified starter, then the templated request follows.

When the report is behind the latest version, `validate_reproduction` returns the fact `RETEST_REQUEST`. The templated retest request naming both versions is appended by `apply_triage`. Never ask for the retest yourself. Convey the facts of the other steps, and when there are none, pass an empty comment. This is asked once per issue.
