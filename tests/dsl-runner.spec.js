import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function loadCase() {
  const caseFile = process.env.DSL_CASE_FILE;
  if (!caseFile) throw new Error("DSL_CASE_FILE is required.");
  return JSON.parse(await readFile(caseFile, "utf8"));
}

test("run natural language DSL case", async ({ page }, testInfo) => {
  const testCase = await loadCase();
  await testInfo.attach("dsl-case", {
    body: JSON.stringify(testCase, null, 2),
    contentType: "application/json"
  });

  for (const [index, step] of testCase.steps.entries()) {
    await test.step(`${index + 1}. ${step.action} ${step.target || step.page || step.value || ""}`, async () => {
      switch (step.action) {
        case "open":
          await page.goto(step.url);
          break;
        case "input":
          await page.locator(step.selector).fill(String(step.value));
          break;
        case "click":
          await page.locator(step.selector).click();
          break;
        case "wait_visible":
        case "assert_visible":
          await expect(page.locator(step.selector)).toBeVisible();
          break;
        case "assert_text":
          await expect(page.locator(step.selector)).toContainText(String(step.value));
          break;
        case "assert_url_contains":
          await expect(page).toHaveURL(new RegExp(step.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          break;
        default:
          throw new Error(`Unsupported action: ${step.action}`);
      }
    });
  }
});
