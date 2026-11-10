---
paths:
  - "background.js"
  - "manifest.json"
  - "bookmark-services.js"
  - "vocab-store.js"
  - "vocab-gdrive.js"
  - "notes-sync.js"
  - "notes-gdrive.js"
  - "dict-archive.js"
  - "dict-archive-gdrive.js"
  - "ask-archive.js"
  - "ask-archive-gdrive.js"
  - "wayback.js"
  - "pinboard-style.js"
  - "pinboard-sort.js"
  - "bili-player-bridge.js"
---

# MV3 铁律（改 background.js / manifest / SW 模块 / content script 前必读）

<!-- 机制依据：Blink fonts README、crbug 1266022/491556、developer.chrome.com（SW lifecycle / storage / CSP / alarms）、web.dev（content-visibility / style 计算） -->

> 自根 CLAUDE.md 迁来（2026-11-05）；根文件保留前三条摘要与「吞异常必须留痕」全文（它全仓适用，不限 SW）。paths 覆盖 manifest、background.js 用 importScripts 载入的 SW 模块（i18n.js / shared.js / ai.js / jina.js 因各表面都载、不在此列）与 content script。

- **SW 无持久状态**：30s idle 即终止、全局变量清空。状态一律落 chrome.storage，每个 handler 开头重读；全局只作单次调用内的暖缓存。
- **optional permission 的 API 在调用点现取**：权限未授予时 `chrome.identity` 等整个命名空间不存在，SW 顶层或默认参数捕获会把 `undefined` 钉死一整个 worker 世代（新用户首次连接的必经顺序，2026-07 真实事故；范式见 vocab-gdrive.js 的 `identityApi()`，测试注入的 fixture 仍优先）。调试注意：给 SW 开着 DevTools 会阻止它被回收，「重启一下就好了」的推理此时不成立。
- **吞异常必须留痕**：把平台 API 异常折叠成产品错误码前，先 `console.warn` 出 `error.name` / `error.message`（不含 token、邮箱、生词内容）。eslint 规则 `pbp/no-silent-catch` 守这一条：空 catch 或不读错误的 catch 会报错。旧的写法记在 `scripts/eslint-suppressions.json`，只许减不许增，提交钩子会拒绝变大的基线。修掉一处旧的以后，运行 prune 并提交 json，命令见钩子的报错。确实要吞时，在 catch 块里写 `// swallow-ok: 理由`，理由不能空。
- **监听器与 importScripts 只能在 SW 顶层同步执行**；async 注册在 MV3 不保证生效。
- **onMessage 异步响应**：`return true` 保持通道，且该 listener 不能是 async 函数（二者只能取一）。
- **CSP**：禁 eval / 远程代码；只能远程取数据（JSON/CSS）。Defuddle 因此本地 vendor。
- **content script**：仅 pinboard.in 注入、保持瘦身；`document_start` 仅主题注入需要（pinboard-sort.js 是第二段注册，`document_idle`）。
- **setIcon**：仅状态真正变化时调用 + 缓存 ImageData，别每个 tab 事件重新 fetch PNG（回归修复见 `9b689c1`）。
- **manifest 身份**：源码 manifest 的 `key` 与 `oauth2.client_id` 是开发身份，release.sh 只在 ZIP 内替换为 CWS 身份；不要在源码里改成生产值（细则见 `.claude/skills/release/SKILL.md`「扩展 ID 分层」）。
