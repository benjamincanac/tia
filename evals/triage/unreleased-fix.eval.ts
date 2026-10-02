import { defineEval } from "eve/evals";

import { postedComment, triagePrompt } from "./shared";

export default defineEval({
  description: "A bug fixed by a merged pull request that no release carries yet is told so, and is not labeled needs verification.",
  async test(t) {
    const turn = await t.send(triagePrompt("unreleased-fix"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("check_fixed_in_release", { output: (value) => (value as { fixedBy: { id: string; release: string | null } | null }).fixedBy?.id === "#512" });
    t.calledTool("apply_triage", { output: (value) => !((value as { addedLabels?: string[] }).addedLabels ?? []).includes("needs verification") });
    t.judge(
      "Says a fix was merged in #512 and is not released yet. Does not ask the reporter to confirm on the latest version and does not say when it will be released.",
      { on: postedComment(turn) },
    ).atLeast(0.7);
  },
});
