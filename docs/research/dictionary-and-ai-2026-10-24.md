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
