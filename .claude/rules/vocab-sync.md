---
paths:
  - "vocab-store.js"
  - "vocab-gdrive.js"
  - "notes-sync.js"
  - "notes-gdrive.js"
  - "options-vocab.js"
  - "library-vocab.js"
  - "anki-connect.js"
  - "eudic-sync.js"
---

# 生词库与 Google Drive 同步深水区

## 生词同步不变量

- `vocab-store.js` 是 `pbp-vocab` IDB（schema v2）的唯一写入口。每次本地 mutation 在同一 IDB transaction 中核验 owner，并原子更新 word 或 tombstone、版本向量和 coalesced outbox；删除保留 tombstone，不自动 GC。
- 远端批次用 owner hash 隔离，vector dominance 与稳定 dot 决定收敛；并发删除遇到新修改时 live 胜出并留下持久 notice，用户再次删除后 tombstone 才支配。
- 每个网络 await 和 IDB commit 前都重核验 Pinboard owner 与 Drive `permissionId`，变化时不得推进游标或上传旧账号数据。`permissionId` 的核验手段是「重取 token，与已核验 token 的身份比对」（见下文《Drive 身份缓存》），不是每次都发 `about.get`。

## 高亮与笔记同步不变量

- `notes-sync.js` 保留 `chrome.storage.local` 的文章记录为权威内容。版本与待同步 ID 嵌入同一记录，以 `pbp-hl:<key>` 锁和单次 `set` 同时持久化内容及同步意图；远端应用、编辑、删除和 JSON 恢复共用此锁。
- 并发事件保留各叶的版本向量；合并只去掉被因果支配的叶，确定排序并保留并发笔记及删除事件。本机后续编辑从完整向量递增并吸收冲突，不能只拼接笔记字符串而丢掉因果来源。
- 冻结批次先持久化，再仅移除仍匹配该批次的待同步 ID；远端游标在本页所有文章写入成功后推进，重放必须幂等。删除标记不自动回收。
- 两类数据共享本机 Drive **连接层**：每个 owner 一份连接状态 `driveConnState:<ownerHash>`（local，`{ lastError, authAttempts, retryAttempt, retryAt, blocked, updatedAt }`）、一条串行队列 `queueDriveSync`（每轮先生词、后笔记；生词以连接层错误结束时笔记本轮不发 Drive 请求）、单一 `driveScopeEpoch`、三个 alarm `drive-sync-dirty` / `drive-sync-periodic` / `drive-sync-retry` 和一条通知（每轮至多一条，手动立即同步与连接不弹）。runner 遇到连接层码只写共享记录，不写自己的 preflight 和账号行；`authAttempts` 只统计 `auth`，任一非 `auth` 结果清零；之前已累计 5 次 auth 退避（1+2+4+8+16 分钟，约 31 分钟）后，第 6 次 auth 失败才转 blocked；连接层退避未到期时两类都不发网络请求。openSession 成功即把共享记录的 `lastError` / `retryAt` 置空、`authAttempts` 清零（保留 `retryAttempt`，让时好时坏的链路继续拉长退避），整轮成功删除记录；读共享记录失败按无记录处理（`console.warn` 留痕，不升级为 `local_store` blocked）。整轮中途发现 `driveScopeEpoch` 变化时先读连接标记：已断开返回 `not_connected`（不渲染），仍连接才是 `account_changed`。编排层写入或清零 `driveConnState` 前原子重读 Pinboard 认证，owner 与 `driveScopeEpoch` 都与本轮开始时一致才写，轮外写入一律丢弃；状态组装只从共享记录读连接层结论，preflight 与账号行里遗留的连接层码视为不存在。`force`（立即同步 / 连接）同时清除共享连接状态、两类数据层 blocked 以及两类账号行的 `lastError` / `retryAt`（游标不动）。alarm 由编排层每轮结束后统一调和（`pbpReconcileDriveAlarms`），runner 不直接 create/clear。**数据层**各自独立：两套 wire 协议（`vocab-batch` / `notes-batch`）、游标、store 与数据层告警；一类数据层 blocked 不阻断另一类，也不清除共享 periodic / dirty。启用判定只有 `pbpDriveEnabled()`（已连接且可选权限仍在）：连接即同步生词、高亮与笔记，断开即停止，没有按类型的开关。
- Google 账号无法在线核验时保留原网络或认证错误，不能当作账号切换；同一 token 命中身份缓存视为已核验（见下文《Drive 身份缓存》）。退避状态仅需重新核验 Pinboard owner，成功数据写入仍需核验 Drive 账号。

## Drive 身份缓存

- vocab-gdrive.js 模块级按 token 缓存 Drive 身份 `token → { permissionId, emailAddress, displayName }`（最多 2 条，SW 回收即清空，vocab / notes / connect 三个 client 共享）。依据：Drive 账号变化必然伴随 Chrome 返回不同 token，token 相同即账号相同。
- 读缓存的只有顶层 `client.about()`：runner `stillCurrent` 的 `getCurrentPermissionId`、`pbpNotesDriveCurrentOwner`、`pbpRefreshDriveConnectionAccount`。流程是静默取 token，命中缓存零 HTTP；未命中发 `about.get`，并以实际所用 token（含 401 续签后的新 token）写缓存。缓存命中仍要先过 client 的 `beforeRequest` 门（已连接且可选权限仍在），断开或撤权后不得凭缓存返回旧身份。缓存只在 SW 内存：不落盘、不打日志、不出现在任何返回值里。
- 不读缓存、强制 HTTP 并刷新缓存：`openSession` 的首次 about、401 续签后的探测、本轮收尾 `session.about()`、交互式 `connect()`。每轮因此至少有开头与收尾两次真实核验；新增读身份的调用点必须先归入这两类之一，真实核验路径不得改走缓存。
- 失效：401 与 `removeCachedAuthToken` 删除对应条目；断开、`permissions.onRemoved`、`clearAllCachedAuthTokens`、重新授权调用 `pbpVocabDriveForgetIdentity()` 清空。测试在用例之间也要调用，否则共用 `"token-a"` 的用例会互相命中缓存。

## 错误码与指引契约

`auth`（Google 令牌失败）、`permission`（用户拒绝授权或 token 缺 scope）、`network`、`rate_limited`、`server` 是**连接层**码：每个 owner 一份共享状态，面板一行、不带主语。取 token（mint）失败按 Chromium 原文分类，夹具用真实日志原文：`Connection failed (-N)` 与交互授权页加载失败 / 超时（`Authorization page could not be loaded.` / `… load timed out.`）→ `network`、可重试，离线设备点「连接」因此不会被转为未连接；`Service unavailable; try again later` → `server`；未授权 / 已撤销、Chrome 未登录或关闭登录 → `auth` 不可重试；交互式拒绝 → `permission`；无法识别的原文沿用旧规则（静默可重试、交互不可重试）。`corrupt`（远端批次不合法；runner 内由 `invalid_response` / `id_collision` / `remote_batch_too_large` / `invalid_remote_page` 认领转成）、`local_store`（本机 IndexedDB 或 Chrome Storage 读写失败，与 `corrupt` 严格分开）、`entry_too_large`、`remote`（403 非限流非权限、404、未知状态码）、`unexpected`（runner 顶层捕获的无 code 异常，可重试，文案 `vocabDriveErrorUnexpected`，不归咎 Google）是**数据层**码：按类型独立，面板每类一行、带主语。控制流码 `account_changed`、`pinboard_auth`（无 Pinboard 账号，发生在任何 Google 调用之前，不写 preflight）、`not_connected`（本机未连接，**不渲染成错误**）、`waiting_for_retry` 不持久化为退避；`status_unavailable` 只在状态读取失败时由后台合成，按数据层带主语显示。`applyRemotePage` 只返回 `invalid_remote_page`，必须显式认领。**每个 blocked 状态都要点名一个当前屏幕上可见的按钮**：连接层 `auth` blocked 与 `permission`（无论是否已连接）指向「连接 Google Drive」，已连接时状态行为 `vocabDriveAuthNeeded`，按钮行同时显示连接、立即同步与断开；数据层 blocked 指向「立即同步」（`force` 是唯一能清除 blocked 的入口；`entry_too_large` 用其自带指引）；未连接指向「连接 Google Drive」；`pinboard_auth` 已连接时指向「立即同步」，未连接时指向「连接 Google Drive」。「断开此设备」不再作为任何状态的恢复指引。仍在退避的状态（含数据层退避）只显示下次重试时间，不给指令。按钮名称逐字复用该 locale 已发布的按钮文案，不另造叫法。

## Google Drive OAuth 构建契约

源码开发公钥、开发扩展 ID、开发 OAuth client 和生产 OAuth client 均使用已注册的真实公开值；manifest 声明可选 `identity` 与唯一 scope `drive.appdata`。release 必须同时替换公钥和 OAuth client，并核验 ZIP 的 CWS ID/client。两个真实 client 对同一 Google 账号 `appDataFolder` 的双向可见性须发布前实测；若不互通，开发版使用独立测试数据，生产双设备验收改用同一 CWS build。严禁占位 client ID 或 client secret。

## Drive 权限与断开语义

只有「连接 Google Drive」这一直接用户动作可申请 `identity` 和精确 Google API origin；后台同步只做 `permissions.contains`，SW 启动不得弹 OAuth。再点「连接 Google Drive」即重新授权，不必先断开：只有共享连接记录为 `auth` blocked 或 `lastError` 为 `permission` 时才先清 token 缓存与身份缓存（`clearAllCachedAuthTokens()` 会连同本扩展的授权一起重置），首次连接与网络退避中都不清；Connect 自身的权限预检失败照旧清连接标记。断开本设备时用 `clearAllCachedAuthTokens()` 清 token cache（不联网，立即完成）、清空身份缓存并移除可选权限，但保留本地生词、高亮和笔记、outbox、tombstone、共享连接状态和远端 `appDataFolder` 文件；重连走 `force`，清除共享连接状态与两类数据层 blocked。Drive 中保存的是当前 owner 的生词、高亮与笔记的明文应用私有副本，不是端到端加密。`getAuthToken` 硬依赖已登录 Chrome。

## 生词 owner、选择与刷新不变量（UI 层）

- 生词列表、筛选、选择、单删、批删与加组都限定当前非秘密 Pinboard owner；账号切换先清空旧 owner 的可见行，再读取新 owner，失败时保持 fail-closed。
- UI 选择只影响批量删除和添加分组；TSV 与 Anki 始终处理当前 owner 的全部生词，欧路词典始终从当前 owner 全量中只发送 `en/fr/de/es`。
- 每次 mutation 在用户确认时取得刷新代际，旧 IDB 快照不得晚写覆盖新状态；最新 mutation 即使失败也要重读真实 IDB。事务内逐条 owner 校验不得移到 UI 层或省略。

## 测试夹具（本子系统的原始事故现场）

`driveFile()` 曾用写入侧 `pbpVocabDriveMetadata()` 造「远端文件」（硬编码创建期别名 `parents:["appDataFolder"]`，而 Drive 读取实际返回不透明 folder ID）——60 条断言全绿、一碰真机就 corrupt，把同一回归注入 runner 后套件**仍然全绿**。通用铁律（服务端形状手写、`=== undefined` 判定等）见根文件《测试与夹具》。
