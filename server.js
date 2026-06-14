import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMiniMaxRequest,
  extractChatContent,
  extractJsonObject,
  normalizeText,
  parseMiniMaxResponseBody
} from "./agent-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const BASE_URL = process.env.BASE_URL || `http://${HOST}:${PORT}`;

const pages = {
  "登录页": {
    url: "/sample-app/login",
    aliases: ["登录", "登录页面", "login"],
    elements: [
      {
        id: "login.username",
        name: "账号输入框",
        aliases: ["账号", "用户名", "手机号", "用户"],
        type: "input",
        selector: "[data-testid='login-username']",
        actions: ["input", "assert_visible"]
      },
      {
        id: "login.password",
        name: "密码输入框",
        aliases: ["密码", "登录密码"],
        type: "input",
        selector: "[data-testid='login-password']",
        actions: ["input", "assert_visible"]
      },
      {
        id: "login.submit",
        name: "登录按钮",
        aliases: ["登录按钮", "登录", "提交", "立即登录"],
        type: "button",
        selector: "[data-testid='login-submit']",
        actions: ["click", "assert_visible"]
      }
    ]
  },
  "首页": {
    url: "/sample-app/home",
    aliases: ["主页", "home", "首页"],
    elements: [
      {
        id: "home.username",
        name: "用户名展示区域",
        aliases: ["用户名", "昵称", "用户名称", "Jesse"],
        type: "text",
        selector: "[data-testid='home-username']",
        actions: ["assert_text", "assert_visible"]
      },
      {
        id: "home.heading",
        name: "首页标题",
        aliases: ["首页", "欢迎页"],
        type: "text",
        selector: "[data-testid='home-heading']",
        actions: ["assert_text", "assert_visible"]
      }
    ]
  }
};

const actionTypes = {
  input: ["input"],
  click: ["button", "link"],
  assert_text: ["text", "input", "button", "link"],
  assert_visible: ["text", "input", "button", "link"]
};

async function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return;

  const raw = await readFile(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

async function parseNaturalCase(caseText) {
  if (process.env.MINIMAX_API_KEY) {
    try {
      return await parseNaturalCaseWithMiniMax(caseText);
    } catch (error) {
      const fallback = parseNaturalCaseLocally(caseText);
      return {
        ...fallback,
        source: "local-rule-parser-after-minimax-error",
        ai_error: error.message
      };
    }
  }

  return parseNaturalCaseLocally(caseText);
}

function parseNaturalCaseLocally(caseText) {
  const text = normalizeText(caseText);
  const steps = [];
  const caseName = text.includes("登录") ? "自然语言登录用例" : "自然语言Web用例";

  if (/打开.*登录页|进入.*登录页|访问.*登录页/.test(text)) {
    steps.push({ action: "open", page: "登录页" });
  }

  const account = text.match(/(?:输入|填写|填入)(?:账号|用户名|手机号)\s*([^\s，,。；;]+)/);
  if (account) {
    steps.push({ action: "input", page: "登录页", target: "账号", value: account[1] });
  }

  const password = text.match(/(?:输入|填写|填入)密码\s*([^\s，,。；;]+)/);
  if (password) {
    steps.push({ action: "input", page: "登录页", target: "密码", value: password[1] });
  }

  if (/点击.*登录|点.*登录|提交登录/.test(text)) {
    steps.push({ action: "click", page: "登录页", target: "登录" });
  }

  if (/验证.*进入首页|跳转.*首页|到达.*首页/.test(text)) {
    steps.push({ action: "assert_url_contains", value: "/sample-app/home" });
  }

  const username = text.match(/(?:看到|显示|展示|包含)(?:用户名|昵称|用户)?\s*([A-Za-z0-9_\-\u4e00-\u9fa5]+)/);
  if (username) {
    steps.push({
      action: "assert_text",
      page: "首页",
      target: "用户名",
      value: username[1]
    });
  }

  if (steps.length === 0) {
    steps.push({
      action: "needs_clarification",
      reason: "暂时只内置了登录页 demo 解析规则。请使用示例格式，或接入 MiniMax-M3 解析器。"
    });
  }

  return {
    case_name: caseName,
    platform: "web",
    source: "local-rule-parser",
    raw_text: caseText,
    steps
  };
}

async function parseNaturalCaseWithMiniMax(caseText) {
  const prompt = buildDslPrompt(caseText);
  const request = buildMiniMaxRequest(
    prompt,
    "你是自动化测试平台的测试用例解析器。你只输出合法 JSON，不输出 Markdown 或解释。"
  );

  const response = await fetch(request.endpoint, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body)
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`MiniMax request failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
  }

  const payload = parseMiniMaxResponseBody(raw);
  const content = extractChatContent(payload);
  const parsed = extractJsonObject(content);
  const normalized = normalizeAiDsl(parsed, caseText);
  return {
    ...normalized,
    source: `minimax-m3:${request.style}`
  };
}

function buildDslPrompt(caseText) {
  const pageSummary = Object.entries(pages).map(([pageName, page]) => ({
    page: pageName,
    url: page.url,
    aliases: page.aliases,
    elements: page.elements.map((element) => ({
      name: element.name,
      aliases: element.aliases,
      type: element.type,
      actions: element.actions
    }))
  }));

  return `请把自然语言 Web 测试用例转换成平台 DSL JSON。

只能使用这些 action：
- open: 打开页面，必须包含 page
- input: 输入内容，必须包含 target 和 value
- click: 点击元素，必须包含 target
- wait_visible: 等待元素可见，必须包含 target
- assert_visible: 断言元素可见，必须包含 target
- assert_text: 断言元素包含文本，必须包含 target 和 value
- assert_url_contains: 断言 URL 包含指定文本，必须包含 value

要求：
1. 只输出 JSON 对象，不要输出 Markdown，不要解释。
2. 输出格式必须是：
{
  "case_name": "用例名称",
  "platform": "web",
  "steps": [
    { "action": "open", "page": "登录页" }
  ]
}
3. target 使用页面元素的业务名称或别名，不要生成 selector。
4. 如果用户表达“进入首页”，优先生成 assert_url_contains，value 使用页面 URL。
5. 如果确实无法理解某一步，生成：
{ "action": "needs_clarification", "reason": "原因" }
6. 不要生成不在白名单里的 action。

当前元素库：
${JSON.stringify(pageSummary, null, 2)}

自然语言用例：
${caseText}`;
}

function normalizeAiDsl(parsed, caseText) {
  const safeActions = new Set([
    "open",
    "input",
    "click",
    "wait_visible",
    "assert_visible",
    "assert_text",
    "assert_url_contains",
    "needs_clarification"
  ]);
  const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
  return {
    case_name: normalizeText(parsed.case_name) || "MiniMax生成用例",
    platform: "web",
    raw_text: caseText,
    steps: steps.map((step) => {
      const action = safeActions.has(step.action) ? step.action : "needs_clarification";
      if (action === "needs_clarification") {
        return {
          action,
          reason: step.reason || `不支持的动作：${step.action || "空"}`
        };
      }
      return {
        action,
        ...(step.page ? { page: normalizeText(step.page) } : {}),
        ...(step.target ? { target: normalizeText(step.target) } : {}),
        ...(step.value !== undefined ? { value: String(step.value) } : {})
      };
    })
  };
}

function scoreElement(step, element) {
  if (!element.actions.includes(step.action)) return 0;
  if (actionTypes[step.action] && !actionTypes[step.action].includes(element.type)) return 0;

  const target = normalizeText(step.target);
  if (!target) return 0.2;
  if (element.name === target) return 1;
  if (element.aliases.includes(target)) return 0.96;
  if (element.name.includes(target) || target.includes(element.name)) return 0.82;
  if (element.aliases.some((alias) => alias.includes(target) || target.includes(alias))) return 0.76;
  return 0;
}

function enrichWithElementLibrary(dsl) {
  let currentPage = null;
  const steps = dsl.steps.map((step) => {
    if (step.action === "open") {
      currentPage = step.page;
      const page = pages[step.page];
      return page
        ? { ...step, url: page.url, match_score: 1, confirmed: true }
        : { ...step, needs_confirmation: true, match_score: 0 };
    }

    if (step.action === "assert_url_contains") {
      const nextPage = findPageNameByUrlValue(step.value);
      if (nextPage) currentPage = nextPage;
      return { ...step, confirmed: true };
    }

    if (step.action === "needs_clarification") {
      return { ...step, confirmed: step.action !== "needs_clarification" };
    }

    const pageName = step.page || currentPage;
    const page = pages[pageName];
    if (!page) {
      return { ...step, page: pageName, needs_confirmation: true, match_score: 0 };
    }

    const candidates = page.elements
      .map((element) => ({ element, score: scoreElement(step, element) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      return { ...step, page: pageName, needs_confirmation: true, match_score: 0, candidates: [] };
    }

    const best = candidates[0];
    return {
      ...step,
      page: pageName,
      element_id: best.element.id,
      element_name: best.element.name,
      selector: best.element.selector,
      match_score: best.score,
      confirmed: best.score >= 0.85,
      needs_confirmation: best.score < 0.85,
      candidates: candidates.slice(0, 3).map(({ element, score }) => ({
        element_id: element.id,
        element_name: element.name,
        selector: element.selector,
        score
      }))
    };
  });

  return { ...dsl, base_url: BASE_URL, steps };
}

function findPageNameByUrlValue(value) {
  const target = normalizeText(value);
  if (!target) return null;
  const match = Object.entries(pages).find(([, page]) => page.url.includes(target) || target.includes(page.url));
  return match ? match[0] : null;
}

function validateExecutableDsl(dsl) {
  const errors = [];
  for (const [index, step] of dsl.steps.entries()) {
    const label = `Step ${index + 1}`;
    if (step.action === "needs_clarification") errors.push(`${label}: ${step.reason}`);
    if (["input", "click", "assert_text", "assert_visible"].includes(step.action) && !step.selector) {
      errors.push(`${label}: ${step.action} 缺少 selector`);
    }
    if (["input", "assert_text"].includes(step.action) && !step.value) {
      errors.push(`${label}: ${step.action} 缺少 value`);
    }
    if (step.action === "open" && !step.url) errors.push(`${label}: open 缺少 url`);
  }
  return errors;
}

async function parseRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

async function serveStatic(req, res) {
  const url = new URL(req.url, BASE_URL);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;

  if (pathname === "/sample-app/login") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(loginPage());
    return;
  }

  if (pathname === "/sample-app/home") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(homePage());
    return;
  }

  const staticRoots = [
    { prefix: "/playwright-report", root: path.join(__dirname, "playwright-report") },
    { prefix: "/", root: path.join(__dirname, "public") }
  ];
  const match = staticRoots.find((root) => {
    if (root.prefix === "/") return true;
    return pathname === root.prefix || pathname.startsWith(`${root.prefix}/`);
  });
  const relativePath = match.prefix === "/" ? pathname : pathname.slice(match.prefix.length) || "/index.html";
  const filePath = path.join(match.root, relativePath === "/" ? "index.html" : relativePath);
  if (!filePath.startsWith(match.root) || !existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8"
  };
  res.writeHead(200, { "content-type": contentTypes[ext] || "application/octet-stream" });
  res.end(await readFile(filePath));
}

async function handleRun(req, res) {
  try {
    const body = await parseRequestBody(req);
    const caseText = normalizeText(body.caseText);
    if (!caseText) {
      await sendJson(res, 400, { ok: false, error: "请输入自然语言测试用例。" });
      return;
    }

    const parsed = await parseNaturalCase(caseText);
    const dsl = enrichWithElementLibrary(parsed);
    const validationErrors = validateExecutableDsl(dsl);
    if (validationErrors.length > 0) {
      await sendJson(res, 422, { ok: false, dsl, validationErrors });
      return;
    }

    await mkdir(path.join(__dirname, "generated"), { recursive: true });
    const caseFile = path.join(__dirname, "generated", "current-case.json");
    await writeFile(caseFile, JSON.stringify(dsl, null, 2), "utf8");

    const result = await runPlaywright(caseFile);
    await sendJson(res, result.exitCode === 0 ? 200 : 500, {
      ok: result.exitCode === 0,
      dsl,
      command: result.command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      reportUrl: `${BASE_URL}/playwright-report/index.html`
    });
  } catch (error) {
    await sendJson(res, 500, { ok: false, error: error.message });
  }
}

async function handleRunAgent(req, res) {
  try {
    const body = await parseRequestBody(req);
    const goal = normalizeText(body.caseText);
    if (!goal) {
      await sendJson(res, 400, { ok: false, error: "请输入自然语言任务。" });
      return;
    }
    if (!process.env.MINIMAX_API_KEY) {
      await sendJson(res, 422, { ok: false, error: "Agent模式需要先配置 MINIMAX_API_KEY。" });
      return;
    }

    await mkdir(path.join(__dirname, "generated"), { recursive: true });
    const runId = randomUUID();
    const agentCaseFile = path.join(__dirname, "generated", `agent-${runId}.json`);
    const agentResultFile = path.join(__dirname, "generated", `agent-${runId}-result.json`);
    await writeFile(agentCaseFile, JSON.stringify({ goal, runId }, null, 2), "utf8");

    const result = await runPlaywrightAgent(agentCaseFile, agentResultFile);
    const agentResult = existsSync(agentResultFile)
      ? JSON.parse(await readFile(agentResultFile, "utf8"))
      : { ok: false, history: [], error: "Agent result file was not created." };

    await sendJson(res, result.exitCode === 0 ? 200 : 500, {
      ...agentResult,
      ok: result.exitCode === 0 && agentResult.ok,
      command: result.command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      reportUrl: `${BASE_URL}/playwright-report/index.html`
    });
  } catch (error) {
    await sendJson(res, 500, { ok: false, error: error.message });
  }
}

async function handleRunBrowserUse(req, res) {
  try {
    const body = await parseRequestBody(req);
    const goal = normalizeText(body.caseText);
    if (!goal) {
      await sendJson(res, 400, { ok: false, error: "请输入自然语言任务。" });
      return;
    }

    await mkdir(path.join(__dirname, "generated"), { recursive: true });
    const runId = randomUUID();
    const browserUseCaseFile = path.join(__dirname, "generated", `browser-use-${runId}.json`);
    const browserUseResultFile = path.join(__dirname, "generated", `browser-use-${runId}-result.json`);
    await writeFile(browserUseCaseFile, JSON.stringify({ goal, runId }, null, 2), "utf8");

    const result = await runBrowserUse(browserUseCaseFile, browserUseResultFile);
    const browserUseResult = existsSync(browserUseResultFile)
      ? JSON.parse(await readFile(browserUseResultFile, "utf8"))
      : { ok: false, history: {}, error: "Browser Use result file was not created." };

    await sendJson(res, result.exitCode === 0 ? 200 : 500, {
      ...browserUseResult,
      ok: result.exitCode === 0 && browserUseResult.ok,
      command: result.command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    });
  } catch (error) {
    await sendJson(res, 500, { ok: false, mode: "browser-use", error: error.message });
  }
}

function runPlaywright(caseFile) {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = ["playwright", "test", "tests/dsl-runner.spec.js", "--project=chromium"];
  const env = { ...process.env, DSL_CASE_FILE: caseFile, BASE_URL };

  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: __dirname, env });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("close", (exitCode) => {
      resolve({ command: `${command} ${args.join(" ")}`, exitCode, stdout, stderr });
    });
  });
}

function runPlaywrightAgent(agentCaseFile, agentResultFile) {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = ["playwright", "test", "tests/agent-runner.spec.js", "--project=chromium"];
  const env = { ...process.env, AGENT_CASE_FILE: agentCaseFile, AGENT_RESULT_FILE: agentResultFile, BASE_URL };

  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: __dirname, env });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("close", (exitCode) => {
      resolve({ command: `${command} ${args.join(" ")}`, exitCode, stdout, stderr });
    });
  });
}

function runBrowserUse(caseFile, resultFile) {
  const projectPython = path.join(__dirname, ".venv", "bin", "python");
  const command = process.env.BROWSER_USE_PYTHON || (existsSync(projectPython) ? projectPython : "python3");
  const args = ["scripts/browser_use_runner.py", caseFile];
  const env = { ...process.env, BROWSER_USE_RESULT_FILE: resultFile };

  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: __dirname, env });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("close", (exitCode) => {
      resolve({ command: `${command} ${args.join(" ")}`, exitCode, stdout, stderr });
    });
  });
}

function loginPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Demo Login</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Arial, "PingFang SC", sans-serif; background: #f6f7fb; color: #1d2433; }
    main { width: min(420px, calc(100vw - 32px)); background: #fff; border: 1px solid #d9deea; border-radius: 8px; padding: 28px; box-shadow: 0 16px 40px rgba(20, 35, 60, .10); }
    h1 { margin: 0 0 20px; font-size: 24px; }
    label { display: grid; gap: 8px; margin: 14px 0; font-size: 14px; color: #3f4858; }
    input { height: 42px; border: 1px solid #cfd6e4; border-radius: 6px; padding: 0 12px; font-size: 15px; }
    button { width: 100%; height: 44px; border: 0; border-radius: 6px; background: #1456f0; color: #fff; font-size: 15px; font-weight: 700; cursor: pointer; margin-top: 12px; }
    .hint { color: #687386; font-size: 13px; line-height: 1.6; }
  </style>
</head>
<body>
  <main>
    <h1>测试登录页</h1>
    <p class="hint">Demo账号任意，密码任意。点击登录后进入首页。</p>
    <label>账号
      <input data-testid="login-username" autocomplete="username" placeholder="请输入账号" />
    </label>
    <label>密码
      <input data-testid="login-password" type="password" autocomplete="current-password" placeholder="请输入密码" />
    </label>
    <button data-testid="login-submit">登录</button>
  </main>
  <script>
    document.querySelector("[data-testid='login-submit']").addEventListener("click", () => {
      const username = document.querySelector("[data-testid='login-username']").value || "Jesse";
      localStorage.setItem("demo_username", username === "test001" ? "Jesse" : username);
      location.href = "/sample-app/home";
    });
  </script>
</body>
</html>`;
}

function homePage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Demo Home</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Arial, "PingFang SC", sans-serif; background: #eef5f1; color: #1d2a24; }
    main { width: min(560px, calc(100vw - 32px)); background: #fff; border: 1px solid #cfded5; border-radius: 8px; padding: 32px; }
    h1 { margin: 0 0 12px; font-size: 26px; }
    p { font-size: 17px; }
  </style>
</head>
<body>
  <main>
    <h1 data-testid="home-heading">首页</h1>
    <p>欢迎，<strong data-testid="home-username">Jesse</strong></p>
  </main>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  if (req.method === "POST" && url.pathname === "/api/run") {
    await handleRun(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/run-agent") {
    await handleRunAgent(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/run-browser-use") {
    await handleRunBrowserUse(req, res);
    return;
  }
  await serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Demo server listening on ${BASE_URL}`);
});
