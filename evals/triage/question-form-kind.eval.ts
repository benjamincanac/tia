import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import { triagePrompt } from "./shared";

export default defineEval({
  description:
    "A repository with a question form and the `question` decision off: the label the form applied is the label of its kind, so nothing removes it.",
  async test(t) {
    const turn = await t.send(triagePrompt("question-form-kind"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.notCalledTool("validate_reproduction");
    // `apply_triage` has nothing to do here and may not run at all. When it does, the label stays.
    const removed = turn.toolCalls.flatMap((call) => (call.name === "apply_triage" ? ((call.output as { removedLabels?: string[] } | undefined)?.removedLabels ?? []) : []));
    t.check(removed.includes("question"), equals(false));
  },
});
