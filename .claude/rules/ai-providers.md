---
paths:
  - "scripts/ai-providers-source.mjs"
  - "scripts/sync-ai-providers.mjs"
  - "ai.js"
  - "shared.js"
  - "popup-ai.js"
  - "options.html"
  - "options.js"
  - "options-connectivity.js"
---

# AI provider 深水区：单一事实源与关思考（thinking/reasoning）方言

**18 家内置 provider 的单一事实源在 `scripts/ai-providers-source.mjs`**：新增 provider、修改默认模型、默认端点、支持页面、地域或协议字段时，只改 `scripts/ai-providers-source.mjs`，随后运行 `node scripts/sync-ai-providers.mjs --write` 生成 `ai.js`、`shared.js`、`popup-ai.js`、`options.html`、`options.js`、`options-connectivity.js` 中所有 `@generated:ai-providers` 区块并同步 `options.html` 输入框 `value=` 属性，再用 `node scripts/sync-ai-providers.mjs --check` 校验零漂移且根目录运行时脚本无第二份手写副本（由 pre-commit、UI 契约测试与 `verify.sh` 静态门强制把关）。不要手工编辑 `@generated:ai-providers` 区块，也不要在运行时脚本里手写平行的 provider 数组或默认模型字面量。

**勿凭记忆改 provider 表**——model 字段是自由文本，blanket 关思考字段会打到用户切换后的不兼容模型（400/422）。机制：`ai.js` 的 `OPENAI_COMPAT_PROVIDERS` 每家用 per-provider `thinkingOff` 方言字段（非 always-on `extraBody`），经 `_aiWithDialectFallback` 仅在 400/422 明确指出该思考参数不支持时调整字段 + `storage.local` 记忆。

已核验字段表（2026-06-25 逐家官方 doc + 真实 400 issue 佐证；字段都在 top-level body）：

| provider | 关思考字段 |
|---|---|
| zhipu / moonshot(kimi) | `{"thinking":{"type":"disabled"}}` |
| minimax | 先传 `{"thinking":{"type":"disabled"}}`；服务端拒绝后才尝试 `{"reasoning_effort":"low"}`，避免强制思考模型退回默认的最高强度。是否回退由服务端响应与能力记忆决定，不按模型名写名单 |
| siliconflow / qwen（阿里云百炼，四个地域及业务空间专属地址同一方言，核实结论与链接见注） | `{"enable_thinking":false}` |
| openai / mistral / cohere | `{"reasoning_effort":"none"}`（flat，非 Responses 的 nested；cohere compat 端点仅 none/high） |
| openrouter | `{"reasoning":{"enabled":false}}`（勿用 exclude，仍计费） |
| gemini | bespoke：`thinkingConfig.thinkingBudget:0` |
| deepseek | thinkingOff（deepseek-reasoner 会拒收，靠 4xx 回退兜住） |
| groq / custom / ollama | 默认不加 thinkingOff；兼容协议的任务级低思考偏好见后文，Ollama 不发送该字段 |
| ark（火山方舟，国内与 BytePlus 海外两个地域同一方言） | `{"thinking":{"type":"disabled"}}`，2026-10-28 按官方原文核实，见注 |
| opencode / commandcode（转发网关） | 不加 thinkingOff：上游模型各异。Anthropic 格式走 Messages 调用器，不请求 extended thinking |

百炼地域与业务空间（2026-10-28 按阿里云官方文档核实）：[Base URL 总览](https://help.aliyun.com/zh/model-studio/base-url) 的「DashScope 域名」表把 OpenAI 兼容地址列为北京 `https://dashscope.aliyuncs.com/compatible-mode/v1`、新加坡 `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`、美国（弗吉尼亚）`https://dashscope-us.aliyuncs.com/compatible-mode/v1`，日本（东京）不在该表；[地域与接入域名](https://help.aliyun.com/zh/model-studio/regions) 表中东京的 DashScope 域名为「不支持」，四地的业务空间专属域名均为 `{WorkspaceId}.{地域 ID}.maas.aliyuncs.com`（cn-beijing / ap-southeast-1 / us-east-1 / ap-northeast-1）。因此注册表 `regions.tokyo` 为 `""`（必须填业务空间 ID），弗吉尼亚用 dashscope-us。业务空间 ID 官方示例为 `llm-7c72iiw36kd8****`（[业务空间管理](https://docs.modelstudio.console.alibabacloud.com/zh/model-studio/use-workspace)），小写字母数字加连字符，满足 `pbpAiWorkspaceIdOk` 的 DNS 标签规则，不放宽。[深度思考](https://help.aliyun.com/zh/model-studio/deep-thinking/) 页按模型说明 `enable_thinking`（混合思考模型可关、仅思考模型无法关闭），未按地域区分，故保留 provider 级 `thinkingOff`，由 `_aiWithDialectFallback` 按精确 endpoint 隔离 400 自愈，不写地域分支。地域与 ID 的解析规则见 `ai.js` 注册表表头与 `pbpAiEndpointProblem`：表外或空地域、东京缺 ID、ID 非法一律 `endpoint_invalid`，不回落北京。

火山方舟（2026-10-28 按官方文档核实）：[深度思考](https://www.volcengine.com/docs/82379/1449737)「开启/关闭深度思考」节原文为「提供 **thinking** 字段控制是否关闭深度思考能力」「`disabled`：强制关闭深度思考能力」，OpenAI SDK 示例以 `extra_body={"thinking": {"type": "disabled"}}` 发在请求体顶层；[兼容 OpenAI SDK](https://www.volcengine.com/docs/82379/1330626) 同样示例。该页按模型列出支持情况（多数 doubao-seed / deepseek 型号支持 `disabled`，`glm-5-3-flash-260828` 注明「始终启用思考，不再支持禁用思考」），由 `_aiWithDialectFallback` 的 400/422 自愈兜住，不写模型名单。两个地域（`ark.cn-beijing.volces.com` / BytePlus `ark.ap-southeast.bytepluses.com`）是两套账号，Key 与模型 ID 不通用（BytePlus 的同档模型 ID 为 `seed-2-0-mini-260428` 一类，不带 `doubao-` 前缀），只靠设置页提示，不按地域改默认模型。BytePlus 另有 `eu-west-1`（`ark.eu-west.bytepluses.com`），本次未接入。OpenCode Zen（[Zen 文档](https://opencode.ai/docs/en/zen/)：`/inference/openai/v1/chat/completions` 与 `/inference/anthropic/v1/messages`）与 Command Code（[Provider API](https://commandcode.ai/docs/provider-api)：`https://api.commandcode.ai/provider/v1`，`/messages` 接受 `x-api-key`）由用户在设置里选格式；OpenCode 文档的示例只有 Bearer，`/messages` 是否接受 `x-api-key` 待授权后的真实测试核对，若只认 Bearer 再在注册项上按供应商声明认证方式。三家均未查到官方状态页，不加 `PBP_AI_STATUS_PAGES`。

MiniMax 的说明于 2026-10-25 按[官方 OpenAI 兼容接口文档](https://platform.minimax.cn/docs/api-reference/text-openai-api)复核：M3 支持关闭思考，M3.1-Flash 强制开启，默认思考强度为 `max`。这些型号用于说明能力差异，运行时仍只依据服务端拒绝决定方言。若 `low` 也被 400/422 拒绝，再剥离该字段；明确点名 `reasoning_effort` 不支持时立即记入现有按 provider/model 隔离的 `pbpAiParamFix`，泛 4xx 不触发参数剥离或重试。参数名修复仍优先，思考、强度及参数修复合计最多四次实际请求，每次重过 `beforeRequest`；401/402/429/5xx、取消、空正文或输出截断不得触发额外请求。已解析的 HTTP 2xx 配合固定的空正文/截断错误码可证明方言被接受，普通无状态异常不可以。

同一个包装器还管请求体参数方言（K133）：输出上限字段名是 per-provider 列 `tokenField`（openai = `max_completion_tokens`，其余留空即 `max_tokens`），`temperature` 则**不声明**——它在单一 provider 内逐模型变化（gpt-5 家族只接受默认值 1），只在服务端 400 点名后剥掉。两种修复都从服务端自己的 `error.param` / 报文里读（`handleAIError` 挂 `err.paramHint`），按版本、provider、精确 endpoint 与 model 隔离并保留 7 天，记在 `storage.local` 的 `pbpAiParamFix`，**绝不做按 model id 的静态 allowlist**。Anthropic 的 `callAnthropicMessages` / `_streamAnthropicMessages` 用的 `max_tokens` 是 Messages API 必填字段，语义不同，永远不参与改名。这两个函数由内置 Claude 与 Anthropic 格式端点共用：base 含版本段，拼接 `/messages`，只发 `x-api-key`，不发 Bearer；`callAI` / `callAIStream` 按解析出的 `target.protocol` 派发，`target.error` 非空时在任何请求之前抛错。

改动后用 options 页联通性测试（options-connectivity.js）逐家验证；出现 400 先读服务端指向的参数；不得把任意 400 推断为思考字段不兼容。

新增 provider、改默认端点或新增任何数据出口 → privacy.md 的 Network Requests / Permissions / Third-Party 三处必须同步披露（release.sh 文档硬门会拦，host 权限铁律见根文件）。

> 公共响应契约（非流式与流式）、按任务声明输出要求与能力记录边界自 2026-11-05 起在 `ai-response.md`（paths：ai.js、dict-entry.js）。

## popup AI 调用代理（自根 CLAUDE.md 目录结构迁来）

background.js 是 popup AI 调用代理（PBP_AI_CALL → pbpRunPopupAiCall，两道 getCurrentBookmarkAuth 门，覆盖白名单 PBP_AI_OVERRIDE_FIELDS 在 shared.js）。
