---
paths:
  - "md-dict.js"
  - "dict-pack.js"
  - "dict-entry.js"
  - "md-vocab-echo.js"
  - "ai-cache.js"
---

# 词典深水区（在线词典 / 离线词典包 / 缓存）

## 在线词典不变量（md-dict.js）

- `dict2_` 缓存键保留大小写；查询链：原词精确 → 语义未命中后的小写候选 → 再未命中后的可选 lemma 参数（当前界面传空值，不为此生成 AI）。
- 只有 HTTP 404 与 HTTP 200 空/不可渲染结果属于**语义未命中**；超时、断网、429、5xx 和坏 JSON 都是**加载失败**，不能伪装成「没有词条」。实测（2026-07-29）：线上服务对查无此词返回 `200 + {"entries":[]}`，不是 404——404 分支是防御性保留（代理/上游变更），别当主路径读，也别因为「没见过 404」就删掉。
- Free Dictionary API 连续 3 次网络类失败后在本会话熔断 60 秒，父级 abort 不计失败；Wiktionary 兜底固定导航到 English Wiktionary，不是后台请求。
- `dict2_` 最多保留 **500 条缓存**（独立 LRU）；其他缓存仍最多 200 条（全局上限）。这不限制查词次数、`pbp-vocab` 生词数量或 CC-CEDICT 词条数；原词别名与实际命中词可分别占一条记录。

## 多语言 Yomitan 包不变量（dict-pack.js）

- 用户自备 Yomitan v3 ZIP，安装在独立的本机 `pbp-multidict` IndexedDB；不进入 Drive 或手工 JSON 备份。用户显式选义保存后，该释义才按普通生词规则同步、导出。
- 导入先逐 bank 校验并写暂存代际，全部成功后原子切换 `activeGeneration`；失败或取消保留旧版。安装、启停、AI 开关、删除走同一 Web Lock；重启清理无主代际，不能删正在导入的数据。
- 文件只作为数据读取，校验 ZIP 路径、大小、CRC 与本地/中央目录一致性；仅提取结构化文本，不加载词包 HTML、CSS、图片、音频或字体。上限以 `PBP_YOMITAN_LIMITS` 为准，超限拒绝而非静默截断安装。
- 包身份与词条语言、释义语言分开记录；查询按词条语言隔离，精确词形优先，读音命中的不同词头分别返回。每个命中保留实际词头、包来源与许可声明，不得把同音词或不同包的义项混为一条。
- 包的来源和许可只是文件/用户声明，不作授权保证。legacy `aiAllowed` 每次导入或替换仍为 false，当前产品不消费该字段、不发送词包内容。
- 多包结果与在线/ECDICT 分支独立，在线失败不阻断本地命中。启用包可扩充查词语言，界面语言、词条语言、词典释义语言和 AI 解释语言互不代替。结果被数量上限截断时必须给提示。

## 可复用 AI 词条（dict-entry.js）

- 查词只发送词形、词条语言和释义语言；不发送文章、句子、标题、词典包内容。文章语境由独立的“解释”功能处理。
- 默认只读已有缓存；dictAiAutoGenerate 默认 false，只有手动生成或显式开启自动生成才调用用户配置的阅读器模型。阅读器 AI 总开关和密钥控制新生成；已生成数据仍可读。
- 输入词是数据而非指令。词条按严格有界 JSON 验证，保留精确词头和语言；词性、释义、双语例句、可选词源与相关词都作为纯文本呈现，不执行模型内容、不制造来源链接。
- 缓存用 dictctx2_entry_v1_ 命名空间，复用隔离的 500 条 AI 词典 LRU 池。身份包括大小写词形、语言对、schema 版本、owner、提供商、有效模型和端点，不含文章语境或凭据；生成时间独立于 LRU 时间。
- 缓存读取、发送（含接口重试）、回写和返回均检查当前 owner、取消信号和活跃查询。自动路径不申请 host 权限，手动点击只请求配置的精确 AI origin。
- 普通词典与 AI 词条共用主视图，明确标注来源。来源切换不覆盖用户已选择保存的含义，不自动保存生词。词包的 legacy aiAllowed 元数据保留兼容，不再提供授权UI，也不再据此发送词包数据。

## ECDICT 英汉包不变量（dict-pack.js）

- 扩展只读 ECDICT 的 CSV 字段布局，**不发网络请求、不提供下载链接、不指向来源、不申请任何 host permission**——文件由用户自备，其许可由用户负责；UI 与 privacy.md 一律不得写成已确认的数据许可。
- 三档谓词 R1⊆R2⊆R3 **必须单调**（升档只增不减）；基础条件（`word` 归一后非空 AND `translation` trim 后非空 AND 按字面 `\n` 切分后至少一个非空 sense）先于 rung 判定。未闭合引号 → **拒绝整个文件**（跳行会让续行变成伪记录）。
- 导入是**原子替换**（IDB schema v2）：全量解析成功且所有资源门通过后才开唯一事务，`clear + put×N + meta.put` 同 scope `[ecdict, packs]`；`meta.put` 必须在最终批最后一个 request 的 `success` 回调内**同步**排入；**禁止**对 request error 调 `preventDefault()`。
- 查词槽拆 `.xp-dict-local` / `.xp-dict-online` 两个稳定子容器，**任何路径都不得 `replaceChildren()` slot 本身**；本地支线只在 `en` 启动、不被在线链 await、失败一律 UI 静默但须 `console.warn`，且不写 `cur.*`。
- 生词本可通过显式「保存／更新」动作保存用户选择的本地释义；这是普通 owner-scoped 生词写入，可随现有连接同步到 Drive。仅导入／显示本地条目不自动保存，阅读器本地支线仍不写 `cur.*`，不得把自备数据标成已确认许可。
- 导出侧的中文是**设备级现算**：compute-only，不回写 `pbp-vocab`、不进 Drive；原六字段 Anki/TSV 保持兼容，可选多语言 Anki 与完整 TSV 将补充释义及来源独立存列。性能验收走 `scripts/ecdict-import-perf.mjs`（不进 pre-commit / verify.sh）。
- CC-CEDICT 汉英包（.txt/.txt.gz/.zip）命中中文查词时短路在线链；dict-pack 在 options 静载、md-preview 懒加载。
- CC-CEDICT 导入**刻意非原子**（先 clear 后流式写），因为该数据集从 MDBG 一键可再下载，丢了只赔一次下载；ECDICT 是用户自备文件、可能不可恢复，才值得为原子性付全量缓冲。取而代之的是 clear 之前的**前置探针门**：取前 `PBP_PACK_PROBE_LINES` 行试解析，候选行数达 `PBP_PACK_PROBE_MIN_CANDIDATES` 且命中率低于 `PBP_PACK_PROBE_MIN_RATIO` 时抛 `code="implausible_pack"`，此时 store 未被动过（探针行必须缓冲后回放，不得吞掉）。截断流与配额耗尽仍会丢旧包，但**只有 clear 事务提交之后**的失败才算：该 try 块内逃逸的错误才补 `code="pack_cleared"`（且 clear 前确实有 ready 包，首次导入无包可失）。**本仓的 code 契约是字符串**——原生 `DOMException` 自带 legacy **数字** `code`（QuotaExceededError 22 / NotFoundError 8 / InvalidStateError 11），而 `_pbpPackTx` 正是以 `tx.error`（DOMException）拒绝，所以判「有没有 code」必须用 `typeof code === "string"`，否则真实的配额失败会被漏判；又因 `DOMException.prototype.code` 是只读 getter，只能用 `Object.defineProperty` 影子覆盖（保留原对象的 name/message/stack），冻结对象才退化为包一层并把原错误挂 `cause`。三条文案按 code 分流，不可互换也不可合并——`implausible_pack` → `dictPackImplausible`（旧包未动）、`pack_cleared` → `dictPackFailedCleared`（旧包已没了，需重新导入）、其余（zip 结构损坏、读文件失败、UTF-8 非法、行过长、开库失败、clear 事务自身 abort、以及从未装过包的首次导入）→ 中性的 `dictPackFailed`，**不得声称旧包被移除**。
