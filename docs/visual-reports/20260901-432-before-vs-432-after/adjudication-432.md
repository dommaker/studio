# #432 视觉走查裁决 + diff 归因

> 配套报告：同目录 `report.md`（432-before vs 432-after，e2e329e6^ vs e2e329e6 工作树，dev 栈实拍）。
> 全页 PNG（本地，不入 git）：`.studio/visual/432-before/` / `.studio/visual/432-after/`。
> 本文件回答两件事：① 票据四个手动走查点逐条裁决；② report.md 中 non-clean 条目的归因。

## ① 四个手动走查点逐条裁决

| 走查点 | 裁决 | 证据 |
|--------|------|------|
| 六泳道头同行（1920/1440/1280） | **修复** | before 1920「完成 (1)」孤悬第二行（破版复现）；after 三档逐张核对六泳道头（待确认/待领取/进行中/待验收/阻塞/完成）全部同行无掉行。`pmo-project-*.diff.png` 红色恰落在泳道头行与「完成」泳道卡位移处 |
| 进度条中间态与 100% 态色族一致 | **部分覆盖** | dev 数据项目 1/1=100%，仅 100% 态可视：两轮均 `u-ok-bg` 绿、无 diff，未回归。中间态（<100%）dev 无数据无法视觉覆盖，由测试锁定：`ProjectPipeline.test.tsx` 断言中间态 `u-accent-bg`、无 `from-blue/to-blue` 写死色 |
| 两 tab 左对齐 | **修复** | before「项目(1)」「OKR(1)」各居中于半屏（分居复现）；after 三档两 tab 左对齐相邻、容器自适应宽。`pmo-*.diff.png` 红色恰落在两 tab 旧/新位置 |
| 项目头徽标编号 | **修复** | before 渲染「PM- PMO-1」（双前缀复现）；after 徽标单份「PMO-1」（项目详情页头部 + PMO 列表卡片一致） |

**结论：B0-1 / B8 / C1 三档视觉全过；B2 的 100% 态视觉无回归、中间态测试锁定（视觉覆盖需 <100% 项目数据，留作后续数据齐时补看）。**

## ② report.md non-clean 归因

| 条目 | 差异率 | 归因 |
|------|--------|------|
| pmo ×3 | 0.03–0.06% minor | **本票预期变更**：B8 tab 条收拢左对齐（掩码逐张过目） |
| pmo-project ×3 | 0.32–0.65% minor | **本票预期变更**：B0-1 六泳道重排 + C1 徽标去双前缀（掩码逐张过目；进度条 100% 态两轮一致无红） |
| channel-detail ×3 | 2.6–3.4% major | dev 活系统两轮间新发消息（monitor pool_stagnation/review_stagnation 告警 + 每日洞察文档，掩码确认）——已知不可消除 churn（工具 README 已载），与本票无关（本票 diff 未触频道组件） |
| channels ×2 | 2.9–3.3% major | 频道列表最后消息预览/计数 churn（同上） |
| knowledge-1280 | 3.86% major | 两轮间知识库新增 monitor 条目（掩码确认条目级文字 churn），与本票无关 |
| library-doc-1440 | 3.54% major | 阅览室文档内容 churn（同源 monitor 活动），与本票无关 |
| audit-logs-1920 (+select-open) | 1.12% major | 采集自身 auth/发现 API 调用写入新审计行，表格行错位（同 431 归因） |
| settings-more-open ×3 | 1.2–1.6% major | settings 串行慢 API「Loading…」沉降时序差整页错位（掩码确认 Loading 字样；同 431 归因）。掩码含 dev 配置字段形状已过目：webhook URL 仅前缀、key 截断不可读，Telegram token 为占位假数据，无敏感泄露 |
| settings-bell-open ×2 | 1.2–1.5% major | 通知角标/条目时序（该态点名揭开 data-visual-ignore；同 431 归因） |
| workunit-detail-modal-reject-1440 | missing-b | after 轮 in_review WU 数据前置变化致该 modal 未触发，非回归（同 431 missing-a 情形） |
| 其余 minor（settings-toast、workunits-long-scope 等） | <1% | 动态内容/抗锯齿级，与本票无关 |
