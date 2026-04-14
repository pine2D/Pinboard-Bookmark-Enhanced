# ⚠️ 隐私红线 — 此目录禁止 push

本目录内容来自**已登录作者 Pinboard 账号**的真实抓取，包含：

- `*.png` — 登录状态下的页面截图（banner 露出用户名）
- `raw.html` — 完整 Pinboard 页面 DOM 快照（用户名、书签列表、form CSRF token、auth 相关 meta 都在里面）
- `state-capture.json` / `inline-audit.json` — 含真实选中文本、书签 URL、事件时序

**这些是开发期参考 fixture，不是交付物。**

---

## 🛡️ 当前防线

| # | 机制 | 位置 |
|---|---|---|
| 1 | `.gitignore` 规则 `snapshots/` 屏蔽整个目录 | `docs/theme-surface/.gitignore` |
| 2 | 反选规则 `!snapshots/README.md` 只放行本文件 | 同上 |
| 3 | `git check-ignore` 可单独验证每个文件 | 手动 |

**验证方法**：
```bash
git check-ignore -v docs/theme-surface/snapshots/<任意文件>
# 期待输出：docs/theme-surface/.gitignore:N:snapshots/	<路径>
```

---

## ❌ 严禁操作

- `git add -f docs/theme-surface/snapshots/…` — 强制绕过 ignore
- 移除 `.gitignore` 里 `snapshots/` 规则
- 把 `.png` / `.html` / `.json` 复制到仓库其他（不被 ignore 的）目录
- 贴截图或 HTML 片段到 PR / issue / commit message

## ✅ 如果需要分享样本

先用 `data:` 脱敏工具清洗：
- 把 `pinboard.in/u/<username>/` 改成 `pinboard.in/u/demo/`
- 去掉所有 `<form>` 里的 hidden token
- 打码真实书签 URL

脱敏后另存到 `docs/theme-surface/fixtures/` （单独管理），**不要放回 snapshots/**。

---

## 🔁 如何重生成

```bash
# 需要登录的本地 Pinboard 页面抓取
node docs/theme-surface/tools/capture-shipped.mjs   # 参考命名，实际脚本按需补
```

重生成后的文件**依然**受 `.gitignore` 保护，无需手工处理。

---

*最后更新：2026-04-14*
