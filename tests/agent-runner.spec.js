import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { runBrowserAgentOnPage } from "../agent-core.js";

async function loadAgentCase() {
  const caseFile = process.env.AGENT_CASE_FILE;
  if (!caseFile) throw new Error("AGENT_CASE_FILE is required.");
  return JSON.parse(await readFile(caseFile, "utf8"));
}

test("run natural language Agent case", async ({ page }, testInfo) => {
  test.setTimeout(Number(process.env.AGENT_TEST_TIMEOUT_MS || 180_000));
  const agentCase = await loadAgentCase();
  await testInfo.attach("agent-case", {
    body: JSON.stringify(agentCase, null, 2),
    contentType: "application/json"
  });

  const result = await runBrowserAgentOnPage(page, agentCase.goal, {
    onUpdate: async (partial) => {
      if (process.env.AGENT_RESULT_FILE) {
        await writeFile(process.env.AGENT_RESULT_FILE, JSON.stringify(partial, null, 2), "utf8");
      }
    }
  });
  await testInfo.attach("agent-result", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json"
  });

  if (process.env.AGENT_RESULT_FILE) {
    await writeFile(process.env.AGENT_RESULT_FILE, JSON.stringify(result, null, 2), "utf8");
  }

  for (const item of result.history) {
    await test.step(`${item.step}. ${item.decision.action} ${item.decision.reason || ""}`, async () => {
      expect(item.decision.action).toBeTruthy();
    });
  }

  expect(result.ok, result.error || result.summary || "Agent did not finish successfully.").toBe(true);
});
