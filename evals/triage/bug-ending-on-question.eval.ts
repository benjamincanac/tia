import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

interface Applied {
  setType: string | null;
  addedLabels: string[];
  removedLabels: string[];
  comment: string | null;
}

export default defineEval({
  description: "A bug report that ends on a question is still a bug report: it gets its kind, is not sent to a discussion and stays in triage.",
  async test(t) {
    await t.send(triagePrompt("bug-ending-on-question"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("apply_triage", {
      output: (value) => {
        const applied = value as unknown as Applied;
        return (
          applied.setType === "Bug" &&
          !applied.addedLabels.includes("question") &&
          !applied.removedLabels.includes("triage") &&
          !(applied.comment ?? "").includes("usage question")
        );
      },
    });
  },
});
