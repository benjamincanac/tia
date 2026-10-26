import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "A report on the default branch with a minimal snippet and the root cause in the source needs neither a reproduction nor a version.",
  async test(t) {
    await t.send(triagePrompt("root-cause-report"));
    t.succeeded();
    t.calledTool("classify_issue", { output: (value) => !((value as { facts?: string[] }).facts ?? []).includes("VERSION_REQUEST") });
    t.calledTool("apply_triage", { output: (value) => !((value as { addedLabels?: string[] }).addedLabels ?? []).includes("needs reproduction") });
    // The comment is empty when nothing is asked, so there is no wording to judge.
    t.calledTool("apply_triage", { output: (value) => !/version|reproduc|not find|could not/i.test((value as { comment?: string | null }).comment ?? "") });
  },
});
