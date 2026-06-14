const caseText = document.querySelector("#caseText");
const runButton = document.querySelector("#runButton");
const loadExample = document.querySelector("#loadExample");
const statusEl = document.querySelector("#status");
const dslOutput = document.querySelector("#dslOutput");
const cliOutput = document.querySelector("#cliOutput");
const primaryTitle = document.querySelector("#primaryTitle");
const secondaryTitle = document.querySelector("#secondaryTitle");

const example = "打开登录页，输入账号 test001，输入密码 123456，点击登录按钮，验证进入首页并看到用户名 Jesse。";
const agentExample = "打开百度，输入上海的天气情况，点击第一个搜索结果打开";

function currentMode() {
  return document.querySelector("input[name='runMode']:checked").value;
}

function setStatus(label, className) {
  statusEl.textContent = label;
  statusEl.className = `status ${className}`;
}

loadExample.addEventListener("click", () => {
  caseText.value = currentMode() === "agent" ? agentExample : example;
  caseText.focus();
});

document.querySelectorAll("input[name='runMode']").forEach((input) => {
  input.addEventListener("change", () => {
    const isAgent = currentMode() === "agent";
    primaryTitle.textContent = isAgent ? "Agent History" : "DSL";
    secondaryTitle.textContent = isAgent ? "Agent Result" : "Playwright CLI Output";
    caseText.value = isAgent ? agentExample : example;
    dslOutput.textContent = "{}";
    cliOutput.textContent = "点击 Run 后会在这里显示命令输出。";
    setStatus("Idle", "idle");
  });
});

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  setStatus("Running", "running");
  dslOutput.textContent = "{}";
  const isAgent = currentMode() === "agent";
  cliOutput.textContent = isAgent ? "MiniMax Agent 正在控制浏览器..." : "Playwright CLI 正在执行...";

  try {
    const response = await fetch(isAgent ? "/api/run-agent" : "/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caseText: caseText.value })
    });
    const payload = await response.json();
    if (isAgent) {
      dslOutput.textContent = JSON.stringify(payload.history || [], null, 2);
      cliOutput.textContent = [
        payload.summary ? `Summary:\n${payload.summary}` : "",
        payload.finalUrl ? `Final URL:\n${payload.finalUrl}` : "",
        payload.error ? `Error:\n${payload.error}` : ""
      ].filter(Boolean).join("\n\n");
    } else {
      dslOutput.textContent = JSON.stringify(payload.dsl || {}, null, 2);
      cliOutput.textContent = [
        payload.command ? `$ ${payload.command}` : "",
        payload.stdout || "",
        payload.stderr || "",
        payload.validationErrors ? `Validation errors:\n${payload.validationErrors.join("\n")}` : "",
        payload.error ? `Error:\n${payload.error}` : ""
      ].filter(Boolean).join("\n\n");
    }
    setStatus(payload.ok ? "Pass" : "Fail", payload.ok ? "pass" : "fail");
  } catch (error) {
    cliOutput.textContent = error.message;
    setStatus("Fail", "fail");
  } finally {
    runButton.disabled = false;
  }
});
