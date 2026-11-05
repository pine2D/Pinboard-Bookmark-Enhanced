---
paths:
  - "scripts/audit*.mjs"
  - "tests/audit*-tests.mjs"
  - "scripts/qa-drive.mjs"
  - "scripts/ci-fonts-env.mjs"
  - "scripts/ci-fonts.conf"
  - "scripts/verify.sh"
  - ".qa-scan/run-test.mjs"
---

# 开发审计：按场景选择与 CI 字体环境

> 自 `theme-factory.md`《开发时按场景选择审计》与 `ui-primitives.md`《门在哪里响》的 CI 字体说明拆出（2026-11-05），原文未改。根 CLAUDE.md「设计精修工作流」指向这里。

## 开发时按场景选择审计

- 统一入口 `node scripts/audit.mjs`（也可 `bash scripts/verify.sh <筛选参数>`）；先 `--changed --plan` 看工作区含暂存改动的影响建议，或用 `--staged` / `--base=<ref>` 指定范围。计划不启动浏览器。没有参数时拒绝猜测范围；`verify.sh` 无参数及仅 `--all` 仍执行原全套 CI 门，不作为普通编辑的默认动作。
- `--surface=popup,options,library,reader,site,background,tooling`、`--scenario=<稳定ID或通配符>`、`--feature`、`--kind`；其他维度用 `--theme`、`--scheme`、`--locale`、`--viewport`、`--dpr`、`--font`、`--density`、`--state`、`--input`、`--fault`、`--data`、`--tier`。只接受场景实际支持的值，`--list` 可查支持轴；同轴并集、跨轴交集，随后补必需前置，非法/空组合直接失败。未提供的轴保留该场景原有覆盖，不自行缩成一个样本。
- `input`、`data`、`tier` 是已登记场景的分类标签：例如 keyboard、saved-history、smoke/matrix/journey；它们筛选真实交互/夹具，不额外生成输入方式或环境组合。`tier` 表示执行层次，阅读器字号仍由 density=default/large 选择。
- surface 是多值归属，选 reader 会包含真实依赖其他表面的 journey；需要单面流程时选具体 scenario，计划会展示其表面与前置。
- 例：`--scenario=qa.popup.login`；`--scenario=qa.options.layout.ai --locale=de --viewport=320 --scheme=dark --density=compact`；`--scenario=render.library.sweep.notes-color-menu` 会包含 notes-detail 前置；`--scenario=qa.reader.controls.ask --locale=de --viewport=360 --scheme=dark --density=large` 只运行 Ask 子流程。先加 `--plan` 审阅，移去它即执行。
- 影响推荐按消费者与功能估计，计划列明依据；`listbox.js` 对应 options/library，已证明仅新增图标时按新增符号使用方缩小范围，无法判定的共享改动明确扩大理由。推荐不是依赖分析证明，未映射输入会告警，需用显式场景补齐。已知纯逻辑改动用 `--kind=logic,contract,security`，不为其运行视觉矩阵。
- `.qa-scan/run-test.mjs` 的改动里，只增删或改 `EXPECTED_RESULTS` 的 `"tests/<页>.html": N,` 条目行时，推荐收窄为这些条目对应的测试页；同一补丁含其他任何改动则不收窄，回到全部 html 测试页（`expectedCountPages`，`scripts/audit-plan.mjs`）。改完条数用 `node .qa-scan/run-test.mjs --print-counts tests/<页>.html` 取实际行数。
- 真实调度层是 `scripts/audit-*-scenarios.mjs`；新增场景在此注册并提供实际 opener/driver。运行报告比较计划/完成 ID，记录各任务耗时，子进程失败、漏执行、打开失败均不能通过。局部审计禁写全局基线、不做全局 STALE 清理。`--sweep` 仍是发现模式，不能替代正式选中场景的门禁。
- 改几何须对受影响场景补 `--font=ci`；native/ci 可同轴选取，入口分别设置字体环境。站点主题保持 native，不套扩展 UI 的 CI 字体配置。共同设置/基线前置允许保留，不能因此运行未选页面。同一轮已通过检查除非有新改动或新问题，不重复执行。

## CI 字体环境

改了控件几何要在 push 前用 `node scripts/audit.mjs --scenario=<受影响场景> --font=ci` 跑对应正式门；不要默认全量 sweep（这条规则本身在 `ui-primitives.md`）。原因与配置如下；文中「该 conf」指 `scripts/ci-fonts.conf`，「该变量」指 `FONTCONFIG_FILE`（`--font=ci` 时由 `scripts/audit.mjs` 设置，见 `scripts/ci-fonts-env.mjs`）：

本机借 Windows 字体（拉丁正文落在 Verdana，中文落在微软雅黑），CI 的拉丁正文落在 **Liberation Sans**（字体栈里的具名字体 CI 全缺，经 generic sans-serif → Arial 度量别名解析；不是 DejaVu），中文落在文泉驿正黑，且 Ubuntu 默认 hintslight + rgb 子像素。`line-height: normal` 的控件会在 CI 上多出或少掉 1px、CJK 墨迹会高出约 1 CSS px，本地都看不见。该 conf 引入本机 `/etc/fonts/conf.d` 并白名单 CI 实有的字体包，在 Ubuntu 24.04 主机上与 CI 逐字节一致（含 CJK），换发行版不保证。路径必须是绝对路径（相对路径 fontconfig 会静默落回默认配置），验证加载成功看 `fc-match "Microsoft YaHei:lang=en"` 是否解析到 DejaVu、`fc-match Arial` 是否解析到 Liberation Sans（不带 `:lang=en` 时中文/日文 locale 会答文泉驿，conf 明明加载了也像没加载）。两个审计脚本在设了该变量时自行把 `XDG_CONFIG_HOME` 指向空临时目录，隔离本机 `~/.config/fontconfig` 的个人 hinting / 子像素 / 字体偏好（经 conf.d 的 50-user.conf 混入，能盖掉 CI 保留的逐字体规则），测试页与裸 `fc-match` 不会自己隔离，要加 `XDG_CONFIG_HOME="$(mktemp -d)"` 前缀。
