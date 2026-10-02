import { defineEval } from "eve/evals";

import { postedComment, triagePrompt } from "./shared";

export default defineEval({
  description: "A report that names the version it worked in and the upgrade that broke it should be labeled regression and mention a maintainer, without leaving triage.",
  async test(t) {
    const turn = await t.send(triagePrompt("regression"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("apply_triage", {
      output: (value) => {
        const applied = value as { addedLabels?: string[]; removedLabels?: string[] };
        return (applied.addedLabels ?? []).includes("regression") && !(applied.removedLabels ?? []).includes("triage");
      },
    });
    t.judge("Mentions a maintainer and says this looks like a regression.", { on: postedComment(turn) }).atLeast(0.7);
  },
});
