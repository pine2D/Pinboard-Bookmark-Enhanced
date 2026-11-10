---
name: release
description: Bookmark Enhanced 的提交钩子分路与发版流程（bump-version.sh、push、release.sh 打 ZIP / GitHub release / changelog、发版文档硬门、打包规则、扩展 ID 与 OAuth client 分层、ZIP smoke）。在要发版、bump 版本、打 tag、发布 release、构建或冒烟 ZIP、准备 CWS 上架，或想弄清 pre-commit 各组门何时触发时使用。
---

# 发布流程（Bookmark Enhanced）

> 自根 CLAUDE.md「发布流程」迁来（2026-11-05）。「对外材料只讲核心」「用户看得到的文字都要说人话」「用户可见文案 / README 改动」三条跨领域规则仍在根 CLAUDE.md 的「提交、发布与对外文案」一节（原文），写 README、商店文案、release notes 或任何界面文字前读那里；新增数据出口须同步 privacy.md 三处的规则在根文件「跨领域安全铁律」。

```bash
git commit -m "fix(...): ..."   # pre-commit 两组触发：主题源/三份 CSS → 8 道工厂门；UI 消费侧按文件分路——四个表面 HTML、popup/options/library(-*).js、listbox.js 与 md-dict.js → layout-lint + ui-contract + ui-vocabulary，md-preview.css 与 dict-*.js → layout-lint + ui-contract，其余 md-*.js、shared.js 与词汇注册表/基线 → ui-vocabulary；全套 verify 由 push 后 CI 兜底（禁止 --no-verify）
                                # 其中 layout-lint + ui-vocabulary 两道静态门在 Claude Code 里由 .claude/settings.json 的 PostToolUse 钩子在编辑时即跑（JS 范围与 ui-vocabulary 触发组一致，含 md-dict.js；dict-*.js 不铸类名、两道门都不读它，不在编辑期钩子内，ui-contract 只在 commit 时跑）；该钩子另覆盖主题工厂生成物——popup/options/library.css 命中时改跑 layout-lint + css-region-audit，pinboard-themes.js 命中时改跑 handedit-audit（各按脚本实际读取的文件路由，不空跑），红了指向 sync-all；composers/pilots 源文件不在编辑期钩子内（中间态会误报，留给 commit 时的 8 道工厂门）。没有编辑期钩子的工具（Codex 等）改完文件后自行执行 node scripts/ui-consumer-lint.mjs --file <路径>
bash scripts/bump-version.sh    # 按 commit 类型 bump manifest（feat→minor / fix→patch）
git push origin main
bash scripts/release.sh         # 打 ZIP + GH release + changelog；--build-only 仅构建+冒烟不发布，其余任何运行都会直接发布
```

- **发版前文档核查（release.sh 硬门）**：自上个 tag 有 feat commit 而 README×9 / CLAUDE.md / docs/privacy.md / docs/index.md / theme-surface 文档全未改动时直接中止；确认无需更新用 `--docs-ok` 显式跳过。新增任何数据出口（新 API 调用、新导出目标、新 AI 触发面）必须同步 privacy.md 的 Network Requests / Permissions / Third-Party 三处。privacy.md 与 index.md 走 GitHub Pages，push 即生效，不依赖扩展发版。
- **验收欠账门（release.sh）**：发版时列出 `.claude/acceptance-debt.md` 的全部待验条目，有过期的就中止；确认要带着欠账发版，加 `--accept-debt`。`--build-only` 跳过这道门。
- **打包规则**：root 的 `*.html` / `*.js` / `*.css` / `manifest.json` 自动进 ZIP，递归包含 `vendor/ icons/ _locales/`；`tests/ scripts/ docs/ release/ *.md` 与隐藏目录排除。新增非上述后缀/位置的运行时资源必须改 release.sh 的 INCLUDE_DIRS / TOP_LEVEL_PATTERNS；sanity check 断言 manifest 与所有 HTML 引用的文件都在 ZIP 内，少一个 exit 1。
- **扩展 ID 分层**：源码 manifest 固定开发 ID `feoognahlmfmbllpmgailahcnjppiegb`（开发公钥 + 开发 OAuth client，可与 CWS 版并存）；release.sh 校验源码身份后只在 ZIP 内替换为 CWS 公钥与生产 OAuth client，正式版固定 CWS ID `pnjndmjhljjbdlbejeenkepdalokfooh`。严禁占位 client ID/secret。Drive 两个 OAuth client 对同一 Google 账号 appDataFolder 的互通性 smoke 测不到，发布前需人工实测（细则见 `.claude/rules/drive-sync.md`「Google Drive OAuth 构建契约」）。
- **ZIP smoke**（release.sh 内置，失败即中止）：Playwright 装解压后的 ZIP，校验 SW 注册、扩展 ID/OAuth client、vocab 模块加载、popup/options 无 pageerror、DNR 防盗链契约。`--skip-smoke` 仅限调试 release 脚本本身；单独跑 `node scripts/zip-install-smoke.mjs`。前置：`.qa-scan/` 已装 playwright + bundled Chromium。
