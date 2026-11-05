---
paths:
  - "dict-archive.js"
  - "dict-archive-gdrive.js"
  - "ask-archive.js"
  - "ask-archive-gdrive.js"
  - "library-ask.js"
---

# AI 词条归档与 Ask 归档同步深水区

> 2026-11-05 起同步规则拆成三份：`vocab-sync.md` 管生词与高亮笔记的数据层不变量和生词 UI 层；`drive-sync.md` 管四类数据共用的 Drive 连接层、身份缓存、错误码与指引、OAuth 与权限；本文件管 AI 词条归档与 Ask 归档。

## AI 词条归档同步不变量

- `dict-archive.js` 维护独立的 `pbp-dict-archive` IndexedDB；`dict-archive-gdrive.js` 用 `dict-entry-batch` schema 4 写入、持续读取 schema 1/2/3/4，复用 Drive transport/runner，不把生成词条自动加入生词本。归档类别白名单 `PBP_DICT_ARCHIVE_CATEGORIES` 只增不减：停止生成的旧类别（collocations、register、grammar、scenarios、culture、literature）仍按原校验读取与同步；界面可生成的类别在 dict-entry.js 另行维护，不从白名单推导。
- 完整词条与追加用法是不可变的内容哈希记录；追加用法通过 `archiveId` 关联原词条，新版词条和补充可通过 `replacesId` 关联主动更新前的结果。远端按集合合并，保留不同设备独立生成的内容与以前版本，不能用最后写入覆盖并发追加。独立词源及部分结果的 `omittedItems` 从 schema 3 起写入，`patterns`（搭配与句型）记录从 schema 4 起写入；每一版新增的内容在之后各版继续合法，批次校验逐版用 `>=` 判定（例如 schema 4 批次里的词源与 `omittedItems` 照常合法），不得写成只认某一版的精确判等；schema 1/2/3 保持原契约，schema 3 及更早的批次含 `patterns` 即整批非法。协议升级重建 bootstrap/checkpoint，已冻结的 schema 1/2/3 pending 保持原文件 ID、原内容和原 schema 重试；旧端只按自己的 `readSchemas` 列文件，读不到 schema 4，而升级后新写入的**全部**批次（含基础词条、辨析、词源，不只 patterns）都是 schema 4，所以另一台设备在更新前读不到升级设备之后的任何新增内容，已有数据不受影响。
- 复用身份按 owner、保留大小写的词形和语言对匹配，提供商与模型只作溯源；补充另按类别和用户选定的学习资料匹配。已有 `dictctx2_entry_v1_` 缓存按 owner 幂等迁入归档，归档不随缓存 LRU 淘汰。
- 云端仅含 owner hash 与生成数据，不含明文 owner、凭据或 AI 端点。新版 `learning.version: 2` 保存构词/历史来源/相关词关系，或补充的解释语言、摘要及分项内容；公开资料保留标题、URL、精确短摘录及可核实的作者、作品、位置、语言、体裁、修订和取得时间。该次补充的母语、水平、主题也随补充保存并同步；旧字段结构继续可读，不能迁移时猜补来源；词典包不进入归档。
- 已连接设备在本机查无词条时可通过共享串行队列预取 dictionary 数据集；预取失败时不得自动调用 AI 重新付费。预取只检查已有 Drive 权限，不申请新权限；仍受 owner、Drive 身份、连接 epoch 和退避约束。

## Ask 归档同步不变量

- `ask-archive.js` 在独立 IndexedDB 保存完成的回答、引用证据、模型与时间。`ask-archive-gdrive.js` 以独立 `ask-history-batch` schema 1 复用共享 Drive 连接与队列；未登录记录仅本地保留，不认领给后来登录的账号。
- 每次回答为不可变记录；重生成通过 `replacesId` 关联旧版本，归档保留全部版本，发送给模型的上下文数量另有限制。新对话使用新 sessionId；明确删除使用永久会话墓碑，迟到/离线追加不得复活。
- 临时对话仅存当前页面内存，不写归档、不同步。旧 Ask 缓存按 owner、URL 幂等迁入现存数据；无法恢复已经被旧 LRU 淘汰的内容。读取失败不得当作没有历史。
- 每次持久写、远端提交、UI读取及继续提问均重验 owner。历史页继续提问只在用户点击时申请文章精确 origin，通过现有 pending reader 重新抽取；完整原文不进入归档。
