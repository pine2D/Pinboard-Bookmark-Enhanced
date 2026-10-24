# 多语言词库与查词 AI 调研基准稿

调研日期：2026-10-24。此稿保存实施前的结论，作为本轮完成后的回顾依据。来源覆盖及许可描述以当天可访问的官方资料为准，不代表商业授权或生产接入测试已经完成。

## 用户与语言模型

同时服务英语母语者学习中文、德语、西语等，以及这些语言的母语者学习英语或其他语言。界面语言、所查词语语言、词典原始释义语言、AI 解释语言分别处理；支持单语学习模式。词典方向必须明确，不能将一个语言对包反向查询视为完整的反向词典。

现有 FreeDictionaryAPI.com 使用英文版 Wiktionary：查词参数指定词条语言，不指定释义语言。多语言对译字段不等于整段释义已翻译；扩展现有的 12 种语言也不是服务的全量覆盖。

来源：<https://freedictionaryapi.com/>、<https://freedictionaryapi.com/api/v1/openapi.json>。

## 离线候选

| 候选 | 覆盖与形式 | 选型与边界 |
|---|---|---|
| Kaikki / Wiktextract | 不同 Wiktionary edition 的 JSONL。英文 edition 收录数百种词条语言，释义为英文；其他 edition 提供其他释义语言。可含词义、词性、变形、读音、例句。 | 广覆盖基础。应按词条语言与释义语言拆包；当天英文全量约 24.8GB、gzip 2.9GB，不适合在扩展内处理整库。旧 post-processed 下载已弃用。保留 Wiktionary 来源与相应许可。 |
| WikDict | 德→英、西→英、德→法等双语方向；StarDict、SQLite。 | 适合轻量语言对包，偏对译，不能承诺完整学习型释义。数据 CC BY-SA 4.0，与生成器代码许可分开。 |
| FreeDict | 欧洲语言及阿拉伯语、斯瓦希里语、沃洛夫语等部分语言对；TEI XML、StarDict、Dictd、SLOB。 | 按需补充。各包覆盖和质量差异大，逐包检查许可、版本、词条数和质量状态。包重建日期不等于内容更新时间。 |
| JMdict / Jitendex | 日语写法、读音、义项；JMdict XML 含英、德、法、俄、西、匈、斯洛文尼亚、荷兰释义，覆盖不一，每日生成。Jitendex 主要日→英，可用 Yomitan/MDict。 | 日语专项优先。保留义项与读音的适用关系。JMdict 日英部分现行 CC BY-SA 4.0，其他语言另核贡献者条款。Jitendex 例句、音频另有来源许可；更新频率以具体发行日期为准。 |
| OpenRussian | 俄→英/德，重音、变格、变位等；当前通过 TogetherDB 导出 CSV。 | 俄语专项。旧 GitHub CSV 已过时，需验证当前表结构。音频不属于其开放数据。 |

官方来源：

- Kaikki：<https://kaikki.org/dictionary/rawdata.html>、<https://kaikki.org/dictionary/>。
- WikDict：<https://www.wikdict.com/page/download>、<https://www.wikdict.com/page/about>。
- FreeDict：<https://freedict.org/downloads/>、<https://freedict.org/documentation/>、<https://freedict.org/freedict-database.json>。
- JMdict：<https://www.edrdg.org/wiki/Main_Page.html>、<https://www.edrdg.org/edrdg/licence.html>。
- Jitendex：<https://jitendex.org/pages/downloads.html>、<https://jitendex.org/pages/legal.html>。
- OpenRussian：<https://en.openrussian.org/dictionary-data>、<https://en.openrussian.org/>、<https://de.openrussian.org/>。

推荐评估经过筛选的 Yomitan 格式包作为通用入口，先支持文本释义、读音、词形、来源元数据。Yomitan 生态已有多语 Wiktionary、日语、韩语、粤语词典；WTY 提供 Wiktionary 转换包。Yomitan、StarDict、MDict 是格式，不是版权许可；Kaikki、WTY、WikDict 也不能算三个独立词义证据来源。

来源：<https://yomitan.wiki/dictionaries/>、<https://yomidevs.github.io/wiktionary-to-yomitan/>。

## 在线候选

| 候选 | 覆盖 | 适配判断 |
|---|---|---|
| KRDICT，韩国国立国语院基础词典 | 韩语词条及韩语释义，可附英、日、法、西、阿、蒙、越、泰、印尼、俄、中 11 种译文；XML API，邮箱申请 key，官网标每日 50,000 次。 | 新增在线源优先候选。文本默认 CC BY-SA 2.0 KR；图片、音视频、发音逐项核许可。不是任意语言互译服务。 |
| PONS | 多语双语词典，包含英德、英西、英中、德中、西中等；具体词典以目录与 key 授权为准。 | 需进一步确认持久缓存、收藏同步、导出和 AI 权限。目录存在不等于账号已获授权。 |
| Lexicala | 多语言单语核心、双语数据和学习词典资源，部分对译为自动扩展。 | 普通 API FAQ 禁止本地缓存；离线可另谈 XML/JSON 数据许可。不能直接接现有缓存→生词→Drive→Anki 链路。 |
| Oxford Dictionaries API | 单语释义、双语翻译等，按语言与端点分别提供。 | 普通条款限制持久存储，并明确限制 AI prompt/ground 等用途。另行获得适用授权后再评估；缓存许可不自动等于 AI 许可。 |

官方来源：

- KRDICT：<https://krdict.korean.go.kr/kor/openApi/openApiInfo>、<https://krdict.korean.go.kr/kor/openApi/openApiRegister>、<https://krdict.korean.go.kr/kor/kboardPolicy/copyRightTermsInfo>。
- PONS：<https://en.pons.com/p/online-dictionary/developers/api>、<https://api.pons.com/v1/dictionaries?language=en>、<https://en.pons.com/p/agb-api>。
- Lexicala：<https://api.lexicala.com/documentation/>。
- Oxford：<https://developer.oxforddictionaries.com/documentation/languages>、<https://developer.oxforddictionaries.com/api-terms-and-conditions>。

未注册商业账号或申请 API key。PONS 公开目录读取成功；FreeDictionaryAPI 官网/OpenAPI 可读，但本次本机通用词和语言目录请求返回 403，不能据此判定全体用户不可用。生产可用性需在扩展内另行验证。

## 查词与 AI 的产品参照

- Readlang：词语/短语的语境解释，连接词卡复习。<https://readlang.com/>
- Migaku：真实词典释义、AI 句子拆解/语境解释并存，词卡保留原句及媒体语境；并非卡片的所有字段都由 AI 生成。<https://migaku.com/faq/features>
- LingQ / Lynx：解释词汇、表达与语法，支持对话和输出练习，回复中的词语可以进入收藏复习。<https://forum.lingq.com/t/what-is-lynx-ai-in-lingq/2609825>
- Yomitan 是非 AI 对照：多词典、语言 profile、查词与制卡流程。<https://yomitan.wiki/getting-started/>

## 增量功能建议

本项目已有句内释义、独立解释语言、lemma、选义保存、手动词形关系和多语导出，不将其重复列为新增功能。

1. **优先：依据词典义项选义。** 输入原句与少量允许用于 AI 的候选义项，推荐具体义项并说明理由；允许无匹配，保留来源，由用户决定是否保存。
2. **优先：独立译释层。** 将选中义项解释成用户指定语言，原文、译释、出处分别保留，不将 AI 译文标为词典原文。
3. **其次：短语范围与词形分析。** 对德语 `steht … auf`、西语 `darse cuenta`、中文“看不懂”、英语 `give up` 等提示完整表达与组成关系；确认后再查词或保存，不自动改写收藏身份。
4. **后续：多语境比较。** 选同一词的两三条原句，比较义项与用法，输出可追溯到原句的短对照。
5. **后续：一道小练习。** 原句挖空、近义词选用或造句反馈；合成内容单独标记，确认后再入笔记/词卡。

例句可评估 Tatoeba：它是辅助语料，提供语言对下载，文本与音频许可分别处理。<https://tatoeba.org/en/downloads>

实验方向为离线词典配合 Chrome Translator/Prompt API：模型首次需下载，支持能力受设备、浏览器与语言限制，不能承诺全语言可用。<https://developer.chrome.com/docs/ai/translator-api>、<https://developer.chrome.com/docs/ai/get-started>

## 本轮获批范围与回顾方法

用户明确选择先完成前三阶段：

1. 多语言词库包与来源管理。
2. 词典义项辅助 AI 选义和独立译释。
3. 短语和词形分析。

商业词典、多语境比较、练习生成、端侧 AI 等后续评估项暂缓。本轮按逻辑阶段验证并本地 commit，不推送、不发布；完成后执行 Impeccable critique，审查功能、设计、UI/UX。

完成回顾应逐项对应上述建议，记录实际支持的格式、语言与许可处理、用户动作、失败恢复、验证证据、commit，以及尚未实施的原因。此基准正文保留，回顾追加在独立章节，避免用最终实现倒写原始调研结论。

## 实施回顾（2026-10-24）

以上为 `a68372a7` 保存的原始调研稿，未按实现结果改写。本节记录获批前三阶段的交付；不把候选清单中的每个词典格式或商业 API 都算作已接入。

| 原建议 | 实际交付 | 边界与验证 |
|---|---|---|
| 通用多语离线包入口 | Yomitan v3 ZIP 文本包：导入前预览词条/释义语言、来源和许可；多包启停、原子替换、删除、逐包 AI 许可；阅读器与生词本同时查询 | 包留本机，不进入 Drive/JSON 备份；不加载包内脚本、样式、图片、音频。每次安装或替换默认关闭 AI 许可，旧代际不能继承新授权。保存选中的原义后才进入既有生词同步/导出流程。 |
| 依据词典义项选义 | 显式点击后，将原句与获准来源的少量候选交给 AI；输出候选 ID 或无匹配，再由用户选择原义 | 不自动保存，不用模型文本冒充原词典。重新核验 owner、来源启用/许可及代际；取消、撤权、切号后的迟到结果丢弃。 |
| 独立译释层 | 对用户选中的原义生成独立解释或译释，可复制；解释语言独立于界面与词条语言 | 原义及来源保留。无真实原句时允许解释所选原义，不编造文章语境。ECDICT 未作为可发送给 AI 的已知开放来源。 |
| 短语与词形分析 | 真实原句中的原选词，即使词典零命中也可分析；最多 3 个建议，逐段展示原句证据；确认后重新查建议词头 | 原句证据须逐字存在，每条建议关联原选词；保留大小写与 NFC 等价拼写。重查、词形跳转和语言切换继续传递原句，不自动写 lemma 或修改已有收藏身份。 |
| 多语言用户模型 | 界面语言、词条语言、词典释义语言、AI 解释语言分别处理，界面文案覆盖既有九语言 | 实际隔离浏览器覆盖英语界面/解释学习德、西、中语；中文界面/解释学习英语；另测日语词形。不是以中文学习英语为唯一方向。 |

### 实际词库导入与容量

从官方发布渠道取得的完整文件经过浏览器导入与查询验证：

- **WTY 西语→英语 2026.10.22**：ZIP 21,857,656 字节，1,483,499 行；使用 `28dead0c` 的正式上限与 batch 200 全量完成，约 13 分 04 秒。采样 JS 堆峰值约 166 MB，观测到约 1.57 秒事件循环延迟。
- **Jitendex 2026.10.03.0**：ZIP 38,831,822 字节，436,555 行；完整兼容性探针完成导入与查询。探针使用 batch 1000，正式代码保留 batch 200，因此约 7 分 15 秒的探针耗时不能当作正式实现的速度保证。

两者原始 manifest 都没有独立 license 字段；实现保留 attribution，不把缺失许可自动补成“已获授权”。导入成功也不自动开启 AI。JS 堆采样不是浏览器总内存；以上仅为该环境中的兼容性与耗时记录。

正式上限：压缩包 128 MiB、解压总量 640 MiB、单 bank 32 MiB、保留文本载荷 512 MiB、150 万行、最多 16 个包。超限拒绝安装，失败/取消保留旧代际；查询结果达到数量上限时显示截断提示。大包导入以分钟计，尚未验证低内存设备与用户 Windows 冷启动体验。

### 验证与提交

| 逻辑单元 | 本地 commit | 验证证据 |
|---|---|---|
| 保存调研基准 | `a68372a7` | 原始候选、官方来源、获批范围单独保存。 |
| 第一阶段：词库包与来源管理 | `28dead0c` | dict-pack 286、options-vocab 152；独立 ZIP 边界 28 项、多语旅程 49 项、来源保存 7 项；实际上游完整文件如上。 |
| 第二阶段：AI 选义与独立译释 | `7ea156e4` | AI 请求门 120、原有 md-ai 1084；独立真实 DOM/本机 HTTP 旅程 32 项；两界面各三态在 native/CI 字体下通过。 |
| 第三阶段：词形与短语分析 | `88715db7` | dict-assist 64、md-dict 630、library-vocab 521；独立旅程 79 项及 owner/取消边界 7 项；两界面分析三态在 native/CI 字体下通过。 |

九语文案校验 233 项通过，README 九语镜像、隐私网络/权限/第三方披露、UI 契约、编辑期检查及正常 commit hooks 均通过。生词本测试完整运行约 32 秒，原 30 秒总时限仅留下约 24 秒等断言；已按实测给该套沿用 45 秒预算，完整断言数量、错误检查保持。

施工中实际发现并修复了导入元数据确认竞态、包代际授权错配、后续重查丢原句、320px 德语长动作与长词头按钮裁切。UI 检查同时核对父容器边界，避免仅看页面 scrollWidth 漏掉裁切。

所有 AI 网络旅程均使用本机合成响应；验证的是数据流、权限、状态与交互，不代表真实服务的词义推荐或多语言分析准确率已评测。未使用真实账号对外发送生词，未推送或发布。

### 暂缓与未声称支持的能力

- 通用入口是 **Yomitan v3 ZIP**，并非原生 Kaikki JSONL、StarDict、TEI XML、JMdict XML、MDict 或 TogetherDB CSV 解析器。词库能否使用取决于可取得的兼容文本包、语言方向与许可，不承诺任意包都可逆向查询。
- 未新增 KRDICT、PONS、Lexicala、Oxford 的专用在线适配器；也未申请商业 key 或绕过缓存、导出和 AI 使用条款。
- 多语境对比、练习生成、端侧 AI、例句音频及媒体包继续暂缓，符合本轮用户选择的范围。
- 各语种真实模型质量、低资源语种覆盖、大包低内存表现，以及 Windows 冷启动仍需专项实测。

### 最终只读审查回顾

在三个功能阶段提交完成后，由两个未参与实现的独立代理进行 Impeccable 设计评估与 detector/浏览器取证；设计评估先封存，再合并检测结果。根代理另核对截图、源码及复制失败反例。综合 **26/40**，没有发现 P0；以下是当前界面仍需处理的事项，未计入已修复清单：

1. **P1：德语 320/360px 生词本查词入口被统计条覆盖。** 换行按钮所在行没有保留实际高度，真实指针点击被“25 Wörter”拦截；键盘仍可打开。应修正纵向布局并检查实际点击命中。
2. **P2：查 AI 建议词后标题仍显示原选词。** `steht` 分析为 `aufstehen` 后实际查询已改变，但可见标题未变，且出现原句字面匹配失败提示。应区分原选词与当前查询，保留返回分析的线索；未发现保存数据损坏。
3. **P2：AI 完成与错误提示可能位于弹层可视区之外。** 结果已生成但需要用户自行滚动寻找。应提供可见的完成提示或只在仍等待时揭示弹层内结果，保持文章位置。
4. **P2：词库启停及 AI 授权后键盘焦点丢失。** 操作成功后真实 activeElement 回到 body；应在最终列表刷新时保留当前词库操作位置，并避免抢回已移出的焦点。
5. **P2：复制失败说明被固定高度按钮裁切。** 320px 英文阅读器及德语生词本均复现；应保留短动作按钮，将手动恢复说明放入可换行状态文本。

次要改进是直接说明禁用义项 AI 的来源许可原因、明确“在线未找到”不否定本地命中，以及在 AI 区域轻量展示解释语言。CLI 对三份 HTML 的 18 条提示经源码与截图核对，未确认额外产品缺陷；MV3 CSP 拒绝 localhost detector 脚本，未生成可见覆盖层，审查使用真实隔离扩展截图和交互证据。

这轮审查说明：前三阶段的功能链路、权限和保存边界已落地，但通过结构化断言与渲染门，并不等于所有语言、窗口与连续操作状态都已完善。后续应先处理上述实际交互问题，再扩大词库格式或 AI 功能范围。
