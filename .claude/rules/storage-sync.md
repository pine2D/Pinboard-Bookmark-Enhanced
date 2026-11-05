---
paths:
  - "shared.js"
  - "background.js"
  - "options.js"
  - "options-backup.js"
  - "bookmark-services.js"
  - "popup.js"
  - "popup-offline.js"
  - "popup-batch.js"
  - "md-bookmark.js"
  - "vocab-store.js"
  - "vocab-gdrive.js"
  - "notes-sync.js"
  - "notes-gdrive.js"
---

# 存储与同步边界（唯一权威表述）

> 自根 CLAUDE.md 迁来（2026-11-05），根文件只留摘要。改存储路由、同步、备份、书签连接或离线队列前以本文件为准。

| 机制 | 数据 | 边界 |
|------|------|------|
| Chrome Sync | 普通设置；另行启用时含凭据 | `optSyncEnabled` 是**每设备** local 开关，普通设置据此路由 sync/local；不含生词、高亮、缓存、任务状态 |
| Google Drive | 固定个人资料库 owner 的生词、高亮与笔记、完整 AI 词条及补充、Ask 问答记录 | 每设备单独连接；连接即同步四类、断开即停止，不设按类型开关；共享连接层状态 `driveConnState:<ownerHash>` 只存 local；只用 `drive.appdata`；不接管设置、凭据 |
| 手工 JSON schema v3 | 设置、主题 + 用户分项选择的高亮/生词/凭据 | 明文文件；导入先预览分项选择；凭据两端默认关、fail-closed（详见 rules/backup.md） |

- 凭据（API key / token / password / 导出目标）不能硬编码。默认存 `chrome.storage.local`；仅当本机 `optSyncEnabled=true` 且账号级 `syncApiKeys=true` 时用 sync；旧云端已有非空 secret 时迁移保留 `syncApiKeys=true`，避免升级丢凭据。
- sync 配额：单 item ≤8KB、总约 100KB、写入限流；写后检查 `lastError`。缓存、大对象、瞬态状态一律 local。
- 生词及其 Drive 协议状态在 IndexedDB（vocab-store.js 是生词唯一写入口）；高亮与笔记及其 Drive 协议状态走 notes-sync.js 的统一写边界；逐设备连接标记与共享连接层状态（`driveConnState:<ownerHash>`）在 local。
- **离线队列**只存 local：新记录**仅**保存保存模式、URL、标题、备注、描述（linkding Description）、标签、私密/稍后读/归档标志、可选布尔共享修改意图（`sharedExplicit`，只来自用户可见的共享操作）、书签时间、队列 ID/入队时间、非秘密书签连接身份绑定，以及重放失败后的非秘密失败标记（`failure`：失败码、HTTP 状态、发生时间与 429 限流截止时间；原因明确、重试也不会改变结果的失败据此标为需要处理，不再自动重试，由用户手动重试或删除；限流按 Retry-After 推迟，至多 1 小时）——此外一律不存（不存响应体），禁止保存 token；legacy token 记录读取时改写为账号绑定并删除 token。重放必须用当前登录 token 且服务和连接身份与队列绑定精确一致，否则保留队列并 fail-closed。

- **个人资料库**：`personalLibraryAccount` 首次采用当前 Pinboard 用户名，无账号时为 `personal:default`，随后不随书签服务/凭据切换；保留旧 owner 与 Drive hash，不自动合并其他历史账号。普通设置同步可携带此非秘密身份；普通 JSON 设置导入忽略它，资料分项仍核对所属资料库。阅读器的 library `account` 与 `bookmarkAccount` 分开，storage handoff 的 `account` 仍表示书签连接。
- **自托管书签连接**：设置三选一；Connect 点击申请精确 origin 并只读验证，成功后才保存地址与绑定该地址的凭据封套。Karakeep owner 含服务、地址与验证后的用户 ID；linkding 无用户 ID，Connect 时地址与 Token 都未变则沿用连接 ID，任一变化才生成新 ID，旧队列不跨连接重放。访问网关凭据存于同一 `<service>Token` 封套的 `gateway` 字段，随封套走凭据路由、绑定地址，校验谓词唯一在 shared.js，非法即连接未就绪。Karakeep 稍后阅读只用本人独占的私有普通列表，不映射 archived。Pinboard 建议/标签治理/未读计数/站点搜索/Tab Set 保留专用。
- **生效书签服务**：`bookmarkService` 是随 Chrome Sync 与 JSON 备份走的「所选服务」；本机实际保存到的服务是 `bookmarkServiceActive`，只存 local、不同步、不入备份，所有读取经 `pbpReadSettingsWithSecrets` 以它覆盖 `bookmarkService`（缺失时回落所选服务，即升级前的值，`pbpReconcileBookmarkService` 首次运行补记）。它只在 Pinboard 登录（设置页「测试连接」通过）、自托管 Connect 成功、或在本机已连接的服务之间点选时改变；设置页单选只切换显示的连接表单。「本机已连接」由 `pbpBookmarkServiceReadyHere` 唯一判定：自托管服务要凭据有效且本机已授予其精确 origin 的 host 权限（凭据可随同步或备份到达，权限只能本机 Connect 点击申请）；Pinboard 要 Token 在本机测试通过（设置页「测试连接」或 popup 登录），凭证是只存 local、不同步、不入备份的 `pinboardTokenVerified`（Token 摘要，改 Token 即失效；升级时正在使用的 Token 视为已测试）。同步或导入带来的所选服务若本机未连接则不切换、设置页与导入预览/结果提示，本机连上后自动跟随。
