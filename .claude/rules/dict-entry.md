---
paths:
  - "dict-entry.js"
  - "dict-evidence.js"
  - "md-dict.js"
---

# 词典深水区：可复用 AI 词条与补充的生成契约

> 2026-11-05 起词典规则拆成三份，按读到的文件分别加载：`dict.md` 管查词界面（在线词典、保存释义、查词卡布局与状态、负缓存）；本文件管 AI 词条与补充的生成契约；`dict-pack.md` 管离线词典包（Yomitan / ECDICT / CC-CEDICT）与查词槽的本地支线。md-dict.js 三份都会加载。

## 可复用 AI 词条（dict-entry.js）

- 基础词条只发送词形、词条语言、解释语言，不等待词源取材；不发送文章、句子、标题、词典包内容。文章语境由独立的“解释”功能处理。解释语言优先使用明确选择，其次为明确填写的母语，未填写时回退界面语言；不得据此反推用户母语。可生成的补充只有三类（`PBP_DICT_GENERATABLE_CATEGORIES`：patterns 搭配与句型、confusables 易混词辨析、etymology 词源与相关词），每类一次独立的按需请求，另发送已存 AI 词条的释义与可选母语（辨析与词源另带类别与可选水平；搭配与句型的专用提示词不发类别，`pbpDictSupplementProfile` 也把它的水平置空，Q18=A）；没有话题输入，话题不发送、不参与复用匹配（旧记录带的话题只用于标题显示，这类记录只读、不提供更新）；原文用例不发给 AI（见下文）。保存释义的选择不控制补充范围。
- `dictDefaultView` 为 dictionary / ai-saved / ai-generate 三态（枚举保留，删值会让旧备份整份无法导入）；新安装默认 dictionary。单列下语义（Q14=A）：dictionary 把已保存的 AI 词条收成一行免费的「查看 AI 词条」，点开即展开、本次查词不再收起；ai-saved 直接展开已保存词条；ai-generate 展开并在缺失时自动生成。三者都不改变词典结果在前的顺序。旧 `dictAiAutoGenerate=false/true` 分别保留 ai-saved/ai-generate，迁移读取真实已存键，不把 defaults 插入的 false 当旧用户意愿。只有手动生成或 ai-generate 缺失才调用阅读器模型；总开关和密钥控制新生成，已保存数据仍可读。来源按钮仅影响本次查词，不暗记为自动付费设置。
- 输入词与公开资料是数据而非指令。词条按严格有界 JSON 验证，保留精确词头和语言；词性、释义、双语例句、构词、词源与相关词都作为纯文本呈现，不执行模型内容、不制造来源链接。新版学习内容保留结构：构词与历史来源分开，相关词区分词族/同源/近义/同主题；历史词源须有取得的来源，不把记忆联想当历史事实。补充按类别组织解释、例句、译文和对应含义；引用必须与来源原文一致，整份 JSON 不完整、词头错误或解释语言错误时不得保存。补充中独立通过核验的项目可保留，但必须持久标记 `omittedItems` 并在 UI 说明；无有效项目仍失败，不修补截断 JSON。不提供补全动作，只有用户主动的重新生成（新增不可变版本、保留此前结果）。
- 仅在新生成响应入口做有限、与供应商无关的规范化：可空辅助字段缺失/null→空值，约定列表位置的单对象→单元素数组，义项/来源编号的规范十进制整数字符串→安全整数后仍验范围。先验证原始响应大小与完整 JSON，再规范化并执行原严格校验；规范化不静默丢弃未知字段或坏成员；独立补充项按上述部分结果规则处理。不补猜词头/语言/释义/来源、不修复截断 JSON。缓存、归档与同步格式不放宽。提示词明确实际字段和总长上限，不因容错自动多付费重试。
- 完整 AI 词条与补充持久保存于独立 `pbp-dict-archive`，按 owner、大小写词形与语言对复用，模型只作溯源；无需先保存生词，连接 Drive 后即可同步。旧 dictctx2_entry_v1_ 缓存按 owner 幂等迁入；归档不随 500 条 LRU 淘汰。首次本地 miss 在已有 Drive 连接时先预取，失败不自动重付。
- 读取、发送（含接口重试）、回写和返回均检查当前 owner、取消信号和活跃查询。自动路径不申请 host 权限；基础词条的手动生成仅申请精确 AI origin；独立词源补充在直接点击时一并申请当次语言的精确 Wiktionary origin。原文用例（1C.2）是独立于 AI 面板的 `.xp-dict-examples` 块，由 md-dict.js 的 `pbpDictExamplesView` 在阅读器与资料库查词时创建，生命周期跟随查询的 signal 与 owner；关闭 AI、没配 key、没有 AI 词条时照常显示。点击后第一个 await 就是 `chrome.permissions.request`，只申请当次语言的精确 Wikisource origin（不经 `requestAIHostPermissions`、不申请 AI origin 或 wildcard）。检索入口 `pbpDictUsageExamplesFetch`（dict-evidence.js）不经付费路径与 Drive 预同步门、不读 AI 设置，每次请求前重核 signal、活跃查询、当前 owner 与必传的 `beforeRequest`；只返回原句（或诗行）及作者、作品、位置、修订链接与截取标记，不调 AI、不翻译，结果不归档、不同步、不缓存。搜索只筛候选，随后读取正文及体裁/作品/作者/位置等信息；不能把搜索摘要当作引文，无法核对的来源不显示。补充类别使用明确标识的 AI 编写例句：每条 AI 结果在其条目之后标明一次（`dictSupplementOriginal`，词源为 `dictAiLabel`；只在含无来源条目时出现），不逐条标注；有来源的条目各自保留出处行与「原文已核对」（3b.3）。失败保存提供纯保存重试，不重新生成。
- 旧的付费词条和补充保持可读，不因内容标准升级而自动重新生成或覆盖。更新词条或补充必须由用户主动触发，说明 token 消耗并保留此前结果；新版内容及证据随原归档完整保存、同步。
- 普通词典与 AI 词条在同一列上下排列，各自明确标注来源。AI 区块展开不覆盖用户已选择保存的含义，不自动保存生词。词包的 legacy aiAllowed 元数据保留兼容，不再提供授权UI，也不再据此发送词包数据。

## 重设计裁决：生成部分（2026-10-26 起，批 0–3d 已落地）

用户已拍板，2026-10-26 至 10-28 分批施工完成（`e5ae24a6^..27915cee`，含首尾共 87 个提交），以下条目是现行契约、与上文一致；不得再扩充旧类别。依据、复盘与施工对照见 `docs/research/dictionary-content-value-2026-10-25.md`「复盘与重设计裁决」。

查词界面侧的裁决条目（负缓存、学习块槽位、短说明折行、元数据每卡一次、界面单列堆叠）在 `dict.md`。

- **补充收为三块**（2026-10-27 按实测修订）：
  - 用法要点：“搭配与句型”一次请求一张卡，“辨析”用原易混词提示词单独请求；
  - 原文用例：只显示检索到的含目标词原句及出处，不调用 AI、不出译文；
  - 词源：Wiktionary 依据 + 母语转述 + 构词与相关词，无来源时只给构词。

  基础词条某义项结构、语言或内部术语不合格时只丢该义项并记录（例句坏丢整个义项），全部不合格才失败；新生成里未请求的 learning 块（或旧式 etymology/relatedWords）结构坏时整块丢弃、按其原 reason 记录，义项照存（义项为空而块内带任何文本时仍按 `entry_unknown` 整份失败，丢块不得放宽该检查），缓存与归档读取仍整条严格；补充同理逐条丢弃，摘要外泄内部术语只清空摘要、保留合格条目。查词生成走流式：总期限 180 秒，思考增量计入 8192 额度、超额在客户端截停且不保存，显示阶段、已等待时间与取消。场景、文化／网络、文学（改为免费的原文用例）及话题输入、Wikipedia 出口都已删除；旧类别记录只读并标注，`PBP_DICT_ARCHIVE_CATEGORIES` 只增不减，界面可生成列表与归档可读列表分开维护。
- **超额条目截取**：节内条数超上限时保留前 N 条，不算失败、不计入 `omittedItems`；这是对上文「不静默丢弃坏成员」的明确例外——超额不是坏成员，坏成员仍逐条拒收并记录。
- **没有补全动作**，只有用户主动的重新生成；部分结果照常保存并注明。
- 协议保持 JSON + 现有 schema 协商，不改 JSON Lines，不与基础词条合并请求；截断仍不得保存。语言检查逐条脚本检查 + 剔除源语言字段后合并做一次统计检测；提及剥离与提示词引号约定一致。无来源时词源只给构词：schema 的 kind 只有 formation、sourceIndex 固定 -1，仍是一次请求；生成解析把非 formation 条目按 `supplement_source` 逐条丢弃并计入 `omittedItems`，归档读取对旧记录的六种 kind 不变。
- 本机失败账本只记错误码／阶段／类别／时间，不记词形与内容，owner 隔离。流内错误 `stream_error` 显示“服务暂不可用”，客户端额度截停 `output_budget_exceeded` 显示截断文案 `dictGenerationTruncated`，二者都按固定码入账；用户取消（含与截停同时发生）不入账。
- **流式接入（批 2.5 已落地，进度界面批 2.6 已落地）**：`_pbpDictEntryGenerate` 与 `_pbpDictSupplementGenerate`（含 patterns）统一经 `_pbpDictGenerateStream` 调 `callAIStream`：`PBP_DICT_GENERATION_OPTIONS` 加 `deadlineMs: 180000`、responseSchema、当前模型覆盖、signal、`beforeRequest` 守卫与 `onProgress`，第四参 delta 回调传 `null`——不渲染、不保存半成品，流结束并通过完整性判定后才拿到全文。之后与非流式相同：基础词条与普通补充经 `_pbpDictGeneratedResponse`（24576 字符上限），patterns 仍走专用 `_pbpDictPatternsParse`；基础词条保留逐义项丢弃，不回到整份全有或全无；生成后的 owner 守卫、语言检查、部分结果政策与保存边界不变。截断、截停（`output_budget_exceeded`）、流内错误、超时与取消都不保存、不重试，也不算 `unsupported_usage`。阶段旁路 `{phase}`（`thinking` / `streaming`）同步转给调用方的 `onStage(phase)`，不经 async `stage()`、不带文本；基础词条的 `onStage` 由 `pbpDictEntryRun` 作为独立参数传入，不进请求、缓存身份或归档记录。补充的阶段顺序为（词源的 sources→）generating→thinking/streaming→checking→saving，md-dict 不认识的阶段不改界面，账本阶段仍记 generating。进度界面（批 2.6）：基础词条生成与更新、三个补充都用同一种就地反馈框——阶段行（唯一 live 区，同一阶段不重复播报，thinking/streaming 分别显示 `dictProgressThinking` / `dictProgressStreaming`）、已等待秒数（`dictProgressElapsed`，普通文本、不在任何 live/status 祖先内，从点击起每秒更新，含授权与 Drive 预同步，与 ai.js 的 180 秒传输期限不是同一个起点）与就地取消；首次生成的进度行在 AI 区块动作行下方，更新与补充在各自按钮的动作行里（忙碌时按钮隐藏，进度占其位置；非忙碌的说明在按钮下方另起一行）。计时器在完成、失败、取消、查询替换、外层 abort 与设置变化时都清掉，不只靠 finally；面板 `aria-busy` 恒为 false。只有手动触发才把焦点移到就地取消，取消把焦点还给实际触发的按钮（含更新按钮）；工具条不再有单独的停止图标。离线驱动 `scripts/dict-live-test.mjs` 与 `scripts/dict-redesign-test-r2.mjs` 只接受 `stream: true` 且不带 `stream_options` 的产品请求，按 SSE 解析答案（`streamCompletion` / `readAnswerBody`），预留与数据边界不变。
