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
```

Agent 动作白名单：

```text
goto, fill, click, press, wait, scroll, assert_text, finish, fail
```

为了安全，`click/fill/press` 只能选择当前页面观察到的 `ref`，不能让模型凭空编 selector。

如果需要限制 Agent 只能访问指定域名，把 `AGENT_ALLOWED_HOSTS=*` 改成逗号分隔的域名列表：

```bash
AGENT_ALLOWED_HOSTS=example.com,www.example.com,127.0.0.1,localhost
```
