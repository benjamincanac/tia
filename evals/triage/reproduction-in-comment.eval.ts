import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "A reproduction link the reporter posted in a later comment counts. No reproduction is asked for.",
  async test(t) {
    await t.send(triagePrompt("reproduction-in-comment"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("validate_reproduction", { output: (value) => (value as { valid?: boolean }).valid === true });
    t.calledTool("apply_triage", { output: (value) => !((value as { addedLabels?: string[] }).addedLabels ?? []).includes("needs reproduction") });
    t.judge("Does not ask the reporter for a reproduction.").atLeast(0.7);
  },
});
