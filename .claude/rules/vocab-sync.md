---
paths:
  - "vocab-store.js"
  - "vocab-gdrive.js"
  - "notes-sync.js"
  - "notes-gdrive.js"
  - "options-vocab.js"
  - "library-vocab.js"
  - "library-notes.js"
  - "md-highlight.js"
  - "anki-connect.js"
  - "eudic-sync.js"
  - "vocab-send.js"
---

# 生词库与高亮笔记同步深水区

> 2026-11-05 起同步规则拆成三份：本文件管生词与高亮笔记的数据层不变量和生词 UI 层；`drive-sync.md` 管四类数据共用的 Drive 连接层、身份缓存、错误码与指引、OAuth 与权限；`archive-sync.md` 管 AI 词条归档与 Ask 归档。

## 生词同步不变量

- `vocab-store.js` 是 `pbp-vocab` IDB（schema v2）的唯一写入口。每次本地 mutation 在同一 IDB transaction 中核验 owner，并原子更新 word 或 tombstone、版本向量和 coalesced outbox；删除保留 tombstone，不自动 GC。
- 远端批次用 owner hash 隔离，事件保留未被因果支配的原始叶（`versions`），按稳定 dot 确定投影；本地编辑吸收完整向量后产生新叶。不得把合并后的字段当成单一 dot 的原始内容，否则事件顺序会改变结果。并发删除遇到新修改时 live 胜出并留下持久 notice，用户再次删除后 tombstone 才支配。
- 生词 wire batch 写 schema 2、持续读取 schema 1/2，Drive 文件按 `appProperties.schema` 分流；旧端不会读取 schema 2，所有设备须升级才能完整双向同步。旧无 `versions` 事件作为不可拆的叶读取，已丢失的历史来源不能猜测恢复。首次协议升级重新 bootstrap/checkpoint；已经冻结的 schema 1 pending 按原文件 ID、原内容和原 schema 重试，保持 409 幂等。版本来源仅进同步 metadata，不进入运行时 word 或手工备份。
- 每个网络 await 和 IDB commit 前都重核验 个人资料库 owner 与 Drive `permissionId`，变化时不得推进游标或上传旧账号数据。`permissionId` 的核验手段是「重取 token，与已核验 token 的身份比对」（见 `drive-sync.md`《Drive 身份缓存》），不是每次都发 `about.get`。

## 高亮与笔记同步不变量

- `notes-sync.js` 保留 `chrome.storage.local` 的文章记录为权威内容。版本与待同步 ID 嵌入同一记录，以 `pbp-hl:<key>` 锁和单次 `set` 同时持久化内容及同步意图；远端应用、编辑、删除和 JSON 恢复共用此锁。
- 并发事件保留各叶的版本向量；合并只去掉被因果支配的叶，确定排序并保留并发笔记及删除事件。本机后续编辑从完整向量递增并吸收冲突，不能只拼接笔记字符串而丢掉因果来源。
- 冻结批次先持久化，再仅移除仍匹配该批次的待同步 ID；远端游标在本页所有文章写入成功后推进，重放必须幂等。删除标记不自动回收。

## 生词 owner、选择与刷新不变量（UI 层）

- 生词列表、筛选、选择、单删、批删与加组都限定当前非秘密 个人资料库 owner；资料库身份变化先清空旧 owner 的可见行，再读取新 owner，失败时保持 fail-closed。
- 原形通过 `pbpVocabSetLemma` 在事务内校验 owner 后修改；不改词条身份，不联动相关词形的笔记／学习状态。词形关系只在同 owner、同主语言内派生；无阅读语境的查词保存不得伪造句子或来源。
- 多语言 Anki 与完整 TSV 从原始词条保留笔记、原形及完整 context/source 对应。WordID 为已校验 `w.id` 的本机 SHA-256（`pbp-v1-` 前缀），不外发原始 owner；哈希等异步读取后重验 owner。多语言笔记类型显式 opt-in，默认原六字段；只新增／跳过重复，不迁移、修改或删除已有 Anki 笔记。
- UI 选择只影响批量删除和添加分组；TSV 与 Anki 始终处理当前 owner 的全部生词，欧路词典始终从当前 owner 全量中只发送 `en/fr/de/es`。
- 每次 mutation 在用户确认时取得刷新代际，旧 IDB 快照不得晚写覆盖新状态；最新 mutation 即使失败也要重读真实 IDB。事务内逐条 owner 校验不得移到 UI 层或省略。

测试夹具的原始事故（`driveFile()` 用写入侧构造器造远端文件）记在 `drive-sync.md` 末节。
