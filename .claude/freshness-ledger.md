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
| qwen | qwen3.8-flash | 未核实 | 2026-11-23 核对百炼文档：qwen-flash 跨代落后，新装默认升至 qwen3.8-flash |
| minimax | MiniMax-M3.1-Flash | 未核实 | - |
| openrouter | openai/gpt-oss-20b | 未核实 | 2026-11-23 核对公开 /api/v1/models 目录仍在服 |
| groq | openai/gpt-oss-20b | 未核实 | - |
| mistral | mistral-small-latest | 未核实 | - |
| cohere | command-r7b-12-2024 | 未核实 | 2026-11-23 核对官方弃用表仍为在服轻量推荐型号 |
| siliconflow | deepseek-ai/DeepSeek-V4.1-Flash | 未核实 | 2026-11-23 核对硅基流动文档：Qwen/Qwen3-8B 跨代落后，新装默认升至 DeepSeek-V4.1-Flash |
| zhipu | glm-5.3-flash | 未核实 | - |
| kimi | kimi-k3.1-pro | 未核实 | - |
| ark | doubao-seed-2-1-lite-260915 | 未核实 | - |
| opencode | glm-5.3-flash | 未核实 | - |
| commandcode | deepseek/deepseek-v4.1-flash | 未核实 | - |
| gemini | gemini-3.5-flash-lite | 未核实 | - |
| claude | claude-haiku-5-5 | 未核实 | - |
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
| Karakeep | tests/bookmark-services-tests.html | 未核实 | - |
| linkding | tests/bookmark-services-tests.html | 未核实 | - |
| Karakeep | tests/bookmark-live-preflight-tests.mjs | 未核实 | 注释说形状取自 Karakeep 0.34.1，没写日期 |
| Karakeep | tests/bookmark-service-runtime-tests.mjs | 未核实 | - |
| Karakeep | tests/popup-save-tests.html | 未核实 | - |
| Karakeep | tests/reader-bookmark-tests.html | 未核实 | - |
| linkding | tests/bookmark-live-preflight-tests.mjs | 未核实 | 注释说形状取自 linkding 1.47，没写日期 |
| linkding | tests/bookmark-service-runtime-tests.mjs | 未核实 | - |
| linkding | tests/popup-save-tests.html | 未核实 | - |
| linkding | tests/reader-bookmark-tests.html | 未核实 | - |
| Google Drive | tests/vocab-gdrive-tests.html | 未核实 | - |
| Google Drive | tests/notes-gdrive-tests.html | 未核实 | - |
| Google Drive | tests/dict-archive-tests.html | 未核实 | - |
| Google Drive | tests/ask-archive-tests.html | 未核实 | - |
| Google Drive | tests/drive-scopes-tests.html | 未核实 | - |
| Google Drive | tests/options-drive-sync-tests.html | 未核实 | - |
| OpenAI、Anthropic、Gemini、Ollama | tests/ai-completion-tests.html | 未核实 | 按官方 schema 手写（含多模态图片输入） |
| DeepSeek | tests/ai-completion-tests.html#DEEPSEEK_FLASH_LIVE_20261115 | 2026-11-15 | 2026-11-15 真实核验 deepseek-flash 纯文本与多模态 image_url 响应夹具 |
| OpenAI 兼容接口 | tests/popup-ai-sw-tests.html | 未核实 | - |
| OpenAI 兼容接口 | tests/fixtures/dict-live-responses.mjs | 未核实 | - |
| OpenAI 兼容接口 | tests/fixtures/dict-chat-stream.mjs | 未核实 | 流式响应 |
| OpenAI 兼容接口 | tests/md-ai-tests.html | 未核实 | - |
| OpenAI 兼容接口 | tests/dict-entry-tests.html | 未核实 | - |
| OpenAI 兼容接口 | tests/dict-settings-tests.html | 未核实 | 流式响应 |
| OpenAI 兼容接口 | tests/dict-protocol-tests.html | 未核实 | - |
| OpenAI 兼容接口 | tests/dict-live-test-tests.mjs | 未核实 | - |
| OpenAI 兼容接口 | tests/fixtures/dict-litellm-responses.mjs | 未核实 | - |
| OpenAI 兼容接口 | tests/fixtures/dict-redesign-r2-responses.mjs | 未核实 | - |
| OpenAI 兼容接口、MediaWiki | tests/fixtures/dict-redesign-responses.mjs | 未核实 | - |
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
| 欧路词典 | tests/eudic-sync-tests.html | 未核实 | 只模拟到调用层的返回值 |
| AnkiConnect | tests/anki-connect-tests.html | 未核实 | - |
| YouTube 字幕 | tests/md-video-tests.html:429 | 2026-10-24 | 原文：section("YouTube layered captions (v9QtM6qnG50, captured 2026-10-24)"); |
| B 站字幕 | tests/md-video-tests.html:580 | 2026-11-23 | 2026-11-23 匿名只读抓取 nav、view 与 player/wbi/v2 真实响应包络 |
| Notion | tests/export-targets-tests.html | 未核实 | - |
| Notion | tests/md-send-menu-tests.html | 未核实 | - |
| GitHub Gist | tests/export-targets-tests.html | 未核实 | - |
| Anthropic | tests/md-ai-tests.html | 未核实 | - |
| Anthropic | tests/dict-protocol-tests.html | 未核实 | - |
| Gemini | tests/md-ai-tests.html | 未核实 | - |
| Gemini | tests/dict-protocol-tests.html | 未核实 | - |
| Ollama | tests/md-ai-tests.html | 未核实 | - |
| Ollama | tests/dict-protocol-tests.html | 未核实 | - |
| MediaWiki | tests/library-vocab-tests.html:4657 | 2026-11-23 | 2026-11-23 抓取 de.wikisource.org Faust - Der Tragödie erster Teil (formatversion=2) |
| MediaWiki | tests/dict-evidence-tests.html:4 | 2026-11-23 | 2026-11-23 抓取 en/zh/ja.wikisource 与 en.wiktionary (formatversion=2，含 ws-poem 与 ruby) |
