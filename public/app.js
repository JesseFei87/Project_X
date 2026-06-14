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
const browserUseExample = "打开必应，输入中国的首都是哪里，回车，点击第一个搜索结果打开";

function currentMode() {
  return document.querySelector("input[name='runMode']:checked").value;
}

function setStatus(label, className) {
  statusEl.textContent = label;
  statusEl.className = `status ${className}`;
}

loadExample.addEventListener("click", () => {
  const mode = currentMode();
  caseText.value = mode === "agent" ? agentExample : mode === "browser-use" ? browserUseExample : example;
  caseText.focus();
});

document.querySelectorAll("input[name='runMode']").forEach((input) => {
  input.addEventListener("change", () => {
    const mode = currentMode();
    const isAgent = mode === "agent";
    const isBrowserUse = mode === "browser-use";
    primaryTitle.textContent = isAgent ? "Agent History" : isBrowserUse ? "Browser Use History" : "DSL";
    secondaryTitle.textContent = isAgent ? "Agent Result" : isBrowserUse ? "Browser Use Result" : "Playwright CLI Output";
    caseText.value = isAgent ? agentExample : isBrowserUse ? browserUseExample : example;
    dslOutput.textContent = "{}";
    cliOutput.textContent = "点击 Run 后会在这里显示命令输出。";
    setStatus("Idle", "idle");
  });
});

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  setStatus("Running", "running");
  dslOutput.textContent = "{}";
  const mode = currentMode();
  const isAgent = mode === "agent";
  const isBrowserUse = mode === "browser-use";
  cliOutput.textContent = isAgent
    ? "MiniMax Agent 正在控制浏览器..."
    : isBrowserUse
      ? "Browser Use 正在执行..."
      : "Playwright CLI 正在执行...";

  try {
    const endpoint = isAgent ? "/api/run-agent" : isBrowserUse ? "/api/run-browser-use" : "/api/run";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caseText: caseText.value })
    });
    const payload = await response.json();
    if (isAgent || isBrowserUse) {
      dslOutput.textContent = JSON.stringify(payload.history || [], null, 2);
      cliOutput.textContent = [
        payload.summary ? `Summary:\n${payload.summary}` : "",
        payload.finalUrl ? `Final URL:\n${payload.finalUrl}` : "",
        payload.command ? `$ ${payload.command}` : "",
        payload.stdout || "",
        payload.stderr || "",
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
