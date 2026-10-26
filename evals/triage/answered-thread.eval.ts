import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "A thread where a maintainer answered and the reporter confirmed it works is labeled answered. The maintainer is already on it, so nothing is posted.",
  async test(t) {
    await t.send(triagePrompt("answered-thread"));
    t.succeeded();
    t.calledTool("classify_issue", { output: (value) => typeof (value as { quiet?: unknown }).quiet === "string" });
    t.calledTool("apply_triage", {
      output: (value) => {
        const applied = value as { addedLabels?: string[]; comment?: string | null };
        return (applied.addedLabels ?? []).includes("answered") && !applied.comment;
      },
    });
    t.judge("States that the issue was labeled answered.").atLeast(0.7);
  },
});
