---
paths:
  - "dict-pack.js"
  - "options-vocab.js"
  - "md-dict.js"
  - "library-vocab.js"
---

# 词典深水区：离线词典包（Yomitan / ECDICT / CC-CEDICT）

> 2026-11-05 起词典规则拆成三份，按读到的文件分别加载：`dict.md` 管查词界面（在线词典、保存释义、查词卡布局与状态、负缓存）；`dict-entry.md` 管 AI 词条与补充的生成契约；本文件管离线词典包（Yomitan / ECDICT / CC-CEDICT）与查词槽的本地支线。md-dict.js 三份都会加载。

## 多语言 Yomitan 包不变量（dict-pack.js）

- 用户自备 Yomitan v3 ZIP，安装在独立的本机 `pbp-multidict` IndexedDB；不进入 Drive 或手工 JSON 备份。用户显式选义保存后，该释义才按普通生词规则同步、导出。
- 导入先逐 bank 校验并写暂存代际，全部成功后原子切换 `activeGeneration`；失败或取消保留旧版。安装、启停、删除走同一 Web Lock；重启清理无主代际，不能删正在导入的数据。
- 文件只作为数据读取，校验 ZIP 路径、大小、CRC 与本地/中央目录一致性；仅提取结构化文本，不加载词包 HTML、CSS、图片、音频或字体。上限以 `PBP_YOMITAN_LIMITS` 为准，超限拒绝而非静默截断安装。
- 包身份与词条语言、释义语言分开记录；查询按词条语言隔离，精确词形优先，读音命中的不同词头分别返回。每个命中保留实际词头、包来源与许可声明，不得把同音词或不同包的义项混为一条。
- 新导入以数值 `contentVersion: 1` 标记结构解析版本。只依据词包的显式结构分离独立释义、例句、词源与全文，不调用 AI 猜测；无法可靠拆分的内容仍作为完整词条可读，但不进入默认保存释义。旧版本已扁平化的数据无法逆向恢复结构，`contentVersion !== 1` 在设置提示重新导入同一词包；新版本的未知结构只显示全文，不反复提示重新导入。替换保留启停状态，不批量迁移或自动改写已存生词。
- 包的来源和许可只是文件/用户声明，不作授权保证。legacy `aiAllowed` 每次导入或替换仍为 false，当前产品不消费该字段、不发送词包内容。
- 多包结果与在线/ECDICT 分支独立，在线失败不阻断本地命中。启用包可扩充查词语言，界面语言、词条语言、词典释义语言和 AI 解释语言互不代替。结果被数量上限截断时必须给提示。

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
