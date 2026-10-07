import { defineEval } from "eve/evals";

import { postedComment, triagePrompt } from "./shared";

interface Applied {
  setType: string | null;
  addedLabels: string[];
  removedLabels: string[];
}

export default defineEval({
  description:
    "A bug report filed through a form that applies `question` is not a decided question: it gets its kind and a reproduction request, and stays in triage.",
  async test(t) {
    const turn = await t.send(triagePrompt("question-label-bug"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("apply_triage", {
      output: (value) => {
        const applied = value as unknown as Applied;
        return (
          applied.setType === "Bug" &&
          applied.addedLabels.includes("needs reproduction") &&
          !applied.addedLabels.includes("question") &&
          !applied.removedLabels.includes("question") &&
          !applied.removedLabels.includes("triage")
        );
      },
    });
    t.judge(
      "Asks the reporter for a reproduction.",
      { on: postedComment(turn) },
    ).atLeast(0.7);
  },
});
