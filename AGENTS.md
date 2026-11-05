# AGENTS.md

本仓库的协作约定写在 `CLAUDE.md`，开工前先读它。改文件或做发版、真实 API 测试前，按 `CLAUDE.md` 末尾「规则与技能索引」读对应的 `.claude/rules/*.md` 与 `.claude/skills/*/SKILL.md`：这些文件不会自动加载给你。

本仓库没有给你配置编辑期钩子，改完 UI 消费侧文件后自己运行 `node scripts/ui-consumer-lint.mjs --file <路径>`。
