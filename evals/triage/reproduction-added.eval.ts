import { defineEval } from "eve/evals";

import { postedComment, triagePrompt } from "./shared";

export default defineEval({
  description: "An issue labeled needs reproduction whose description now carries one loses the label and the reporter is thanked.",
  async test(t) {
    const turn = await t.send(triagePrompt("reproduction-added"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("validate_reproduction");
    t.calledTool("apply_triage", { output: (value) => ((value as { removedLabels?: string[] }).removedLabels ?? []).includes("needs reproduction") });
    t.judge("Thanks the reporter for the reproduction and does not ask for one.", { on: postedComment(turn) }).atLeast(0.7);
  },
});
