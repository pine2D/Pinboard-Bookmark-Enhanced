# AGENTS.md

本仓库的协作约定写在 `CLAUDE.md`，开工前先读它。改文件或做发版、真实 API 测试前，按 `CLAUDE.md` 末尾「规则与技能索引」读对应的 `.claude/rules/*.md` 与 `.claude/skills/*/SKILL.md`：这些文件不会自动加载给你。

提新功能、做审计或加一次性迁移前，先读 `.claude/decisions.md` 与 `.claude/expiring-items.md`（其余登记册按 `CLAUDE.md` 使用）。根工作区供 Chrome 直接以未打包扩展加载，不在其中切分支或写未跟踪的报告产物；隔离施工请建外部 worktree 到 `~/.local/share/pbp-worktrees/`，QA 报告写到 `~/.local/share/pbp-qa-report/`。

本仓库没有给你配置编辑期钩子，改完 UI 消费侧文件后自己运行 `node scripts/ui-consumer-lint.mjs --file <路径>`。
