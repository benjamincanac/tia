import { defineEval } from "eve/evals";

import { postedComment, triagePrompt } from "./shared";

interface Applied {
  addedLabels: string[];
  removedLabels: string[];
  comment: string | null;
}

export default defineEval({
  description:
    "A usage question filed through a form that applies `question` is confirmed: no second `question` label, the maintainers are told, and it leaves triage.",
  async test(t) {
    const turn = await t.send(triagePrompt("question-label-question"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.notCalledTool("check_duplicate");
    t.notCalledTool("validate_reproduction");
    t.calledTool("apply_triage", {
      output: (value) => {
        const applied = value as unknown as Applied;
        return (
          !applied.addedLabels.includes("question") &&
          applied.removedLabels.includes("triage") &&
          !applied.removedLabels.includes("question") &&
          (applied.comment ?? "").includes("@maintainer")
        );
      },
    });
    t.judge(
      "States that the issue is a usage question and that converting it to a Q&A discussion was suggested.",
      { on: postedComment(turn) },
    ).atLeast(0.7);
  },
});
