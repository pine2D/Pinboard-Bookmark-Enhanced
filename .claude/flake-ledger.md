# 抖动台账

> 同一份代码有时过有时不过的测试，记在这里。重跑后通过也要记，不能当没发生。
>
> 规则：一个用例第一次抖动，记一行，状态写「未处理」。同一个用例第二次上榜时，必须根治，或者隔离并写到期日，不能再留「未处理」。根治后把状态改成「已根治」加修复的提交号。
>
> 「用例」一列要写得稳定，同一个用例每次都用同一个写法，检查靠它判断是不是第二次。
>
> `scripts/registers-lint.mjs` 检查格式、第二次上榜的规则和隔离的到期日。CI 里自动重跑后通过的用例会打出警告，并写进运行产物里的 `flakes.jsonl`，看到后补记到这里。
>
> 2026-11-10 建立。首批条目来自对此前四个月 CI 运行记录的取证。

## 记录

| 日期 | 用例 | 现象 | 状态 | 到期日 |
|---|---|---|---|---|
| 2026-10-06 | render-audit 分片 0：行悬停填充色 | 在颜色过渡中途读取，两次尝试的失败状态不同 | 已根治 d71f6c17 | - |
| 2026-10-22 | tests/md-ai-tests.html：scroll-spy | 同一提交前两次尝试失败，第三次通过 | 已根治 788c60cf | - |
| 2026-10-23 | tests/md-ai-tests.html：scroll-spy | 侧栏位置 560 对 622，夹具几何没有隔离 | 已根治 788c60cf | - |
| 2026-11-05 | tests/export-targets-tests.html：渲染未跑完 | 停在 144/153 行，连续两次运行，其中一次是只改 README 的提交 | 已根治 96102ee4 | - |
| 2026-11-05 | bookmark-service-runtime：linkding 弹窗的未改动状态 | 等待超时 | 已根治 b968f907 | - |
| 2026-11-05 | render-audit 分片 0：未选中列表头的面色 | 测量受鼠标悬停影响 | 已根治 fe264f5e | - |
| 2026-11-06 | bookmark-service-runtime：linkding 连接状态行 | 等了 10 秒仍是隐藏，重跑后通过 | 已根治 ccf2083e | - |
| 2026-11-07 | render-audit 分片 0：前提检查 | 夹具前提失败 1 次，重跑后通过 | 已根治 ccf2083e | - |
| 2026-11-18 | tests/bookmark-live-preflight-tests.mjs：docker fake executor | linkding 凭据或档案验证与 Karakeep 注册同时失败，首次报告的错误随时序变化 | 已根治 b25de629 | - |
| 2026-11-18 | bookmark-service-runtime：跨窗口切换后的服务单选框 | 本页已写入 linkding，另一窗口切回 Karakeep 后单选框仍停在 linkding；固定两个写入的响应顺序可以复现 | 已根治 3d977db1 | - |
| 2026-11-18 | reader-save-export：Ask 导出夹具的个人库身份 | 启动时尚未完成的初始化覆盖了夹具的 qa 身份，读取 Ask 档案报 account_changed；串行建立夹具后双窗口导出通过 | 已根治 535ad4ae | - |
| 2026-11-18 | tests/ai-cache-tests.html：空池并发写入精确容量 | 页面一次停在 20/32，下一项并发写入两个缓存池；独立运行时全部 32 项通过，首次停顿原因未确定 | 已根治 96102ee4 | - |
| 2026-11-24 | render-audit 分片 0：tag-gov-entity-scan 标题面色 | 首次运行点击扫描并滚动后鼠标留在重排后的小节 summary 上，headerFace 测得悬停色 rgb(32, 94, 166) 而非 rgb(16, 15, 15)，重跑通过 | 已根治 f6461c98 | - |
| 2026-11-24 | tests/reader-history-tests.html：点击历史行打开标签并关闭弹层 | 四路并行 V8 覆盖率采样负载下 tabs.create 断言早于 pop.hidePopover 完成 1 个微任务，串行重跑 14/14 通过 | 已根治 43eb40a2 | - |
| 2026-11-24 | tests/settings-persist-tests.html：E7d 云端分片未到齐时中止备份导出，到齐后恢复导出 | 四路并行采集 V8 覆盖率时失败。用例最多等待 30 帧，原始失败断言未找到。串行复跑和 2026-11-26 四路采样复跑均为 614/614 | 未处理 | - |
| 2026-11-25 | tests/reader-history-tests.html：点击历史行打开标签并关闭弹层 | 全量 verify 四路并行下 popup #jina-md-history-btn 在 tabs.create 后尚未完成 pbpReaderHistoryRecord 入锁与 pop.hidePopover 即断言关闭 | 已根治 43eb40a2 | - |
| 2026-11-25 | render-audit 分片 0：md-preview dict-entry-negative 记忆标记 | 同分片前置 library/dict-entry-paid-negative 遗留同账号 pbpDictNeg:* 键，使后续 md-preview/dict-entry-negative 探针在 pbpDictNegRecord 异步落盘前提前放行重查 | 已根治 f8832b4b | - |
