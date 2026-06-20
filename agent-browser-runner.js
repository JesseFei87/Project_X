import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  buildMiniMaxRequest,
  extractChatContent,
  extractJsonObject,
  normalizeText,
  parseMiniMaxResponseBody
} from "./agent-core.js";

const LOCAL_LOGIN_URL = "/sample-app/login";
const LOCAL_HOME_URL = "/sample-app/home";
const SAFE_ACTIONS = new Set(["open", "fill", "click", "press", "wait", "assert_text", "assert_url_contains"]);
const SAFE_STRATEGIES = new Set(["label", "text", "role", "placeholder", "testid", "selector"]);

export async function buildAgentBrowserCase(caseText, options = {}) {
  if (process.env.MINIMAX_API_KEY) {
    try {
      return await buildAgentBrowserCaseWithMiniMax(caseText, options);
    } catch (error) {
      const fallback = buildLocalAgentBrowserCase(caseText, options);
      return {
        ...fallback,
        source: "local-rule-parser-after-minimax-error",
        ai_error: error.message
      };
    }
  }

  return buildLocalAgentBrowserCase(caseText, options);
}

async function buildAgentBrowserCaseWithMiniMax(caseText, options) {
  const prompt = buildAgentBrowserPrompt(caseText, options.baseUrl);
  const request = buildMiniMaxRequest(
    prompt,
    "你是 agent-browser CLI 的测试用例规划器。你只输出合法 JSON，不输出 Markdown，不输出解释。",
    { maxTokens: Number(process.env.AGENT_BROWSER_MINIMAX_MAX_TOKENS || 2400) }
  );

  const response = await fetch(request.endpoint, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body)
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`MiniMax agent-browser request failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
  }

  const payload = parseMiniMaxResponseBody(raw);
  const content = extractChatContent(payload);
  const parsed = extractJsonObject(content);
  return normalizeAgentBrowserCase(parsed, caseText);
}

function buildAgentBrowserPrompt(caseText, baseUrl) {
  return `请把自然语言 Web 自动化任务转换成 agent-browser 执行计划 JSON。

要求：
1. 只输出 JSON 对象，不要输出 Markdown，不要解释。
2. 只能使用 action: open, fill, click, press, wait, assert_text, assert_url_contains。
3. fill/click 必须包含 locator。
4. locator 格式：
{
  "strategy": "label|text|role|placeholder|testid|selector",
  "value": "定位值",
  "name": "可选，仅 strategy=role 时用来指定 accessible name"
}
4.1 默认优先使用 label、placeholder、role、text、testid 这类语义定位。
4.2 只有当用户明确给出 CSS/XPath/selector 时，才允许使用 strategy=selector。
5. open 必须包含 url。
6. assert_text 只检查 body 文本是否包含 value。
7. assert_url_contains 只检查 URL 是否包含 value。
8. wait 优先使用 { "value": "networkidle" }，只有明确需要固定等待时才给毫秒数。
9. 如果用户说“打开登录页”，使用 ${baseUrl}${LOCAL_LOGIN_URL}
10. 如果用户说“进入首页”或“验证到达首页”，URL 使用 ${LOCAL_HOME_URL}
11. 如果用户说“打开百度”，使用 https://www.baidu.com；如果用户说“打开必应”或“打开bing”，使用 https://www.bing.com
12. 不要生成登录、支付、删除、发消息、下载文件之外的敏感操作。遇到敏感或不明确任务，输出：
{ "case_name": "xxx", "steps": [{ "action": "assert_text", "value": "__UNSAFE_OR_UNCLEAR__" }] }

输出格式：
{
  "case_name": "用例名称",
  "steps": [
    {
      "action": "open",
      "url": "http://127.0.0.1:3000/sample-app/login"
    },
    {
      "action": "fill",
      "locator": { "strategy": "label", "value": "账号" },
      "value": "test001"
    }
  ]
}

示例：
- “打开必应，输入中国的首都是哪里，回车” 应优先生成：
  { "action": "fill", "locator": { "strategy": "role", "value": "searchbox" }, "value": "中国的首都是哪里" }
  然后再生成 { "action": "press", "key": "Enter" }

自然语言任务：
${caseText}`;
}

function buildLocalAgentBrowserCase(caseText, options) {
  const text = normalizeText(caseText);
  const loginUrl = `${options.baseUrl || "http://127.0.0.1:3000"}${LOCAL_LOGIN_URL}`;
  const steps = [];

  if (/打开.*登录页|进入.*登录页|访问.*登录页/.test(text)) {
    steps.push({ action: "open", url: loginUrl });
  }

  const account = text.match(/(?:输入|填写|填入)(?:账号|用户名|手机号)\s*([^\s，,。；;]+)/);
  if (account) {
    steps.push({
      action: "fill",
      locator: { strategy: "label", value: "账号" },
      value: account[1]
    });
  }

  const password = text.match(/(?:输入|填写|填入)密码\s*([^\s，,。；;]+)/);
  if (password) {
    steps.push({
      action: "fill",
      locator: { strategy: "label", value: "密码" },
      value: password[1]
    });
  }

  if (/点击.*登录|点.*登录|提交登录/.test(text)) {
    steps.push({
      action: "click",
      locator: { strategy: "role", value: "button", name: "登录" }
    });
  }

  if (/验证.*进入首页|跳转.*首页|到达.*首页/.test(text)) {
    steps.push({ action: "assert_url_contains", value: LOCAL_HOME_URL });
  }

  const username = text.match(/(?:看到|显示|展示|包含)(?:用户名|昵称|用户)?\s*([A-Za-z0-9_\-\u4e00-\u9fa5]+)/);
  if (username) {
    steps.push({ action: "assert_text", value: username[1] });
  }

  if (steps.length === 0) {
    return {
      case_name: "Agent Browser 本地规则用例",
      source: "local-rule-parser",
      raw_text: caseText,
      steps: [{ action: "assert_text", value: "__UNSUPPORTED_CASE__" }]
    };
  }

  return {
    case_name: "Agent Browser 本地规则用例",
    source: "local-rule-parser",
    raw_text: caseText,
    steps
  };
}

function normalizeAgentBrowserCase(parsed, rawText) {
  const steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
  return {
    case_name: normalizeText(parsed?.case_name) || "Agent Browser 用例",
    raw_text: rawText,
    steps: steps
      .map((step) => normalizeAgentBrowserStep(step))
      .filter(Boolean)
  };
}

function normalizeAgentBrowserStep(step) {
  const action = SAFE_ACTIONS.has(step?.action) ? step.action : null;
  if (!action) return null;

  if (action === "open") {
    return {
      action,
      url: normalizeText(step.url)
    };
  }

  if (action === "wait") {
    const defaultWaitValue = process.env.AGENT_BROWSER_STEP_WAIT_VALUE || "load";
    const rawValue = step?.value === undefined ? defaultWaitValue : String(step.value);
    const value = rawValue === "networkidle" ? defaultWaitValue : rawValue;
    return { action, value };
  }

  if (action === "assert_text" || action === "assert_url_contains") {
    return { action, value: String(step?.value || "") };
  }

  if (action === "press") {
    return { action, key: normalizeText(step?.key) || "Enter" };
  }

  const locator = normalizeLocator(step?.locator);
  if (!locator) return null;
  return {
    action,
    locator,
    ...(step?.value !== undefined ? { value: String(step.value) } : {}),
    ...(step?.key ? { key: normalizeText(step.key) } : {})
  };
}

function normalizeLocator(locator) {
  const strategy = SAFE_STRATEGIES.has(locator?.strategy) ? locator.strategy : null;
  if (!strategy) return null;
  const value = normalizeText(locator?.value);
  if (!value) return null;

  return {
    strategy,
    value,
    ...(locator?.name ? { name: normalizeText(locator.name) } : {})
  };
}

export async function runAgentBrowserCase(testCase, options = {}) {
  const bin = resolveAgentBrowserBin(options.cwd);
  const session = options.session || `ab-${Date.now()}`;
  const history = [];
  let finalUrl = "";

  try {
    for (const [index, step] of testCase.steps.entries()) {
      const entry = await executeAgentBrowserStep({
        step,
        stepNumber: index + 1,
        session,
        bin,
        cwd: options.cwd
      });
      history.push(entry);
      if (!entry.success) {
        return {
          ok: false,
          history,
          finalUrl: entry.url || finalUrl,
          error: entry.error || `Step ${index + 1} failed.`
        };
      }
      finalUrl = entry.url || finalUrl;
    }
    return {
      ok: true,
      history,
      finalUrl,
      summary: `${testCase.steps.length} steps finished.`
    };
  } catch (error) {
    return {
      ok: false,
      history,
      finalUrl,
      error: normalizeAgentBrowserError(error)
    };
  } finally {
    await runAgentBrowserCommand(bin, session, ["close"], options.cwd).catch(() => null);
  }
}

function resolveAgentBrowserBin(cwd) {
  const configured = process.env.AGENT_BROWSER_BIN;
  if (configured) return configured;

  const localBin = path.join(cwd || process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "agent-browser.cmd" : "agent-browser");
  if (existsSync(localBin)) return localBin;
  return process.platform === "win32" ? "agent-browser.cmd" : "agent-browser";
}

async function executeAgentBrowserStep({ step, stepNumber, session, bin, cwd }) {
  const commandParts = buildCommandArgs(step);
  const executed = [];

  for (const args of commandParts) {
    const result = await runAgentBrowserCommand(bin, session, args, cwd);
    executed.push(result);
    if (result.exitCode !== 0) {
      return {
        step: stepNumber,
        action: step.action,
        command: executed.map((item) => item.command).join("\n"),
        stdout: executed.map((item) => item.stdout).filter(Boolean).join("\n"),
        stderr: executed.map((item) => item.stderr).filter(Boolean).join("\n"),
        snapshotSummary: null,
        success: false,
        error: result.stderr.trim() || result.stdout.trim() || `${step.action} failed`
      };
    }
  }

  const urlResult = await runAgentBrowserCommand(bin, session, ["get", "url"], cwd);
  const snapshotResult = await runAgentBrowserCommand(bin, session, ["snapshot", "-i"], cwd).catch((error) => ({
    exitCode: 1,
    stdout: "",
    stderr: error.message,
    command: `${bin} --session ${session} snapshot -i`
  }));

  const entry = {
    step: stepNumber,
    action: step.action,
    command: executed.map((item) => item.command).join("\n"),
    stdout: executed.map((item) => item.stdout).filter(Boolean).join("\n"),
    stderr: executed.map((item) => item.stderr).filter(Boolean).join("\n"),
    snapshotSummary: summarizeSnapshot(snapshotResult.stdout),
    success: true,
    url: urlResult.stdout.trim()
  };

  if (step.action === "assert_text") {
    const bodyResult = await runAgentBrowserCommand(bin, session, ["get", "text", "body"], cwd);
    const bodyText = bodyResult.stdout || "";
    entry.command = [entry.command, bodyResult.command].filter(Boolean).join("\n");
    entry.stdout = [entry.stdout, bodyResult.stdout].filter(Boolean).join("\n");
    entry.stderr = [entry.stderr, bodyResult.stderr].filter(Boolean).join("\n");
    if (!bodyText.includes(step.value)) {
      entry.success = false;
      entry.error = `assert_text failed: ${step.value}`;
    }
  }

  if (step.action === "assert_url_contains" && !entry.url.includes(step.value)) {
    entry.success = false;
    entry.error = `assert_url_contains failed: ${step.value}`;
  }

  return entry;
}

function buildCommandArgs(step) {
  if (step.action === "open") {
    const waitUntil = process.env.AGENT_BROWSER_OPEN_WAIT_UNTIL || "load";
    return [
      ["open", step.url],
      ["wait", "--load", waitUntil]
    ];
  }

  if (step.action === "fill") {
    return [locatorCommand(step.locator, "fill", step.value || "")];
  }

  if (step.action === "click") {
    return [locatorCommand(step.locator, "click")];
  }

  if (step.action === "press") {
    return [["press", step.key || "Enter"]];
  }

  if (step.action === "wait") {
    return ["load", "domcontentloaded", "networkidle"].includes(step.value)
      ? [["wait", "--load", step.value]]
      : [["wait", String(step.value)]];
  }

  if (step.action === "assert_text" || step.action === "assert_url_contains") {
    return [];
  }

  throw new Error(`Unsupported agent-browser action: ${step.action}`);
}

function locatorCommand(locator, action, value) {
  if (locator.strategy === "role") {
    const args = ["find", "role", locator.value, action];
    if (locator.name) args.push("--name", locator.name);
    if (value !== undefined) args.push(value);
    return args;
  }

  if (locator.strategy === "selector") {
    return value !== undefined ? [action, locator.value, value] : [action, locator.value];
  }

  const args = ["find", locator.strategy, locator.value, action];
  if (value !== undefined) args.push(value);
  return args;
}

function summarizeSnapshot(stdout) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.includes("@e"))
    .slice(0, 8);
  return lines;
}

function runAgentBrowserCommand(bin, session, args, cwd) {
  const commandArgs = ["--session", session, ...args];
  const timeoutMs = Number(process.env.AGENT_BROWSER_COMMAND_TIMEOUT_MS || 30000);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, commandArgs, {
      cwd,
      env: { ...process.env }
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`agent-browser command timed out after ${timeoutMs}ms: ${bin} ${commandArgs.join(" ")}`));
    }, timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout,
        stderr,
        command: `${bin} ${commandArgs.join(" ")}`
      });
    });
  });
}

function normalizeAgentBrowserError(error) {
  const message = error?.message || String(error);
  if (/spawn .*agent-browser.* ENOENT/i.test(message)) {
    return "agent-browser 未安装。请先执行 `npm install agent-browser` 或 `brew install agent-browser`，然后执行 `agent-browser install`。";
  }
  if (/timed out after/i.test(message)) {
    return `agent-browser 执行超时。可以调整 AGENT_BROWSER_COMMAND_TIMEOUT_MS，或把 AGENT_BROWSER_OPEN_WAIT_UNTIL 改成更快的 load / domcontentloaded。`;
  }
  return message;
}
