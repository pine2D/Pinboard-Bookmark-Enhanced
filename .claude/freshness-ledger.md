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
| openai | gpt-5.4-nano | 未核实 | - |
| deepseek | deepseek-v4-flash | 未核实 | - |
| qwen | qwen-flash | 未核实 | - |
| minimax | MiniMax-M2 | 未核实 | - |
| openrouter | openai/gpt-oss-20b | 未核实 | - |
| groq | openai/gpt-oss-20b | 未核实 | - |
| mistral | mistral-small-latest | 未核实 | - |
| cohere | command-r7b-12-2024 | 未核实 | - |
| siliconflow | Qwen/Qwen3-8B | 未核实 | - |
| zhipu | glm-4.7-flash | 未核实 | - |
| kimi | kimi-k2.6 | 未核实 | - |
| ark | doubao-seed-2-0-mini-260428 | 未核实 | - |
| opencode | glm-5.3-flash | 未核实 | - |
| commandcode | deepseek/deepseek-v4-flash | 未核实 | - |
| gemini | gemini-3.5-flash-lite | 未核实 | - |
| claude | claude-haiku-4-5 | 未核实 | - |
| ollama | llama3.2 | 未核实 | - |

## 远端夹具

| 服务 | 位置 | 最近核实 | 备注 |
|---|---|---|---|
| Pinboard | tests/bookmark-live-pinboard-mock.mjs | 未核实 | 本机模拟的 v1 接口 |
| Pinboard | tests/save-pipeline-tests.html | 未核实 | 手写的 posts/get 响应 |
| Pinboard | tests/popup-save-tests.html | 未核实 | - |
| Karakeep | tests/bookmark-services-tests.html | 未核实 | - |
| linkding | tests/bookmark-services-tests.html | 未核实 | - |
| Karakeep | tests/bookmark-live-preflight-tests.mjs | 未核实 | 注释说形状取自 Karakeep 0.34.1，没写日期 |
| linkding | tests/bookmark-live-preflight-tests.mjs | 未核实 | 注释说形状取自 linkding 1.47，没写日期 |
| Google Drive | tests/vocab-gdrive-tests.html | 未核实 | - |
| Google Drive | tests/notes-gdrive-tests.html | 未核实 | - |
| Google Drive | tests/dict-archive-tests.html | 未核实 | - |
| Google Drive | tests/ask-archive-tests.html | 未核实 | - |
| Google Drive | tests/drive-scopes-tests.html | 未核实 | - |
| OpenAI、Anthropic、Gemini、Ollama | tests/ai-completion-tests.html | 未核实 | 注释说按官方 schema 手写 |
| OpenAI 兼容接口 | tests/popup-ai-sw-tests.html | 未核实 | - |
| OpenAI 兼容接口 | tests/fixtures/dict-live-responses.mjs | 未核实 | - |
| OpenAI 兼容接口 | tests/fixtures/dict-chat-stream.mjs | 未核实 | 流式响应 |
| OpenAI 兼容接口、MediaWiki | tests/fixtures/dict-redesign-responses.mjs | 未核实 | - |
| DeepSeek | tests/fixtures/dict-deepseek-collocations.json | 2026-10-25 | 原文："Captured successful DeepSeek collocations response from the explicitly authorized 2026-10-25 synthetic provider lookup." |
| LiteLLM | tests/fixtures/dict-live-malformed-responses.js:1 | 2026-10-26 | 原文：// Reviewed synthetic-term answers captured on 2026-10-26 through LiteLLM. |
| Jina Reader | tests/jina-cache-tests.html | 未核实 | - |
| Wayback Machine | tests/wayback-tests.html | 未核实 | - |
| Free Dictionary | tests/md-dict-tests.html:216 | 2026-07-31 | 原文：// Payloads captured verbatim from freedictionaryapi.com on 2026-07-31, NOT |
| Free Dictionary | tests/library-vocab-tests.html | 未核实 | 照 md-dict-tests.html 的样本手写 |
| Free Dictionary | tests/library-listbox-tests.html | 未核实 | 照 md-dict-tests.html 的样本手写 |
| 欧路词典 | tests/eudic-sync-tests.html | 未核实 | 只模拟到调用层的返回值 |
| AnkiConnect | tests/anki-connect-tests.html | 未核实 | - |
| YouTube 字幕 | tests/md-video-tests.html:429 | 2026-10-24 | 原文：section("YouTube layered captions (v9QtM6qnG50, captured 2026-10-24)"); |
| B 站字幕 | tests/md-video-tests.html | 未核实 | - |
| Notion | tests/export-targets-tests.html | 未核实 | - |
| GitHub Gist | tests/export-targets-tests.html | 未核实 | - |
