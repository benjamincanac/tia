import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description:
    "A feature request filed through the bug form carries the Issue Type the form set. That is the reporter's pick, so it is replaced.",
  async test(t) {
    await t.send(triagePrompt("retype-reporter-type"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.notCalledTool("validate_reproduction");
    t.calledTool("apply_triage", {
      output: (value) => {
        const applied = value as unknown as { setType: string | null; addedLabels: string[] };
        return applied.setType === "Enhancement" && !applied.addedLabels.includes("needs reproduction");
      },
    });
  },
});
