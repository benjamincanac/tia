import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description:
    "An Issue Type a maintainer set is a decision. It stays, whatever the issue reads like.",
  async test(t) {
    await t.send(triagePrompt("retype-maintainer-type"));
    t.succeeded();
    t.calledTool("classify_issue", { output: (value) => (value as unknown as { type: string | null }).type === "Bug" });
    t.calledTool("apply_triage", { output: (value) => !(value as unknown as { setType?: string | null }).setType });
  },
});
