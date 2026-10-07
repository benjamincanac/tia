import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description:
    "A feature request filed through a bug form that applies `bug` gets the label of its kind, and the label the reporter picked goes.",
  async test(t) {
    await t.send(triagePrompt("retype-reporter-label"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.notCalledTool("validate_reproduction");
    t.calledTool("apply_triage", {
      output: (value) => {
        const applied = value as unknown as { setType: string | null; addedLabels: string[]; removedLabels: string[] };
        return (
          applied.setType === null &&
          applied.addedLabels.includes("enhancement") &&
          !applied.addedLabels.includes("needs reproduction") &&
          applied.removedLabels.includes("bug") &&
          !applied.removedLabels.includes("needs triage")
        );
      },
    });
  },
});
