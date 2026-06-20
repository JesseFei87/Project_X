# Natural Language Playwright Demo

这个 demo 演示：

```text
自然语言测试用例 -> MiniMax-M3 转 DSL -> 元素库匹配 selector -> Playwright CLI 执行
```

## 启动

```bash
npm install
npx playwright install chromium
npm run dev
```

打开：

```text
http://127.0.0.1:3000
```

## 接入 MiniMax-M3

复制环境变量示例：

```bash
cp .env.example .env
```

填写你的 MiniMax 配置：

```bash
MINIMAX_API_KEY=your_minimax_api_key
MINIMAX_MODEL=minimax-m3
MINIMAX_API_STYLE=minimax-cn
MINIMAX_ENDPOINT=https://api.minimax.chat/v1/text/chatcompletion_v2?GroupId=your_group_id
MINIMAX_TEMPERATURE=0.1
MINIMAX_MAX_TOKENS=1400
```

国内 Token Plan 地址可能和国际版不同，优先使用控制台给你的完整 URL：

```bash
MINIMAX_ENDPOINT=https://api.minimax.chat/v1/text/chatcompletion_v2?GroupId=your_group_id
```

如果控制台只给 base URL 和 GroupId，也可以拆开填：

```bash
MINIMAX_BASE_URL=https://api.minimax.chat/v1
MINIMAX_CHAT_PATH=/text/chatcompletion_v2
MINIMAX_GROUP_ID=your_group_id
```

如果你的国内版接口是 OpenAI-compatible，再改成：

```bash
MINIMAX_API_STYLE=openai
MINIMAX_ENDPOINT=https://你的实际地址/chat/completions
```

然后重启服务：

```bash
npm run dev
```

有 `MINIMAX_API_KEY` 时，`server.js` 会调用 MiniMax-M3 生成 DSL；没有 key 或调用失败时，会回退到本地规则解析器。

## 关键代码

- `parseNaturalCase()`：选择 MiniMax-M3 或本地 fallback
- `parseNaturalCaseWithMiniMax()`：调用 MiniMax-M3 的 `/chat/completions`
- `buildDslPrompt()`：约束模型只输出平台 DSL
- `enrichWithElementLibrary()`：把业务元素名匹配成 selector
- `tests/dsl-runner.spec.js`：Playwright DSL 执行器

## AI自由浏览器智能体模式

页面左侧可以切换：

```text
DSL模式：MiniMax 一次性生成 DSL，元素库匹配后调用 Playwright CLI。
Agent模式：MiniMax 每一步根据页面观察结果决策，Playwright 直接执行浏览器动作。
```

Agent 模式相关配置：

```bash
AGENT_HEADLESS=true
AGENT_ALLOWED_HOSTS=*
AGENT_STEP_DELAY_MS=700
AGENT_MINIMAX_MAX_TOKENS=4096
```

Agent 动作白名单：

```text
goto, fill, click, press, wait, scroll, assert_text, finish, fail
```

为了安全，`click/fill/press` 只能选择当前页面观察到的 `ref`，不能让模型凭空编 selector。

如果报告里出现 `MiniMax response was truncated before JSON content was produced` 或 `finish_reason:"length"`，说明 MiniMax-M3 的输出 token 不够，动作 JSON 还没生成就被截断了。优先调高 `.env` 里的 `AGENT_MINIMAX_MAX_TOKENS`。

如果需要限制 Agent 只能访问指定域名，把 `AGENT_ALLOWED_HOSTS=*` 改成逗号分隔的域名列表：

```bash
AGENT_ALLOWED_HOSTS=example.com,www.example.com,127.0.0.1,localhost
```

## Browser Use 实验性对照

页面左侧还有 `Browser Use` 模式。它通过 Python 版 Browser Use 执行同一类浏览器 Agent 任务，用于和当前自研 Agent 对照。

建议按 Browser Use 官方方式创建 Python 3.12 虚拟环境：

```bash
pip install uv
uv venv --python 3.12
source .venv/bin/activate
uv pip install -r requirements-browser-use.txt
uvx browser-use install
```

然后在 `.env` 指定 runner 使用这个虚拟环境：

```bash
BROWSER_USE_PYTHON=.venv/bin/python
```

注意：Browser Use 官方建议 Python 3.12。macOS 系统自带 Python 3.9 通常不够。

Browser Use 的 OpenAI-compatible 配置：

```bash
BROWSER_USE_MODEL=minimax-m3
BROWSER_USE_API_KEY=your_openai_compatible_key
BROWSER_USE_BASE_URL=https://your-openai-compatible-base-url/v1
```

如果不配置 `BROWSER_USE_API_KEY` / `BROWSER_USE_BASE_URL`，runner 会尝试复用：

```bash
MINIMAX_API_KEY
MINIMAX_BASE_URL
```

但如果你的 MiniMax 国内 Token Plan 是 `/text/chatcompletion_v2`，它可能不是 OpenAI-compatible，Browser Use 可能无法直接调用。

当前 demo 已针对 MiniMax-M3 做了三处兼容处理：

- 默认使用项目内 `.venv/bin/python`。
- 默认 `BROWSER_USE_VISION=false`，避免 MiniMax 国内接口拒绝 Browser Use 的视觉参数。
- 对 MiniMax-M3 返回的 `<think>...</think>` 做剥离，并提取动作 JSON 后再交给 Browser Use 校验。

本地验证通过的最小任务：

```text
请访问以下网址并判断页面标题是否为测试登录页。网址是 http://127.0.0.1:3000/sample-app/login
```

验证结果：Browser Use 能通过 MiniMax-M3 打开本地页面并返回 `done`。

## Agent Browser 第四模式

页面左侧新增 `Agent Browser` 模式。它不走 Playwright test，也不走 Browser Use，而是：

```text
自然语言任务 -> MiniMax-M3 生成受限执行计划 -> agent-browser CLI 执行浏览器动作 -> 当前页面聚合结构化报告
```

这个模式的职责边界：

- 自然语言理解：当前 Node 服务 + MiniMax-M3
- 浏览器执行：`agent-browser` CLI
- 报告展示：当前 Web 页面右侧结果面板

安装依赖：

```bash
npm install agent-browser
agent-browser install
```

如果你用 Homebrew，也可以：

```bash
brew install agent-browser
agent-browser install
```

如果不是全局安装，可以通过 `.env` 指定可执行文件：

```bash
AGENT_BROWSER_BIN=/absolute/path/to/agent-browser
AGENT_BROWSER_MINIMAX_MAX_TOKENS=2400
AGENT_BROWSER_COMMAND_TIMEOUT_MS=30000
AGENT_BROWSER_OPEN_WAIT_UNTIL=load
AGENT_BROWSER_STEP_WAIT_VALUE=load
```

第四模式当前支持的动作：

```text
open, fill, click, press, wait, assert_text, assert_url_contains
```

定位优先级：

```text
label / text / role / placeholder / testid / selector
```

注意：

- 该模式不复用 Playwright HTML Report，右侧面板展示的是结构化步骤报告。
- 当前 v1 采用“执行器模式”，没有接 `agent-browser chat`。
- 如果本机没有安装 `agent-browser`，接口会直接返回明确报错，不做降级补偿。
- 公网页面如果长期加载资源，`networkidle` 可能卡住；默认打开页面后的等待策略已改为 `load`，仍可通过 `.env` 覆盖。
- 模型如果生成显式 `wait: networkidle`，当前实现也会按 `AGENT_BROWSER_STEP_WAIT_VALUE` 归一化，默认同样使用 `load`。
- 当前实现沿用 `agent-browser` 默认的 `~/.agent-browser` daemon/state 目录，因为受控目录下的本地 socket 绑定会失败。
