import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "The form's version field holds the framework's version and the environment names the package's. The package's wins: no retest, no version question.",
  async test(t) {
    await t.send(triagePrompt("version-in-environment"));
    t.succeeded();
    t.calledTool("classify_issue", { output: (value) => !((value as { facts?: string[] }).facts ?? []).includes("VERSION_REQUEST") });
    t.calledTool("validate_reproduction", { output: (value) => !((value as { facts?: string[] }).facts ?? []).includes("RETEST_REQUEST") });
    // The comment is empty when nothing is asked, so there is no wording to judge.
    t.calledTool("apply_triage", { output: (value) => !/version|retest|4\.6\.2/i.test((value as { comment?: string | null }).comment ?? "") });
  },
});
