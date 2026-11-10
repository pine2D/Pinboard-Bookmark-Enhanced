---
paths:
  - "options-backup.js"
  - "restore-points.js"
---

# 手工备份 schema v3 深水区

- 导出前 flush 待保存设置，payload 通过与导入相同的 preflight；备份含 `_backup` 元数据、设置/主题和可选的当前 owner 高亮/生词，只含运行时 word 字段。导入必须先预览，再由用户分项选择；生词按 100 条通过 store primitive 合并，并在每批前后重核验 owner。OAuth、Drive 账号、vector、dot、outbox、tombstone 和 batch 一律不进入备份。
- **凭据是 opt-in，两端都 fail-closed**：默认导出不含任何凭据（三道过滤：`EXPORTABLE_KEYS` 白名单、`pbpBuildBackupSnapshot` 内部的 `API_KEY_FIELDS` 过滤、export-target registry 的 secret 删除）。勾选后导出全部 `API_KEY_FIELDS` 与 export-target 的 token/URL，文件名带 `with credentials`，`_backup.includesSecrets=true`（`pbpSanitizeBackupMetadata` 必须同步接受该字段，否则自己导不回来）。
- 导入侧凭据是独立 section：`pbpApplyBackupPayload` 的 `selected.secrets` **只认显式 `=== true`**，不随「其余默认全开」继承——备份文件是不可信输入，任何文件都可能被手工塞进凭据字段，静默覆盖本机可用凭据是攻击面（`tests/settings-persist-tests.html` 的 E7b 正反两条断言钉死此边界）。预览的 checkbox 在 enabled 时也保持不勾选。
- 凭据经 `persistSettings` 写入，由其 `pbpSplitSecretBatch` 自行路由存储区；secrets 分支必须排在 settings 分支**之后**（settings 会用无凭据副本重建 exportTargets）。

- 个人资料库独立于书签连接：使用 `pbpPersonalLibraryAccount({initialize:false})` 预览/导出，不在预览阶段初始化身份。普通设置导入忽略 `personalLibraryAccount`，避免静默切换资料库；高亮/生词分项通常仍要求所属资料库匹配。仅在 `personal:default`、四类资料全空且未连接 Drive 时，预览明确提示后，显式选中的数据分项可采用其一致的备份 owner；应用时重新核验空库与当前身份。Karakeep/linkding 凭据封套列入 `API_KEY_FIELDS`，沿用凭据默认不导出、不导入的边界。

## 还原点（restore-points.js，2026-11-10 用户裁决）

- **存什么**：当前个人资料库 owner 的生词、高亮与笔记，别的一律不存（AI 词条归档、Ask 历史、设置、主题、凭据、`pbp_hl_last_color`、tombstone、vector、outbox 都不进）。payload 是 schema v3 形状，只有 `_backup`（`source: "restore-point"`）、`_schemaVersion`、`_highlights`、`_highlightsOwner`、`_vocabulary`，由手工导出同一套读取与序列化生成（`pbpReadHighlightBackupSource`、`pbpBuildHighlightBackup`、`pbpVocabAll`、`pbpBuildBackupSnapshot` 的 `libraryOnly`），不另写序列化。`pbpSanitizeBackupMetadata` 接受 `restore-point`，但它带 `includesSecrets` 一律拒收。写入前跑导出与导入共用的库分项预检 `pbpPreflightBackupLibrary`（`pbpPreflightBackupPayload` 也先跑它），并确认没有上述五个键以外的键、凭据计数为 0；不过就 warn 并且什么都不存。
- **存在哪**：只在本机 IndexedDB `pbp-restore-points`（v2：`meta` store 存元数据并带 `ownerCreated` 索引，`points` store 存 `{id, owner, payload}`；列表只读 `meta`，从不反序列化 payload；v1 首版把两者放在一条记录里，升级时把元数据复制进 `meta`；owner 或 createdAt 为空、不是字符串的 v1 记录列不出来，升级时直接删掉，不留孤儿 payload）。不进 `chrome.storage`（高亮已占 local 配额，扩展没有 unlimitedStorage 权限）、不进 Chrome Sync、不进 Drive、不进手工 JSON 导出。卸载扩展即删除，所以它是撤销用户操作的手段，**不是防卸载的备份**；用户要防丢数据仍要靠手工导出。
- **何时留**：导入备份文件时，`pbpApplyBackupPayload` 在第一笔写入前、且选中了高亮或生词分项时留一份（`import`）；从还原点恢复不留（见下）；资料库的批量删除与按文章删除在用户确认后、第一笔写入前留一份（`delete`，经 library.js `pbpLibRestorePointBeforeDelete`，单条删除不留）；SW `onInstalled` 的 `reason === "update"` 留一份（`update`，listener 内 await，SW 等它写完）。这时启动迁移已经跑过，所以 `update` 点记的是迁移之后的状态，挡不住同一版本里写坏数据的迁移。不做定时。
- **owner 规则**：读完数据后、写入前重读 owner，变了就什么都不写；`pbpRestorePointList` / `pbpRestorePointRead` 只给同一 owner。内容摘要与该 owner 最新一份相同就不新建；每个 owner 只留最新 5 份，其中 `update` 最多 1 份（新的 `update` 在同一事务里替换旧的，免得反复重载解压扩展把用户操作留下的点挤掉）。删除或导入时内容与最新一份相同、而那一份是 `update` 点时，在同一事务里把它的理由改成当前理由、时间改成现在，它从此代表这次操作，下一个 `update` 点不会再替换它；新增、替换与裁剪在同一事务里同时改两个 store，从不动别的 owner 的还原点。
- **失败不挡操作**：`pbpRestorePointCreate` 从不抛错，失败只 `console.warn` name/message。用户操作调用 `pbpRestorePointCreateBounded`，等待上限 `PBP_RESTORE_POINT_WAIT_MS`；超时后操作照常进行，还在读的快照不再写入（否则可能记下已经删了一半的资料库）；超时前已经读完的快照仍可能在超时后才写进去，它记的是操作之前的状态。
- **恢复只补缺（2026-11-10 用户裁决）**：从还原点恢复只把现在缺少的条目补回来，现有的一律不动、不删。高亮按文章取并集：还原点里带 id 的 item 按 id 匹配；没有 id 的早期 item 按文字身份（quote、前后文、时间、side、lang，与 notes-sync `normalizeLegacy` 哈希的字段相同）和现有任一 item 匹配，因为文章被正常写过一次后，这些 item 已经拿到 `legacy-` id；带 id 但 id 无人匹配的 item，再按文字身份和现有没有 id 的 item 比一次，对上了也算已有；现有 item 原样保留，哪怕还原点里是它的旧版本（`pbpAddMissingHighlightBackupRecord`，没有缺的就不写）；生词只写现在没有的词（`pbpVocabImportRecords` 的 `onlyMissing`，在同一 IDB 事务里判断，现有词的状态、笔记、语境都不回滚也不合并）。恢复绝不写删除事件或 tombstone，所以不会经 Drive 删掉别的设备上的东西。补回的条目走正常写边界（notes-sync 带锁写入、vocab-store mutation），版本向量越过旧 tombstone，作为新数据同步。预览把文件的说明换成一行「只补回缺少的内容」并带缺少的条数（`pbpRestorePointMissingCounts`，算不出时只显示那一行）。文件导入保持原语义：按文章替换本账号高亮、生词以文件为准合并。
- **高亮逐篇写入**：`pbpBackupWriteHighlights`（导入和恢复共用）里一篇文章写失败只记 warn、继续写后面的文章，最后整个分项报 failed；只有两种情况立即中止：账号切换（`verifyOwner` 抛错），或记录里别的 owner 的条目在这期间被改过（notes 抛 `account_changed`）；两者都按 `account_changed` 报，因为之前定下的 owner scope 对后面每篇都已失效。还原点预览里缺少的条数都是 0 时，只显示「没有缺少的内容，不需要恢复」，并且不能应用。
- **清空还原点**：数据页列表下的「清空还原点」只在有还原点时显示，走设置页危险操作的确认弹层，确认后 `pbpRestorePointClear` 在一个事务里删掉当前 owner 在两个 store 里的全部还原点，别的 owner 不动。
- **删除确认文案**：资料库的生词批量删除、高亮批量删除和按文章删除会先留还原点，确认框用 `libraryDeleteVocabBatchDetail` / `libraryDeleteNotesBatchDetail`，说明会留还原点、可到设置的「数据」页恢复；单个生词和单条高亮删除不留还原点，仍用原来的「无法撤销」文案（`libraryDeleteVocabDetail` / `libraryDeleteNotesDetail`）。
- **恢复**：数据页列出当前 owner 的还原点，「恢复…」走现有导入预览，标题、分项说明和就绪状态换成恢复的说法，补回条数那一行放在合计之前，合计行不写个人资料库；只出现高亮和生词两个分项，还原点里没有内容的分项连复选框也不出（`pbpBuildBackupPreview` 与 `pbpApplyBackupPayload` 都对还原点强制关掉设置、主题、凭据）。恢复只补回缺少的条目，所以恢复前不留还原点，也不因为还原点存不成而拦截（2026-11-10 用户裁决）：留下的那份退不回补缺，只会占掉一份名额。理由只有 `import`、`delete`、`update` 三种；早期版本存下的 `restore` 理由的点照常列出和恢复，读取时显示为 `import`（它们当初就是经导入预览应用的）。导入和删除的还原点失败时照常进行。「是不是还原点」只看调用方：只有数据页经 `pbpRestorePointRead(id, owner)` 读出的 payload 带 `restorePoint: true` 进入预览与应用；文件即使 `_backup.source === "restore-point"`，也按普通导入（理由 `import`、各分项照常）处理。不做一键恢复。
- **上次导出时间**：手工导出成功后写 `chrome.storage.local` 的 `backupLastExportAt`（`PBP_BACKUP_LAST_EXPORT_KEY`），不是设置，不同步、不导出，Storage Management 也不清（`pbpIsNeverClearKey`）。
