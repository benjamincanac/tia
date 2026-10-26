import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

interface Applied {
  setType: string | null;
  addedLabels: string[];
  removedLabels: string[];
}

export default defineEval({
  description: "A usage question filed with a form that applies `question` stays a question, even when it describes an error: no Bug type, no reproduction request.",
  async test(t) {
    await t.send(triagePrompt("question-form-usage"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.notCalledTool("validate_reproduction");
    t.calledTool("apply_triage", {
      output: (value) => {
        const applied = value as unknown as Applied;
        return applied.setType === null && !applied.removedLabels.includes("question") && !applied.addedLabels.includes("needs reproduction");
      },
    });
    t.judge("Says this reads as a usage question.").atLeast(0.7);
  },
});
