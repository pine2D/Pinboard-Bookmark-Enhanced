# 核实台账

> 每个服务商的出厂默认模型，和每个替远端服务回话的测试夹具，都记一个「最近核实」日期：上次拿真实服务对过的那一天。这样上游改了接口或下架了模型，不是碰巧才发现。
>
> `最近核实` 写 `YYYY-MM-DD`，没对过就写「未核实」。对真实服务做核实，每次都要用户明确授权，本机有 Key 也不算授权（见 `.claude/skills/live-ai-test/SKILL.md`）。只凭代码注释里写明的抓取日期填日期，不估日期。
>
> `scripts/registers-lint.mjs` 检查格式。服务商和默认模型从 `ai.js` 的注册表里读：少了服务商、多了已删的服务商、默认模型和代码不一致都会报错，所以改默认模型时必须同时改这一行，日期也要重填。「位置」写仓库内的相对路径，可以带 `:行号` 或 `#夹具名`，文件不存在会报错。日期超过 90 天给警告，不报错。「未核实」只汇总成一行提示。
>
> 2026-11-11 建立。夹具清单按服务和测试文件各记一行，可能不全，发现遗漏就补。

## 默认模型

| 服务商 | 默认模型 | 最近核实 | 备注 |
|---|---|---|---|
| openai | gpt-6-luna | 未核实 | 2026-11-23 核对官方弃用表：gpt-5.4-nano 排期 2027-04-01 下线，切换官方推荐替代 |
| deepseek | deepseek-flash | 2026-11-15 | 2026-11-15 真实核验纯文本与多模态图片输入（thinking disabled） |
| qwen | qwen3.8-flash | 2026-11-23 | 2026-11-23 实测百炼北京业务空间端点 JSON 与 SSE 词条生成通过（enable_thinking: false） |
| minimax | MiniMax-M3.1-Flash | 2026-11-23 | 2026-11-23 实测 400 (2013) 自愈回退 reasoning_effort: low 及 JSON/SSE 词条生成通过 |
| openrouter | openai/gpt-oss-20b | 未核实 | 2026-11-23 核对公开 /api/v1/models 目录仍在服；本轮因账户 402 余额不足即停 |
| groq | openai/gpt-oss-20b | 未核实 | - |
| mistral | mistral-small-latest | 未核实 | - |
| cohere | command-r7b-12-2024 | 未核实 | 2026-11-23 核对官方弃用表仍为在服轻量推荐型号 |
| siliconflow | deepseek-ai/DeepSeek-V4.1-Flash | 2026-11-23 | 2026-11-23 实测硅基流动 JSON 与逐块累计 usage SSE 词条生成通过（enable_thinking: false） |
| zhipu | glm-5.3-flash | 未核实 | 2026-11-23 实测修复中文 400 (1210) 自愈回退 reasoning_effort: low；BigModel 账户 429 (1113) 余额不足即停 |
| kimi | kimi-k3.1-pro | 未核实 | 2026-11-23 本机未配置 MOONSHOT_API_KEY，跳过实测 |
| ark | doubao-seed-2-1-lite-260915 | 未核实 | - |
| opencode | glm-5.3-flash | 未核实 | - |
| commandcode | deepseek/deepseek-v4.1-flash | 2026-11-23 | 2026-11-23 经本机 agentgateway 实测 Command Code 上游 deepseek/deepseek-v4.1-flash JSON 与 SSE（含 reasoning_effort: low 自愈）通过 |
| gemini | gemini-3.5-flash-lite | 2026-11-23 | 2026-11-23 实测切换 thinkingLevel: low 后 generateContent 与 streamGenerateContent?alt=sse（含 thoughtSignature）全部通过 |
| claude | claude-haiku-5-5 | 未核实 | 2026-11-23 经 Command Code /messages 实测同型号响应结构；直连 api.anthropic.com 未配 Key |
| ollama | llama3.2 | 未核实 | - |

## 远端夹具

| 服务 | 位置 | 最近核实 | 备注 |
|---|---|---|---|
| Pinboard | tests/bookmark-live-pinboard-mock.mjs | 未核实 | 本机模拟的 v1 接口 |
| Pinboard | tests/save-pipeline-tests.html | 未核实 | 手写的 posts/get 响应 |
| Pinboard | tests/popup-save-tests.html | 未核实 | - |
| Pinboard | tests/background-active-tab-tests.html | 未核实 | - |
| Pinboard | tests/batch-dedup-tests.html | 未核实 | - |
| Pinboard | tests/popup-tag-cache-tests.html | 未核实 | - |
| Pinboard | tests/reader-bookmark-tests.html | 未核实 | 注释说按真实的 posts/get 响应手写 |
| Pinboard | tests/settings-persist-tests.html | 未核实 | - |
| Pinboard | tests/tag-gov-tests.html | 未核实 | - |
| Pinboard | tests/tag-gov-entity-tests.html | 未核实 | 注释写明 tags/get、posts/all、posts/add 的响应形状 |
| Karakeep | tests/bookmark-services-tests.html | 2026-11-23 | 2026-11-23 对照 --target temp Karakeep 0.34.1 真实容器核实（含 firstCreatedAt、embeddingStatus、lists、Zod 400 与 Hono 401/404） |
| linkding | tests/bookmark-services-tests.html | 2026-11-23 | 2026-11-23 对照 --target temp linkding 1.47.0（SQLite + postgres:18）真实容器核实（含 BookmarkSerializer、user/profile/ 与超长标签 500） |
| Karakeep | tests/bookmark-live-preflight-tests.mjs | 2026-11-23 | 2026-11-23 对照 --target temp Karakeep 0.34.1 核实 /signin clientConfig flight、users/me、lists 与 Hono 纯文本 401/404 |
| Karakeep | tests/bookmark-service-runtime-tests.mjs | 2026-11-23 | 2026-11-23 对照 --target temp Karakeep 0.34.1 核实 POST 201/200、PATCH 全记录、lists、tags 与 401/404 形状 |
| Karakeep | tests/popup-save-tests.html | 2026-11-23 | 2026-11-23 对照 --target temp Karakeep 0.34.1 核实 lookup_bookmark 投影（bookmarkId、version、metadata: null） |
| Karakeep | tests/reader-bookmark-tests.html | 2026-11-23 | 2026-11-23 对照 --target temp Karakeep 0.34.1 核实 selfHostedServer（POST 201、PATCH 全记录、🔖 列表与纯文本 404） |
| linkding | tests/bookmark-live-preflight-tests.mjs | 2026-11-23 | 2026-11-23 对照 --target temp linkding 1.47.0 核实 /health、/api/user/profile/、/api/bookmarks/check/ 与 /api/tags/ |
| linkding | tests/bookmark-service-runtime-tests.mjs | 2026-11-23 | 2026-11-23 对照 --target temp linkding 1.47.0（SQLite + postgres:18）核实 check/、POST/PATCH、tags 分页与 404/500 |
| linkding | tests/popup-save-tests.html | 2026-11-23 | 2026-11-23 对照 --target temp linkding 1.47.0 核实 lookup_bookmark 投影（微秒时间戳、summary、version 与 metadata） |
| linkding | tests/reader-bookmark-tests.html | 2026-11-23 | 2026-11-23 对照 --target temp linkding 1.47.0（SQLite + postgres:18）核实 selfHostedServer（check/、POST/PATCH、404 与 500） |
| Google Drive | tests/vocab-gdrive-tests.html | 未核实 | - |
| Google Drive | tests/notes-gdrive-tests.html | 未核实 | - |
| Google Drive | tests/dict-archive-tests.html | 未核实 | - |
| Google Drive | tests/ask-archive-tests.html | 未核实 | - |
| Google Drive | tests/drive-scopes-tests.html | 未核实 | - |
| Google Drive | tests/options-drive-sync-tests.html | 未核实 | - |
| OpenAI、Anthropic、Gemini、Ollama | tests/ai-completion-tests.html | 未核实 | 按官方 schema 手写（含多模态图片输入；OpenAI 原生与 Ollama 仍未实测，已实测平台夹具单列于下） |
| DeepSeek | tests/ai-completion-tests.html#DEEPSEEK_FLASH_LIVE_20261115 | 2026-11-15 | 2026-11-15 真实核验 deepseek-flash 纯文本与多模态 image_url 响应夹具 |
| Gemini | tests/ai-completion-tests.html#GEMINI_FLASH_LITE_LIVE_20261123 | 2026-11-23 | 2026-11-23 实测 gemini-3.5-flash-lite JSON 与 SSE（thinkingLevel: low、thoughtSignature）响应夹具 |
| 阿里云百炼 | tests/ai-completion-tests.html#QWEN38_FLASH_LIVE_20261123 | 2026-11-23 | 2026-11-23 实测 qwen3.8-flash 业务空间专属端点 JSON 与 SSE 响应夹具 |
| MiniMax | tests/ai-completion-tests.html#MINIMAX_M31_FLASH_LIVE_20261123 | 2026-11-23 | 2026-11-23 实测 MiniMax-M3.1-Flash 400 (2013) 回退与 JSON/SSE 响应夹具 |
| SiliconFlow | tests/ai-completion-tests.html#SILICONFLOW_DEEPSEEK_V41_LIVE_20261123 | 2026-11-23 | 2026-11-23 实测 deepseek-ai/DeepSeek-V4.1-Flash JSON 与逐块 usage SSE 响应夹具 |
| Command Code | tests/ai-completion-tests.html#COMMANDCODE_LIVE_20261123 | 2026-11-23 | 2026-11-23 经 agentgateway 实测 Command Code OpenAI (/chat/completions) 与 Anthropic (/messages) 双协议 JSON/SSE 夹具 |
| OpenAI 兼容接口 | tests/popup-ai-sw-tests.html | 2026-11-23 | 2026-11-23 对照百炼/MiniMax/硅基流动实测 chat.completion 响应包络核实 |
| OpenAI 兼容接口 | tests/fixtures/dict-live-responses.mjs | 2026-11-23 | 2026-11-23 对照百炼/硅基流动/Command Code 实测 chat.completion 包络（model、logprobs、tokens_details）核实 |
| OpenAI 兼容接口 | tests/fixtures/dict-chat-stream.mjs | 2026-11-23 | 2026-11-23 对照百炼/MiniMax/硅基流动/Command Code 实测 chat.completion.chunk 流式包络核实 |
| OpenAI 兼容接口 | tests/md-ai-tests.html | 2026-11-23 | 2026-11-23 对照百炼/硅基流动实测 chat.completion.chunk（含 content: null 终止块与 usage 尾块）核实 |
| OpenAI 兼容接口 | tests/dict-entry-tests.html | 2026-11-23 | 2026-11-23 纳入实测 constraint 双义项词条响应夹具并核验解析与缓存链路 |
| OpenAI 兼容接口 | tests/dict-settings-tests.html | 2026-11-23 | 2026-11-23 对照百炼/硅基流动实测 chat.completion.chunk 流式响应核实 |
| OpenAI 兼容接口 | tests/dict-protocol-tests.html | 2026-11-23 | 2026-11-23 对照百炼/MiniMax/硅基流动实测 SSE 流式帧（含 reasoning_content 与 usage 尾块）核实 |
| OpenAI 兼容接口 | tests/dict-live-test-tests.mjs | 2026-11-23 | 2026-11-23 对照百炼/MiniMax/硅基流动/Command Code 实测 SSE 帧结构与字节预算核实 |
| OpenAI 兼容接口 | tests/fixtures/dict-litellm-responses.mjs | 2026-11-23 | 2026-11-23 对照实测 chat.completion 完整包络（id/object/created/model/logprobs/usage）核实 |
| OpenAI 兼容接口 | tests/fixtures/dict-redesign-r2-responses.mjs | 2026-11-23 | 2026-11-23 对照实测 chat.completion 包络（logprobs: null、tokens_details）与 Wiktionary missingtitle 核实 |
| OpenAI 兼容接口、MediaWiki | tests/fixtures/dict-redesign-responses.mjs | 2026-11-23 | 2026-11-23 对照实测 chat.completion 包络（含网关上游 model 别名、logprobs、tokens_details）与 MediaWiki formatversion=2 核实 |
| DeepSeek | tests/fixtures/dict-deepseek-collocations.json | 2026-10-25 | 原文："Captured successful DeepSeek collocations response from the explicitly authorized 2026-10-25 synthetic provider lookup." |
| LiteLLM | tests/fixtures/dict-live-malformed-responses.js:1 | 2026-10-26 | 原文：// Reviewed synthetic-term answers captured on 2026-10-26 through LiteLLM. |
| Jina Reader | tests/jina-cache-tests.html#JINA_READER_LIVE_20261123 | 2026-11-23 | 2026-11-23 免 Key 抓取 r.jina.ai/https://example.com JSON 响应包络 |
| DeepSeek Fetch | tests/jina-cache-tests.html#DEEPSEEK_FETCH_LIVE_20261115 | 2026-11-15 | 2026-11-15 真实核验 /v1/tools/fetch 顶层 {content, title} 响应夹具 |
| DeepSeek OCR | tests/md-ocr-tests.html#DEEPSEEK_OCR_LIVE_20261115 | 2026-11-15 | 2026-11-15 真实核验 /v1/tools/ocr (ocr.result) 响应夹具 |
| DeepSeek TTS | tests/deepseek-speech-tests.html#DEEPSEEK_TTS_LIVE_WAV_HEADER_20261115 | 2026-11-15 | 2026-11-15 真实核验 /v1/tools/tts 24kHz 流式 WAV (0xffffffff) 头部夹具 |
| DeepSeek ASR | tests/deepseek-speech-tests.html#DEEPSEEK_ASR_LIVE_20261115 | 2026-11-15 | 2026-11-15 真实核验 /v1/tools/asr {request_id, text, duration_ms} 响应夹具 |
| Wayback Machine | tests/wayback-tests.html:374 | 2026-11-23 | 2026-11-23 只读探测 archive.org/wayback/available 并对照 SPN2 JSON 规范核实 |
| Free Dictionary | tests/md-dict-tests.html:216 | 2026-11-13 | 2026-11-13 复核 es/aprovecho、pl/psa、en/found 线上响应；pl/psa 同步新增 IPA |
| Free Dictionary | tests/library-vocab-tests.html#FDA_CONSTRAINT | 2026-11-23 | 2026-11-23 抓取 freedictionaryapi.com/api/v1/entries/en/constraint 真实响应 |
| Free Dictionary | tests/library-listbox-tests.html#FDA_CONSTRAINT | 2026-11-23 | 2026-11-23 抓取 freedictionaryapi.com/api/v1/entries/en/constraint 真实响应 |
| 欧路词典 | tests/eudic-sync-tests.html | 未核实 | 只模拟到调用层的返回值；未提供测试令牌 |
| AnkiConnect | tests/anki-connect-tests.html | 未核实 | 2026-11-23 探测本机 127.0.0.1:8765 未启动，保持未核实 |
| YouTube 字幕 | tests/md-video-tests.html:429 | 2026-10-24 | 原文：section("YouTube layered captions (v9QtM6qnG50, captured 2026-10-24)"); |
| B 站字幕 | tests/md-video-tests.html:580 | 2026-11-23 | 2026-11-23 匿名只读抓取 nav、view 与 player/wbi/v2 真实响应包络 |
| Notion | tests/export-targets-tests.html | 未核实 | 未提供测试集成令牌与父页面 ID |
| Notion | tests/md-send-menu-tests.html | 未核实 | 未提供测试集成令牌与父页面 ID |
| GitHub Gist | tests/export-targets-tests.html | 2026-11-23 | 2026-11-23 实测 GET /user (200) 与 POST /gists (201, public: false) 真实响应（含 html_url 优先于 API url）并完成 204/404 清理 |
| Anthropic | tests/md-ai-tests.html | 2026-11-23 | 2026-11-23 对照 Command Code claude-haiku-5-5 /v1/messages 实测 SSE 包络（container/stop_details/output_tokens_details）核实 |
| Anthropic | tests/dict-protocol-tests.html | 2026-11-23 | 2026-11-23 对照 Command Code claude-haiku-5-5 /v1/messages 实测 SSE（thinking_delta、signature_delta、ping、message_delta）核实 |
| Gemini | tests/md-ai-tests.html | 2026-11-23 | 2026-11-23 对照 gemini-3.5-flash-lite streamGenerateContent?alt=sse 实测包络（thoughtSignature、usageMetadata、responseId）核实 |
| Gemini | tests/dict-protocol-tests.html | 2026-11-23 | 2026-11-23 对照 gemini-3.5-flash-lite streamGenerateContent?alt=sse 实测包络核实 |
| Ollama | tests/md-ai-tests.html | 未核实 | - |
| Ollama | tests/dict-protocol-tests.html | 未核实 | - |
| MediaWiki | tests/library-vocab-tests.html:4657 | 2026-11-23 | 2026-11-23 抓取 de.wikisource.org Faust - Der Tragödie erster Teil (formatversion=2) |
| MediaWiki | tests/dict-evidence-tests.html:4 | 2026-11-23 | 2026-11-23 抓取 en/zh/ja.wikisource 与 en.wiktionary (formatversion=2，含 ws-poem 与 ruby) |
