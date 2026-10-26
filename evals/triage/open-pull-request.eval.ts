import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "A regression with an open pull request referencing it gets its label and no comment: someone is already on it.",
  async test(t) {
    await t.send(triagePrompt("open-pull-request"));
    t.succeeded();
    t.calledTool("classify_issue", { output: (value) => typeof (value as { quiet?: unknown }).quiet === "string" });
    t.calledTool("apply_triage", {
      output: (value) => {
        const applied = value as { addedLabels?: string[]; comment?: string | null };
        return (applied.addedLabels ?? []).includes("regression") && !applied.comment;
      },
    });
    t.judge("Says the issue was labeled a regression and that nothing was posted because a pull request is open.").atLeast(0.6);
  },
});
