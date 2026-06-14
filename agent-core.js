import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv();

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return;

  const raw = readFileSync(envPath, "utf8");
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

export function normalizeText(text) {
  return String(text || "").trim().replace(/\s+/g, " ");
}

export function buildMiniMaxRequest(prompt, systemContent) {
  const style = process.env.MINIMAX_API_STYLE || "openai";
  const model = process.env.MINIMAX_MODEL || "minimax-m3";
  const endpoint = buildMiniMaxEndpoint(style);
  const temperature = Number(process.env.MINIMAX_TEMPERATURE || 0.1);
  const maxTokens = Number(process.env.MINIMAX_MAX_TOKENS || 1400);
  const headers = buildMiniMaxHeaders();

  if (style === "minimax-cn") {
    const cnMessageStyle = process.env.MINIMAX_CN_MESSAGE_STYLE || "role";
    const messages =
      cnMessageStyle === "sender"
        ? [{ sender_type: "USER", sender_name: "用户", text: prompt }]
        : [
            { role: "system", content: systemContent },
            { role: "user", content: prompt }
          ];

    return {
      style,
      endpoint,
      headers,
      body: {
        model,
        tokens_to_generate: maxTokens,
        max_tokens: maxTokens,
        temperature,
        messages
      }
    };
  }

  return {
    style,
    endpoint,
    headers,
    body: {
      model,
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: prompt }
      ],
      temperature,
      max_tokens: maxTokens
    }
  };
}

export function parseMiniMaxResponseBody(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const dataPayloads = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]");

    for (const data of dataPayloads.toReversed()) {
      try {
        return JSON.parse(data);
      } catch {
        // Keep trying older chunks.
      }
    }

    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        // Fall through to the clearer error below.
      }
    }

    throw new Error(`MiniMax response is not JSON: ${raw.slice(0, 300) || error.message}`);
  }
}

export function extractChatContent(payload) {
  const content =
    payload?.choices?.[0]?.message?.content ??
    payload?.choices?.[0]?.text ??
    payload?.reply ??
    payload?.data?.reply ??
    payload?.data?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content;
  throw new Error(`MiniMax response has no message content: ${JSON.stringify(payload).slice(0, 500)}`);
}

export function extractJsonObject(content) {
  const cleaned = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const jsonText = extractFirstBalancedJson(cleaned);
    if (!jsonText) {
      throw new Error(`MiniMax did not return JSON: ${content.slice(0, 500)}`);
    }
    return JSON.parse(jsonText);
  }
}

export async function runBrowserAgentOnPage(page, goal, options = {}) {
  const maxSteps = Number(options.maxSteps || process.env.AGENT_MAX_STEPS || 0);
  const hasStepLimit = Number.isFinite(maxSteps) && maxSteps > 0;
  const history = [];
  const onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : async () => {};

  for (let stepIndex = 0; !hasStepLimit || stepIndex < maxSteps; stepIndex += 1) {
    const observation = await observePage(page);
    const decision = await decideNextAgentAction(goal, observation, history, stepIndex, hasStepLimit ? maxSteps : null);
    const normalized = normalizeAgentDecision(decision);

    if (normalized.action === "finish") {
      history.push({ step: stepIndex + 1, decision: normalized, observation: summarizeObservation(observation) });
      await onUpdate({ ok: true, mode: "agent", source: "minimax-m3-agent", goal, finalUrl: page.url(), history });
      return {
        ok: true,
        mode: "agent",
        source: "minimax-m3-agent",
        goal,
        finalUrl: page.url(),
        history,
        summary: normalized.reason || "Agent finished."
      };
    }

    if (normalized.action === "fail") {
      history.push({ step: stepIndex + 1, decision: normalized, observation: summarizeObservation(observation) });
      await onUpdate({ ok: false, mode: "agent", source: "minimax-m3-agent", goal, finalUrl: page.url(), history });
      return {
        ok: false,
        mode: "agent",
        source: "minimax-m3-agent",
        goal,
        finalUrl: page.url(),
        history,
        error: normalized.reason || "Agent reported failure."
      };
    }

    const execution = await executeAgentAction(page, normalized, observation);
    history.push({
      step: stepIndex + 1,
      decision: normalized,
      execution,
      observation: summarizeObservation(observation)
    });
    await onUpdate({ ok: false, mode: "agent", source: "minimax-m3-agent", goal, finalUrl: page.url(), history });
    await page.waitForTimeout(Number(process.env.AGENT_STEP_DELAY_MS || 700));
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  }

  return {
    ok: false,
    mode: "agent",
    source: "minimax-m3-agent",
    goal,
    finalUrl: page.url(),
    history,
    error: `Agent reached max steps (${maxSteps}).`
  };
}

export async function observePage(page) {
  const raw = await page.evaluate(() => {
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };

    const cssEscape = (value) => {
      if (window.CSS?.escape) return window.CSS.escape(value);
      return String(value).replace(/["\\#.;?+*~':!^$[\]()=>|/@]/g, "\\$&");
    };

    const selectorFor = (element) => {
      if (element.id) return `#${cssEscape(element.id)}`;
      const testId = element.getAttribute("data-testid") || element.getAttribute("data-test");
      if (testId) return `[data-testid="${cssEscape(testId)}"],[data-test="${cssEscape(testId)}"]`;
      const name = element.getAttribute("name");
      if (name) return `${element.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
      const placeholder = element.getAttribute("placeholder");
      if (placeholder) return `${element.tagName.toLowerCase()}[placeholder="${cssEscape(placeholder)}"]`;

      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body && parts.length < 5) {
        const tag = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (!parent) break;
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        const index = siblings.indexOf(current) + 1;
        parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
        current = parent;
      }
      return parts.join(" > ");
    };

    const textOf = (element) =>
      (element.innerText || element.value || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);

    const elements = Array.from(
      document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]')
    )
      .filter(isVisible)
      .slice(0, 45)
      .map((element, index) => ({
        ref: `e${index + 1}`,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || "",
        type: element.getAttribute("type") || "",
        text: textOf(element),
        ariaLabel: element.getAttribute("aria-label") || "",
        placeholder: element.getAttribute("placeholder") || "",
        selector: selectorFor(element)
      }));

    const visibleText = (document.body?.innerText || "")
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 35);

    return {
      url: location.href,
      title: document.title,
      visibleText,
      interactives: elements
    };
  });

  return {
    url: raw.url,
    title: raw.title,
    visibleText: raw.visibleText,
    interactives: raw.interactives
  };
}

export function summarizeObservation(observation) {
  return {
    url: observation.url,
    title: observation.title,
    visibleText: observation.visibleText.slice(0, 8),
    interactives: observation.interactives.slice(0, 12).map((item) => ({
      ref: item.ref,
      tag: item.tag,
      type: item.type,
      text: item.text,
      placeholder: item.placeholder
    }))
  };
}

export function normalizeAgentDecision(decision) {
  const safeActions = new Set(["goto", "fill", "click", "press", "wait", "scroll", "assert_text", "finish", "fail"]);
  const action = safeActions.has(decision?.action) ? decision.action : "fail";
  return {
    action,
    ...(decision?.ref ? { ref: normalizeText(decision.ref) } : {}),
    ...(decision?.url ? { url: normalizeText(decision.url) } : {}),
    ...(decision?.value !== undefined ? { value: String(decision.value) } : {}),
    ...(decision?.key ? { key: normalizeText(decision.key) } : {}),
    ...(decision?.reason ? { reason: normalizeText(decision.reason) } : {})
  };
}

export async function executeAgentAction(page, decision, observation) {
  if (decision.action === "goto") {
    const url = normalizeAgentUrl(decision.url);
    assertAllowedAgentUrl(url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    return { result: "navigated", url: page.url() };
  }

  if (decision.action === "wait") {
    await page.waitForTimeout(1200);
    return { result: "waited" };
  }

  if (decision.action === "scroll") {
    await page.mouse.wheel(0, Number(decision.value || 650));
    return { result: "scrolled" };
  }

  if (decision.action === "assert_text") {
    const text = await page.locator("body").innerText({ timeout: 5000 });
    if (!text.includes(decision.value || "")) {
      throw new Error(`assert_text failed: ${decision.value}`);
    }
    return { result: "asserted_text" };
  }

  const target = observation.interactives.find((item) => item.ref === decision.ref);
  if (!target) {
    throw new Error(`Agent selected unknown ref: ${decision.ref}`);
  }
  const locator = page.locator(target.selector).first();

  if (decision.action === "fill") {
    await locator.fill(decision.value || "", { timeout: 8000 });
    return { result: "filled", ref: decision.ref, selector: target.selector };
  }

  if (decision.action === "click") {
    await locator.click({ timeout: 8000 });
    return { result: "clicked", ref: decision.ref, selector: target.selector };
  }

  if (decision.action === "press") {
    await locator.press(decision.key || "Enter", { timeout: 8000 });
    return { result: "pressed", ref: decision.ref, key: decision.key || "Enter", selector: target.selector };
  }

  throw new Error(`Unsupported agent action: ${decision.action}`);
}

export function buildAgentPrompt(goal, observation, history, stepIndex, maxSteps) {
  const compactHistory = history.slice(-6).map((item) => ({
    step: item.step,
    action: item.decision?.action,
    ref: item.decision?.ref,
    value: item.decision?.value,
    url: item.execution?.url,
    result: item.execution?.result || item.decision?.reason
  }));

  return `你需要通过浏览器完成用户目标。请根据当前页面观察结果，决定下一步动作。

用户目标：
${goal}

当前步数：${maxSteps ? `${stepIndex + 1}/${maxSteps}` : `${stepIndex + 1}/无限制`}

安全规则：
1. 只能输出一个 JSON 对象。
2. 只能使用 action: goto, fill, click, press, wait, scroll, assert_text, finish, fail。
3. click/fill/press 必须从 observation.interactives 中选择 ref，不要自己编 selector。
4. goto 只能访问与任务相关的公网 HTTPS 网站或本地 http://127.0.0.1。
5. 不要执行登录、支付、删除、发消息、下载文件等敏感操作。
6. 如果目标已完成，输出 finish。
7. 如果无法继续，输出 fail 并说明 reason。
8. 如果用户说“打开百度”，goto 使用 https://www.baidu.com；如果用户说“打开必应”或“打开bing”，goto 使用 https://www.bing.com。

输出格式示例：
{"action":"goto","url":"https://www.baidu.com","reason":"打开百度首页"}
{"action":"fill","ref":"e1","value":"上海的天气情况","reason":"在搜索框输入查询词"}
{"action":"click","ref":"e2","reason":"点击搜索按钮"}
{"action":"click","ref":"e7","reason":"点击第一个搜索结果"}
{"action":"finish","reason":"第一个搜索结果已打开"}

历史动作：
${JSON.stringify(compactHistory, null, 2)}

当前页面观察：
${JSON.stringify(observation, null, 2)}`;
}

async function decideNextAgentAction(goal, observation, history, stepIndex, maxSteps) {
  const prompt = buildAgentPrompt(goal, observation, history, stepIndex, maxSteps);
  const request = buildMiniMaxRequest(
    prompt,
    "你是一个受限的浏览器自动化 Agent。你只能输出合法 JSON，不输出 Markdown 或解释。你必须遵守动作白名单和安全边界。"
  );
  const response = await fetch(request.endpoint, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body)
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`MiniMax agent request failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
  }
  const payload = parseMiniMaxResponseBody(raw);
  const content = extractChatContent(payload);
  return extractJsonObject(content);
}

function buildMiniMaxEndpoint(style) {
  if (process.env.MINIMAX_ENDPOINT) {
    return appendGroupIdIfNeeded(process.env.MINIMAX_ENDPOINT);
  }

  const defaultBaseUrl = style === "minimax-cn" ? "https://api.minimax.chat/v1" : "https://api.minimax.io/v1";
  const defaultChatPath = style === "minimax-cn" ? "/text/chatcompletion_v2" : "/chat/completions";
  const baseUrl = (process.env.MINIMAX_BASE_URL || defaultBaseUrl).replace(/\/$/, "");
  const chatPath = process.env.MINIMAX_CHAT_PATH || defaultChatPath;
  return appendGroupIdIfNeeded(`${baseUrl}${chatPath.startsWith("/") ? chatPath : `/${chatPath}`}`);
}

function appendGroupIdIfNeeded(endpoint) {
  const groupId = process.env.MINIMAX_GROUP_ID;
  if (!groupId || groupId === "your_group_id") return endpoint;
  const url = new URL(endpoint);
  if (!url.searchParams.has("GroupId")) url.searchParams.set("GroupId", groupId);
  return url.toString();
}

function buildMiniMaxHeaders() {
  const headerName = process.env.MINIMAX_AUTH_HEADER || "Authorization";
  const authPrefix = process.env.MINIMAX_AUTH_PREFIX ?? "Bearer";
  const authValue = authPrefix ? `${authPrefix} ${process.env.MINIMAX_API_KEY}` : process.env.MINIMAX_API_KEY;
  return {
    "content-type": "application/json",
    [headerName]: authValue
  };
}

function normalizeAgentUrl(url) {
  const value = normalizeText(url);
  if (!value) throw new Error("goto action missing url");
  if (/^https?:\/\//i.test(value)) return value;
  if (value.includes("百度")) return "https://www.baidu.com";
  if (/必应|bing/i.test(value)) return "https://www.bing.com";
  return `https://${value}`;
}

function assertAllowedAgentUrl(url) {
  const parsed = new URL(url);
  const allowedHostsSetting = process.env.AGENT_ALLOWED_HOSTS || "*";
  if (allowedHostsSetting === "*" || allowedHostsSetting.toLowerCase() === "all") return;

  const allowedHosts = allowedHostsSetting
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  const isAllowed = allowedHosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  if (!isAllowed) {
    throw new Error(`Agent navigation blocked by allowed hosts: ${parsed.hostname}`);
  }
}

function extractFirstBalancedJson(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return null;
}
