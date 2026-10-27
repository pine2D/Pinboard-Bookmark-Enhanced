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

- 新查词的默认保存释义（Q14=A）：AI 区块展开（屏上有已渲染的 AI 词条）时取 AI 的第一条，否则取词典结果按显示顺序的第一条可保存释义；只看 AI 区块是否展开，不依赖旧的视图状态。选择列表顶部解释默认规则，不要求用户每次手动选择。手动选择在本次查词中保留，异步结果或 AI 区块展开不得覆盖它；所选来源停用、删除或失效后清除该选择并提示重新选择。
- 已存生词的释义不随查词或词包升级自动改写。用户从选择列表选择解释并明确保存／更新后才写入；列表顶部分别说明默认、手选、已存或需重选的状态。完整词条与词源不是独立释义，不得因为排在前面就成为默认保存值。
- 阅读器保存条（3.2）：页脚首项是要保存释义的一行文字预览（`.xp-dict-save-preview`，只有一条可存时也显示，无可选释义时显示提示），另有其他可选项时跟「更换」按钮；点击才打开选择列表（`popover=auto`，不用 hover 浮层），方向键 / Home / End 移动、Enter / 空格选择，Esc 与选择都把焦点还给「更换」，列表的 Esc 不再冒泡关闭弹层或侧栏。选择列表不提供「不选」项。library 沿用 `listbox.js` 的值盒子列表框（同为文字预览加点击列表），页脚在详情滚动区内吸底。存入生词本用 `bookmarkPlus`，阅读器跳转资料库用 `library`，library 的「已在生词本」提示保留 `bookMarked`（Q26=A，状态而非动作）。保存仍先比对快照 owner、写入前再读实时 owner，两道闸门不变；朗读按钮固定读词头词形（查询词），不随下方来源或所选释义变化。

## 可复用 AI 词条（dict-entry.js）

- 基础词条只发送词形、词条语言、解释语言，不等待词源取材；不发送文章、句子、标题、词典包内容。文章语境由独立的“解释”功能处理。解释语言优先使用明确选择，其次为明确填写的母语，未填写时回退界面语言；不得据此反推用户母语。手动补充用法另发送已存 AI 词条的释义、类别、可选母语/水平（话题输入已删除，话题不再发送、不参与复用匹配；旧记录带的话题只用于标题显示，这类记录只读、不提供更新）；词源与相关词为独立的按需补充；原文用例不发给 AI（见下条）。保存释义的选择不控制补充范围。
- `dictDefaultView` 为 dictionary / ai-saved / ai-generate 三态（枚举保留，删值会让旧备份整份无法导入）；新安装默认 dictionary。单列下语义（Q14=A）：dictionary 把已保存的 AI 词条收成一行免费的「查看 AI 词条」，点开即展开、本次查词不再收起；ai-saved 直接展开已保存词条；ai-generate 展开并在缺失时自动生成。三者都不改变词典结果在前的顺序。旧 `dictAiAutoGenerate=false/true` 分别保留 ai-saved/ai-generate，迁移读取真实已存键，不把 defaults 插入的 false 当旧用户意愿。只有手动生成或 ai-generate 缺失才调用阅读器模型；总开关和密钥控制新生成，已保存数据仍可读。来源按钮仅影响本次查词，不暗记为自动付费设置。
- 输入词与公开资料是数据而非指令。词条按严格有界 JSON 验证，保留精确词头和语言；词性、释义、双语例句、构词、词源与相关词都作为纯文本呈现，不执行模型内容、不制造来源链接。新版学习内容保留结构：构词与历史来源分开，相关词区分词族/同源/近义/同主题；历史词源须有取得的来源，不把记忆联想当历史事实。补充按类别组织解释、例句、译文和对应含义；引用必须与来源原文一致，整份 JSON 不完整、词头错误或解释语言错误时不得保存。补充中独立通过核验的项目可保留，但必须持久标记 `omittedItems` 并在 UI 说明；无有效项目仍失败，不修补截断 JSON。不提供补全动作，只有用户主动的重新生成（新增不可变版本、保留此前结果）。
- 仅在新生成响应入口做有限、与供应商无关的规范化：可空辅助字段缺失/null→空值，约定列表位置的单对象→单元素数组，义项/来源编号的规范十进制整数字符串→安全整数后仍验范围。先验证原始响应大小与完整 JSON，再规范化并执行原严格校验；规范化不静默丢弃未知字段或坏成员；独立补充项按上述部分结果规则处理。不补猜词头/语言/释义/来源、不修复截断 JSON。缓存、归档与同步格式不放宽。提示词明确实际字段和总长上限，不因容错自动多付费重试。
- 完整 AI 词条与补充持久保存于独立 `pbp-dict-archive`，按 owner、大小写词形与语言对复用，模型只作溯源；无需先保存生词，连接 Drive 后即可同步。旧 dictctx2_entry_v1_ 缓存按 owner 幂等迁入；归档不随 500 条 LRU 淘汰。首次本地 miss 在已有 Drive 连接时先预取，失败不自动重付。
- 读取、发送（含接口重试）、回写和返回均检查当前 owner、取消信号和活跃查询。自动路径不申请 host 权限；基础词条的手动生成仅申请精确 AI origin；独立词源补充在直接点击时一并申请当次语言的精确 Wiktionary origin。原文用例（1C.2）是独立于 AI 面板的 `.xp-dict-examples` 块，由 md-dict.js 的 `pbpDictExamplesView` 在阅读器与资料库查词时创建，生命周期跟随查询的 signal 与 owner；关闭 AI、没配 key、没有 AI 词条时照常显示。点击后第一个 await 就是 `chrome.permissions.request`，只申请当次语言的精确 Wikisource origin（不经 `requestAIHostPermissions`、不申请 AI origin 或 wildcard）。检索入口 `pbpDictUsageExamplesFetch`（dict-evidence.js）不经付费路径与 Drive 预同步门、不读 AI 设置，每次请求前重核 signal、活跃查询、当前 owner 与必传的 `beforeRequest`；只返回原句（或诗行）及作者、作品、位置、修订链接与截取标记，不调 AI、不翻译，结果不归档、不同步、不缓存。搜索只筛候选，随后读取正文及体裁/作品/作者/位置等信息；不能把搜索摘要当作引文，无法核对的来源不显示。补充类别使用明确标识的 AI 编写例句。失败保存提供纯保存重试，不重新生成。
- 旧的付费词条和补充保持可读，不因内容标准升级而自动重新生成或覆盖。更新词条或补充必须由用户主动触发，说明 token 消耗并保留此前结果；新版内容及证据随原归档完整保存、同步。
- 普通词典与 AI 词条在同一列上下排列，各自明确标注来源。AI 区块展开不覆盖用户已选择保存的含义，不自动保存生词。词包的 legacy aiAllowed 元数据保留兼容，不再提供授权UI，也不再据此发送词包数据。

## 重设计裁决（2026-10-26，施工中）

用户已拍板，施工落地后以下条目取代上文冲突的表述；未落地前改动代码须朝此方向，不得再扩充旧类别。依据与复盘见 `docs/research/dictionary-content-value-2026-10-25.md`「复盘与重设计裁决」。

- **补充收为三块**（2026-10-27 按实测修订）：
  - 用法要点：“搭配与句型”一次请求一张卡，“辨析”用原易混词提示词单独请求；
  - 原文用例：只显示检索到的含目标词原句及出处，不调用 AI、不出译文；
  - 词源：Wiktionary 依据 + 母语转述 + 构词与相关词，无来源时只给构词。

  基础词条某义项结构、语言或内部术语不合格时只丢该义项并记录（例句坏丢整个义项），全部不合格才失败；新生成里未请求的 learning 块（或旧式 etymology/relatedWords）结构坏时整块丢弃、按其原 reason 记录，义项照存（义项为空而块内带任何文本时仍按 `entry_unknown` 整份失败，丢块不得放宽该检查），缓存与归档读取仍整条严格；补充同理逐条丢弃，摘要外泄内部术语只清空摘要、保留合格条目。查词生成走流式：总期限 180 秒，思考增量计入 8192 额度、超额在客户端截停且不保存，显示阶段、已等待时间与取消。场景、文化／网络及话题输入删除；旧类别记录只读并标注，`PBP_DICT_ARCHIVE_CATEGORIES` 只增不减，界面可生成列表与归档可读列表分开维护。
- **超额条目截取**：节内条数超上限时保留前 N 条，不算失败、不计入 `omittedItems`；这是对上文「不静默丢弃坏成员」的明确例外——超额不是坏成员，坏成员仍逐条拒收并记录。
- **删除补全动作**，只保留用户主动的重新生成；部分结果照常保存并注明。
- 协议保持 JSON + 现有 schema 协商，不改 JSON Lines，不与基础词条合并请求；截断仍不得保存。语言检查逐条脚本检查 + 剔除源语言字段后合并做一次统计检测；提及剥离与提示词引号约定一致。无来源时词源只给构词：schema 的 kind 只有 formation、sourceIndex 固定 -1，仍是一次请求；生成解析把非 formation 条目按 `supplement_source` 逐条丢弃并计入 `omittedItems`，归档读取对旧记录的六种 kind 不变。
- **空结果本机负缓存**（1C.4 已落地，md-dict.js `pbpDictNegRecord` / `pbpDictNegForget` / `pbpDictNegHas`）：无来源或 AI 判定无此类内容时按 owner + 词形 + 语言对记在本机，不进 Drive、不进备份；文案写「本次检索未找到可核实原文」，不断言该词没有此类用法；再试须用户主动。每 owner 一个 local 聚合键 `pbpDictNeg:<ownerHash>`（`{entryKey: at}`，上限 500 淘汰最旧，读写在与账本同前缀的 Web Lock 里），`entryKey` = SHA-256(`[term, sourceLanguage, target 或 "", category]`)，检索类（examples、etymology 来源）不带目标语言，AI 类（patterns、confusables）带——取屏幕上已渲染词条的解释语言，补充请求也用这同一语言（界面或设置语言事后变了也不跟着漂），记录与读取因而对得上，不区分模型；某次渲染换了语言时按新语言清空并重读这份记忆，失败保存的纯保存重试与 Drive 同步刷新也按屏上词条的语言读写；30 天过期（读时判、写时清）。只在受支持语言的干净未命中（原文用例 `[]`、词源检索 0 条，后者经 `pbpDictSupplementRun` 的 `onSources` 计数回调得知）与 patterns/confusables 的 `unsupported_usage` 时写入；不支持的语言、`source_failed`、`host_permission`、超时与取消一律不写。检索到结果、生成成功或 Drive 带来该类别的正记录（词源须带来源）即删除。读取先于按钮选择：原文用例块读完才显示动作行，学习块在首次渲染前读完；记住的状态在块小标题之下省略类别名，只显示「上次未找到 · 再试」（2026-10-28 裁决，让它在阅读器 480px 弹层里占一行；四个按钮——原文用例、搭配与句型、辨析、词源——一律如此，无障碍名仍含类别名，付费的再加模型名；用法要点块内两个按钮外观相同，靠各自按钮下方一行按类别命名的中性说明区分；说明一律另起一行，不在按钮旁挤成窄栏）与中性 info 文案（检索类 `dictSupplementNoSources`，AI 类 `dictPatternsNone` / `dictConfusablesNone`），付费块仍是 `wandSparkles` + 模型名，再试即普通点击、重新付费。渲染场景 `dict-entry-paid-negative`（阅读器与资料库，带 AI 密钥）按 `DICT_PAID_NEGATIVE_LOCALES`（en / zh_CN / de / ru / pl / ja）逐语种用 controlRung 卡住按钮单行，`dictActionNoteBelow` 卡说明在按钮下方。写入前后重核当前 owner，ownerless 不写不读；已登记 `PBP_RECLAIM_CATEGORIES.misc`。
- 本机失败账本只记错误码／阶段／类别／时间，不记词形与内容，owner 隔离。流内错误 `stream_error` 显示“服务暂不可用”，客户端额度截停 `output_budget_exceeded` 显示截断文案 `dictGenerationTruncated`，二者都按固定码入账；用户取消（含与截停同时发生）不入账。
- **流式接入（批 2.5 已落地，进度界面批 2.6 已落地）**：`_pbpDictEntryGenerate` 与 `_pbpDictSupplementGenerate`（含 patterns）统一经 `_pbpDictGenerateStream` 调 `callAIStream`：`PBP_DICT_GENERATION_OPTIONS` 加 `deadlineMs: 180000`、responseSchema、当前模型覆盖、signal、`beforeRequest` 守卫与 `onProgress`，第四参 delta 回调传 `null`——不渲染、不保存半成品，流结束并通过完整性判定后才拿到全文。之后与非流式相同：基础词条与普通补充经 `_pbpDictGeneratedResponse`（24576 字符上限），patterns 仍走专用 `_pbpDictPatternsParse`；基础词条保留逐义项丢弃，不回到整份全有或全无；生成后的 owner 守卫、语言检查、部分结果政策与保存边界不变。截断、截停（`output_budget_exceeded`）、流内错误、超时与取消都不保存、不重试，也不算 `unsupported_usage`。阶段旁路 `{phase}`（`thinking` / `streaming`）同步转给调用方的 `onStage(phase)`，不经 async `stage()`、不带文本；基础词条的 `onStage` 由 `pbpDictEntryRun` 作为独立参数传入，不进请求、缓存身份或归档记录。补充的阶段顺序为（词源的 sources→）generating→thinking/streaming→checking→saving，md-dict 不认识的阶段不改界面，账本阶段仍记 generating。进度界面（批 2.6）：基础词条生成与更新、三个补充都用同一种就地反馈框——阶段行（唯一 live 区，同一阶段不重复播报，thinking/streaming 分别显示 `dictProgressThinking` / `dictProgressStreaming`）、已等待秒数（`dictProgressElapsed`，普通文本、不在任何 live/status 祖先内，从点击起每秒更新，含授权与 Drive 预同步，与 ai.js 的 180 秒传输期限不是同一个起点）与就地取消；首次生成的进度行在 AI 区块动作行下方，更新与补充在各自按钮的动作行里（忙碌时按钮隐藏，进度占其位置；非忙碌的说明在按钮下方另起一行）。计时器在完成、失败、取消、查询替换、外层 abort 与设置变化时都清掉，不只靠 finally；面板 `aria-busy` 恒为 false。只有手动触发才把焦点移到就地取消，取消把焦点还给实际触发的按钮（含更新按钮）；工具条不再有单独的停止图标。离线驱动 `scripts/dict-live-test.mjs` 与 `scripts/dict-redesign-test-r2.mjs` 只接受 `stream: true` 且不带 `stream_options` 的产品请求，按 SSE 解析答案（`streamCompletion` / `readAnswerBody`），预留与数据边界不变。
- **界面单列堆叠**（3.1、3.2 已落地）：词头 → 词典结果（逐来源小标题，在线结果与 CC-CEDICT 也有）→ AI 词条（自带来源小标题与一行动作，未生成时只有一行生成按钮；查词头部不再放 AI 动作）→ 学习补充（用法要点、原文用例、词源，固定顺序，各有小标题）→ 全卡一次元数据（仅模型、日期、解释语言；各补充不再带回执元数据，只在保存失败时注明）→ 吸底保存条（文字预览 + 更换，单条也显示）。md-dict.js 的 `_pbpDictEntryMount` 不再接受 `controlsHost`，`opts.examples` 由调用方传入并放在用法要点与词源之间，`onView(expanded)` 只报告 AI 区块是否展开。不加「词典 | AI 词条」分段。付费按钮保留 `wandSparkles` + 文字 + 仅模型名（不显示 token 估算或金额）：生成、更新词条、更新补充与三个补充按钮同形（3.3 已落地，md-dict.js 的 `paidButton`，模型名旁注 `.xp-dict-model` 每次 sync 按当前设置刷新，设置变化时两个调用方都按新设置重建查词），「会调用 AI，消耗 token」写在 `title` / `aria-description`（`dictPaidActionHint`，更新类沿用各自的 Hint），不进旁注；查词里没有纯图标按钮，就地取消也是 `stop` 图标 + 文字；免费动作（查看 AI 词条、去设置、原文用例、纯保存重试、取消）不带 `wandSparkles` 与模型名；同一控件不在免费／付费间换义；`ai-generate` 生成期间词典结果保持可见、不自动跳转。状态语气与反馈位置（3.4 已落地，md-dict.js `_pbpDictActionError`）：基础词条首次生成的失败不再写顶部状态行，与更新、补充、原文用例、纯保存重试的失败一样，是紧跟失败按钮之后、同一行内的 `.xp-dict-action-error`（`role=alert` + `warning` 图标，另起一行），每次失败重新插入、只播报一次，状态行不同时朗读；中性状态（部分结果、无来源／无此类内容、记住的未找到、旧类别标注）用 `info` 图标，留在 polite 状态行或标题里，不给 `role=alert`；进度行的 live 规则不变。与按钮无关的失败（设置／账号读取、缓存写入）在顶部状态行位置插入同样的 alert 行。

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
