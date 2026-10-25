---
paths:
  - "md-dict.js"
  - "dict-pack.js"
  - "dict-entry.js"
  - "dict-evidence.js"
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
- 导入先逐 bank 校验并写暂存代际，全部成功后原子切换 `activeGeneration`；失败或取消保留旧版。安装、启停、删除走同一 Web Lock；重启清理无主代际，不能删正在导入的数据。
- 文件只作为数据读取，校验 ZIP 路径、大小、CRC 与本地/中央目录一致性；仅提取结构化文本，不加载词包 HTML、CSS、图片、音频或字体。上限以 `PBP_YOMITAN_LIMITS` 为准，超限拒绝而非静默截断安装。
- 包身份与词条语言、释义语言分开记录；查询按词条语言隔离，精确词形优先，读音命中的不同词头分别返回。每个命中保留实际词头、包来源与许可声明，不得把同音词或不同包的义项混为一条。
- 新导入以数值 `contentVersion: 1` 标记结构解析版本。只依据词包的显式结构分离独立释义、例句、词源与全文，不调用 AI 猜测；无法可靠拆分的内容仍作为完整词条可读，但不进入默认保存释义。旧版本已扁平化的数据无法逆向恢复结构，`contentVersion !== 1` 在设置提示重新导入同一词包；新版本的未知结构只显示全文，不反复提示重新导入。替换保留启停状态，不批量迁移或自动改写已存生词。
- 包的来源和许可只是文件/用户声明，不作授权保证。legacy `aiAllowed` 每次导入或替换仍为 false，当前产品不消费该字段、不发送词包内容。
- 多包结果与在线/ECDICT 分支独立，在线失败不阻断本地命中。启用包可扩充查词语言，界面语言、词条语言、词典释义语言和 AI 解释语言互不代替。结果被数量上限截断时必须给提示。

## 保存释义的默认选择

- 新查词默认选当前显示来源的第一条可保存释义；菜单内解释默认规则，不要求用户每次手动选择。手动选择在本次查词中保留，异步结果或来源视图切换不得覆盖它；所选来源停用、删除或失效后清除该选择并提示重新选择。
- 已存生词的释义不随查词或词包升级自动改写。用户从菜单选择解释并明确保存／更新后才写入；菜单内分别说明默认、手选、已存或需重选的状态。完整词条与词源不是独立释义，不得因为排在前面就成为默认保存值。

## 可复用 AI 词条（dict-entry.js）

- 基础词条发送词形、词条语言、解释语言，以及可选的公开词源短摘录和来源信息；不发送文章、句子、标题、词典包内容。文章语境由独立的“解释”功能处理。解释语言优先使用明确选择，其次为明确填写的母语，未填写时回退界面语言；不得据此反推用户母语。手动补充用法另发送已存 AI 词条、类别、可选母语/水平/主题；文学或文化类别还发送核对后的公开原文段落与来源信息。保存释义下拉框不控制补充范围。
- `dictDefaultView` 为 dictionary / ai-saved / ai-generate 三态；新安装默认 dictionary。旧 `dictAiAutoGenerate=false/true` 分别保留 ai-saved/ai-generate，迁移读取真实已存键，不把 defaults 插入的 false 当旧用户意愿。只有手动生成或 ai-generate 缺失才调用阅读器模型；总开关和密钥控制新生成，已保存数据仍可读。来源按钮仅影响本次查词，不暗记为自动付费设置。
- 输入词与公开资料是数据而非指令。词条按严格有界 JSON 验证，保留精确词头和语言；词性、释义、双语例句、构词、词源与相关词都作为纯文本呈现，不执行模型内容、不制造来源链接。新版学习内容保留结构：构词与历史来源分开，相关词区分词族/同源/近义/同主题；历史词源须有取得的来源，不把记忆联想当历史事实。补充按类别组织解释、例句、译文和对应含义；引用必须与来源原文一致，语言或结构验证失败不得保存成成功结果。
- 完整 AI 词条与补充持久保存于独立 `pbp-dict-archive`，按 owner、大小写词形与语言对复用，模型只作溯源；无需先保存生词，连接 Drive 后即可同步。旧 dictctx2_entry_v1_ 缓存按 owner 幂等迁入；归档不随 500 条 LRU 淘汰。首次本地 miss 在已有 Drive 连接时先预取，失败不自动重付。
- 读取、发送（含接口重试）、回写和返回均检查当前 owner、取消信号和活跃查询。自动路径不申请 host 权限；手动生成可一并申请精确 AI 与当次语言的 Wiktionary origin，自动路径缺少词源来源权限时跳过取材。文学/文化补充的直接点击只申请当次语言的精确 Wikisource/Wikipedia origin，不申请 wildcard。搜索只筛候选，随后读取正文及体裁/作品/作者/位置等信息；不能把搜索摘要当作文学引文，无法核对的来源不用于生成。文学/文化没有合适来源时不调用 AI；其他类别使用明确标识的 AI 编写例句。失败保存提供纯保存重试，不重新生成。
- 旧的付费词条和补充保持可读，不因内容标准升级而自动重新生成或覆盖。更新词条或补充必须由用户主动触发，说明 token 消耗并保留此前结果；新版内容及证据随原归档完整保存、同步。
- 普通词典与 AI 词条共用主视图，明确标注来源。来源切换不覆盖用户已选择保存的含义，不自动保存生词。词包的 legacy aiAllowed 元数据保留兼容，不再提供授权UI，也不再据此发送词包数据。

## ECDICT 英汉包不变量（dict-pack.js）

- 扩展只读 ECDICT 的 CSV 字段布局，**不发网络请求、不提供下载链接、不指向来源、不申请任何 host permission**——文件由用户自备，其许可由用户负责；UI 与 privacy.md 一律不得写成已确认的数据许可。
- 三档谓词 R1⊆R2⊆R3 **必须单调**（升档只增不减）；基础条件（`word` 归一后非空 AND `translation` trim 后非空 AND 按字面 `\n` 切分后至少一个非空 sense）先于 rung 判定。未闭合引号 → **拒绝整个文件**（跳行会让续行变成伪记录）。
- 导入是**原子替换**（IDB schema v2）：全量解析成功且所有资源门通过后才开唯一事务，`clear + put×N + meta.put` 同 scope `[ecdict, packs]`；`meta.put` 必须在最终批最后一个 request 的 `success` 回调内**同步**排入；**禁止**对 request error 调 `preventDefault()`。
- 查词槽拆 `.xp-dict-local` / `.xp-dict-online` 两个稳定子容器，**任何路径都不得 `replaceChildren()` slot 本身**；本地支线只在 `en` 启动、不被在线链 await、失败一律 UI 静默但须 `console.warn`，且不写 `cur.*`。
- 生词本可通过显式「保存／更新」动作保存用户选择的本地释义；这是普通 owner-scoped 生词写入，可随现有连接同步到 Drive。仅导入／显示本地条目不自动保存，阅读器本地支线仍不写 `cur.*`，不得把自备数据标成已确认许可。
- 导出侧的中文是**设备级现算**：compute-only，不回写 `pbp-vocab`、不进 Drive；原六字段 Anki/TSV 保持兼容，可选多语言 Anki 与完整 TSV 将补充释义及来源独立存列。性能验收走 `scripts/ecdict-import-perf.mjs`（不进 pre-commit / verify.sh）。
- CC-CEDICT 汉英包（.txt/.txt.gz/.zip）与 ECDICT 一样独立渲染，中文本地命中也继续展示已授权的在线结果；本地失败不阻断在线，在线失败不移除本地。library 自动驻留保留 250ms 门，完整在线缓存可立即展示；自动路径不申请权限。dict-pack 在 options 静载、md-preview 懒加载。
- 两个旧包的 `enabled` 存在本机包元数据，旧版缺字段视为启用。启停复用各自的导入/删除锁，停用不删词条，替换保留启停状态；查询与导出补充释义都检查该状态。`kind: "legacy"` 广播使当前查词完整重跑，清除已停用来源与待保存释义。
- CC-CEDICT 导入**刻意非原子**（先 clear 后流式写），因为该数据集从 MDBG 一键可再下载，丢了只赔一次下载；ECDICT 是用户自备文件、可能不可恢复，才值得为原子性付全量缓冲。取而代之的是 clear 之前的**前置探针门**：取前 `PBP_PACK_PROBE_LINES` 行试解析，候选行数达 `PBP_PACK_PROBE_MIN_CANDIDATES` 且命中率低于 `PBP_PACK_PROBE_MIN_RATIO` 时抛 `code="implausible_pack"`，此时 store 未被动过（探针行必须缓冲后回放，不得吞掉）。截断流与配额耗尽仍会丢旧包，但**只有 clear 事务提交之后**的失败才算：该 try 块内逃逸的错误才补 `code="pack_cleared"`（且 clear 前确实有 ready 包，首次导入无包可失）。**本仓的 code 契约是字符串**——原生 `DOMException` 自带 legacy **数字** `code`（QuotaExceededError 22 / NotFoundError 8 / InvalidStateError 11），而 `_pbpPackTx` 正是以 `tx.error`（DOMException）拒绝，所以判「有没有 code」必须用 `typeof code === "string"`，否则真实的配额失败会被漏判；又因 `DOMException.prototype.code` 是只读 getter，只能用 `Object.defineProperty` 影子覆盖（保留原对象的 name/message/stack），冻结对象才退化为包一层并把原错误挂 `cause`。三条文案按 code 分流，不可互换也不可合并——`implausible_pack` → `dictPackImplausible`（旧包未动）、`pack_cleared` → `dictPackFailedCleared`（旧包已没了，需重新导入）、其余（zip 结构损坏、读文件失败、UTF-8 非法、行过长、开库失败、clear 事务自身 abort、以及从未装过包的首次导入）→ 中性的 `dictPackFailed`，**不得声称旧包被移除**。
