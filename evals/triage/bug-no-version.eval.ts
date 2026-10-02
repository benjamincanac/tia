import { defineEval } from "eve/evals";

import { postedComment, triagePrompt } from "./shared";

export default defineEval({
  description: "A bug report with a reproduction but no version under the form's version field is asked which version it is on.",
  async test(t) {
    const turn = await t.send(triagePrompt("bug-no-version"));
    t.succeeded();
    t.calledTool("classify_issue", { output: (value) => ((value as { facts?: string[] }).facts ?? []).some((fact) => fact.startsWith("Ask which version")) });
    t.calledTool("apply_triage", { output: (value) => !((value as { addedLabels?: string[] }).addedLabels ?? []).includes("needs reproduction") });
    t.judge("Asks the reporter which version of @acme/ui they are using, and does not ask for a reproduction.", { on: postedComment(turn) }).atLeast(0.7);
  },
});
