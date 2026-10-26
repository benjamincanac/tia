import { defineEval } from "eve/evals";

import { postedComment, triagePrompt } from "./shared";

export default defineEval({
  description:
    "An issue that restates a closed issue is not a duplicate. It never gets the `duplicate` label, keeps `triage`, and the reporter is not told about the closed one.",
  async test(t) {
    const turn = await t.send(triagePrompt("previously-reported"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("check_duplicate", { output: (value) => (value as { duplicateOf: unknown }).duplicateOf === null });
    t.calledTool("apply_triage", {
      output: (value) => {
        const applied = value as { addedLabels?: string[]; removedLabels?: string[]; comment?: string | null };
        return !(applied.addedLabels ?? []).includes("duplicate") && !(applied.removedLabels ?? []).includes("triage") && !(applied.comment ?? "").includes("412");
      },
    });
    t.judge("Does not mention issue #412, a closed issue or a duplicate.", { on: postedComment(turn) }).atLeast(0.7);
  },
});
