---
paths:
  - "ai.js"
  - "popup-ai.js"
  - "options-connectivity.js"
---

# AI provider 深水区：关思考（thinking/reasoning）方言

**勿凭记忆改 provider 表**——model 字段是自由文本，blanket 关思考字段会打到用户切换后的不兼容模型（400/422）。机制：`ai.js` 的 `OPENAI_COMPAT_PROVIDERS` 每家用 per-provider `thinkingOff` 方言字段（非 always-on `extraBody`），经 `_aiWithDialectFallback` 仅在 400/422 明确指出该思考参数不支持时调整字段 + `storage.local` 记忆。

已核验字段表（2026-06-25 逐家官方 doc + 真实 400 issue 佐证；字段都在 top-level body）：

| provider | 关思考字段 |
|---|---|
| zhipu / moonshot(kimi) | `{"thinking":{"type":"disabled"}}` |
| minimax | 先传 `{"thinking":{"type":"disabled"}}`；服务端拒绝后才尝试 `{"reasoning_effort":"low"}`，避免强制思考模型退回默认的最高强度。是否回退由服务端响应与能力记忆决定，不按模型名写名单 |
| siliconflow / qwen | `{"enable_thinking":false}` |
| openai / mistral / cohere | `{"reasoning_effort":"none"}`（flat，非 Responses 的 nested；cohere compat 端点仅 none/high） |
| openrouter | `{"reasoning":{"enabled":false}}`（勿用 exclude，仍计费） |
| gemini | bespoke：`thinkingConfig.thinkingBudget:0` |
| deepseek | thinkingOff（deepseek-reasoner 会拒收，靠 4xx 回退兜住） |
| groq / custom / ollama | 默认不加 thinkingOff；兼容协议的任务级低思考偏好见后文，Ollama 不发送该字段 |

MiniMax 的说明于 2026-10-25 按[官方 OpenAI 兼容接口文档](https://platform.minimax.cn/docs/api-reference/text-openai-api)复核：M3 支持关闭思考，M3.1-Flash 强制开启，默认思考强度为 `max`。这些型号用于说明能力差异，运行时仍只依据服务端拒绝决定方言。若 `low` 也被 400/422 拒绝，再剥离该字段；明确点名 `reasoning_effort` 不支持时立即记入现有按 provider/model 隔离的 `pbpAiParamFix`，泛 4xx 不触发参数剥离或重试。参数名修复仍优先，思考、强度及参数修复合计最多四次实际请求，每次重过 `beforeRequest`；401/402/429/5xx、取消、空正文或输出截断不得触发额外请求。已解析的 HTTP 2xx 配合固定的空正文/截断错误码可证明方言被接受，普通无状态异常不可以。

同一个包装器还管请求体参数方言（K133）：输出上限字段名是 per-provider 列 `tokenField`（openai = `max_completion_tokens`，其余留空即 `max_tokens`），`temperature` 则**不声明**——它在单一 provider 内逐模型变化（gpt-5 家族只接受默认值 1），只在服务端 400 点名后剥掉。两种修复都从服务端自己的 `error.param` / 报文里读（`handleAIError` 挂 `err.paramHint`），按版本、provider、精确 endpoint 与 model 隔离并保留 7 天，记在 `storage.local` 的 `pbpAiParamFix`，**绝不做按 model id 的静态 allowlist**。Anthropic 的 `callClaude` / `_streamClaude` 用的 `max_tokens` 是 Messages API 必填字段，语义不同，永远不参与改名。

改动后用 options 页联通性测试（options-connectivity.js）逐家验证；出现 400 先读服务端指向的参数；不得把任意 400 推断为思考字段不兼容。

新增 provider、改默认端点或新增任何数据出口 → privacy.md 的 Network Requests / Permissions / Third-Party 三处必须同步披露（release.sh 文档硬门会拦，host 权限铁律见根文件）。

## 公共非流式响应契约

OpenAI 兼容、Gemini、Claude、Ollama 只在协议适配层读取正文块与完成状态，再走同一完整性检查。排除思考、工具和拒答内容；区分空正文、未完成、拒答、坏 JSON 与坏响应结构。`requireComplete:true` 的词典生成不接受明确未完成的输出，即使其中 JSON 恰好闭合；其他消费者仍可使用非空部分文本。兼容端点缺少终止元数据时保留 unknown，不伪称确认完成，也不凭此拒绝有效正文。

新增模型不应要求词典业务层添加供应商或模型分支。通用响应修复用四协议独立手写 HTTP 夹具和生成→归档→重读链路验证；响应失败不自动增加付费重试。真实 API 测试仍须按 CLAUDE.md 逐轮取得明确授权，历史授权不续用。

## 按任务声明输出要求（2026-10-26）

词典生成统一声明 `requireComplete`、180 秒超时、8192 总输出额度、低思考偏好及闭合字段 JSON Schema，不按模型名选择业务策略。180 秒是 2026-10-26 用户裁决（原 60 秒会截断仍在生成的慢模型），所有模型同一期限、不设按模型分支；`_aiCompletionTimeout` 只接受 1–180 秒，超出范围回落 30 秒默认值。8192 是上限，不要求模型用满；每类提示词仍限制条数和长度。其他消费者保留原有默认额度与超时。支持取消与派发前账号守卫，不因超时、空正文、截断或坏 JSON 自动重生成。

- `totalOutputBudget` 在 OpenAI 兼容协议优先发送 `max_completion_tokens`，只有服务端明确拒绝字段时按既有机制回退。`max_tokens` 在部分接口只限制最终答案，不能普遍当作含思考总量保证；真实测试必须另核对回传用量并停机。
- 已声明的原生思考字段不变；未知兼容端点收到任务的 `minimum` 偏好时先尝试 `reasoning_effort:none`，仅在明确拒绝后降为 `low`；旧 `low` 请求保持兼容，不修改 provider 注册表或创建模型名单。
- 结构要求由适配器转换：OpenAI 原生端点使用 `response_format.json_schema`；未知兼容端点先用通用 JSON object，不假设支持 Schema；Gemini `generationConfig.responseJsonSchema` 配合 JSON MIME；Ollama `format` 对象。Claude 保持提示词及严格解析，不发送其他协议的字段。
- 兼容服务端明确以 400/422 拒绝 `response_format` 时，依次降到 JSON object、无格式字段，记忆能力；包括明确点名格式的 unknown variant / 类型枚举拒绝，不把 schema 内容错误或数值越界当成能力拒绝。与 token、temperature 和思考字段修复共用四次总上限，每次执行 `beforeRequest`。成功 HTTP 的坏内容不触发回退。结构约束只是生成引导，解析、语言、引用及归档校验不能跳过；有效 JSON 也不等于完整、正确的解释。

依据：[LiteLLM JSON schema](https://docs.litellm.ai/docs/completion/json_mode)、[Qwen 结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output)、[Qwen 思考与输出上限](https://help.aliyun.com/zh/model-studio/deep-thinking/)、[Gemini GenerateContent](https://ai.google.dev/api/generate-content)、[Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs)。

## 能力记录边界（2026-10-26）

能力记录按版本、供应商、端点、模型隔离，7 天到期，每组最多 128 条；旧的不带端点／时间的记录不复用。取消、认证失败、限流、服务端错误、业务 Schema 错误不推断为参数拒绝；普通请求与流式请求共用这些边界。OpenAI 兼容协议的任务配置（`jsonMode`、`schemaMode` 的官方端点条件、`totalOutputBudget`、`reasoningEffort`）由 `_aiCompatCfg` 一处构造，`callAI` 与 `callAIStream` 共用，因此两条路径读写同一条能力记录；不传这些选项的流式消费者（Ask、翻译、要点）请求体逐字节不变，由 `tests/ai-completion-tests.html` 的原始请求体快照锁定。
