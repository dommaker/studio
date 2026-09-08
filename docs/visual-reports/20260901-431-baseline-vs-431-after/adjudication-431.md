# #431 降权目检逐条裁决 + diff major 归因

> 配套报告：同目录 `report.md`（431-baseline vs 431-after）。本文件回答两件事：
> ① 票据「降权目检清单」逐条的 修复/新丑 裁决；② report.md 中 major 差异页的归因。
> 证据（本地，不入 git）：`.studio/visual/431-widgets/`（元素截图 + computed style dump + 20 条规则渲染样张 `activated-rules-sample.png`）、`.studio/visual/431-baseline*/431-after*`（全页 PNG）。

## ① 降权目检清单逐条裁决

方法：有 live 实例的（标记 **实测**）在 dev 环境直接取 computed style + 元素截图核对；
无 live 实例的（标记 **harness**）在 `.mc-ws` 内注入裸 `<button>` 挂对应类，验证 computed style 命中规则值，并拍 20 条规则渲染样张人工过目。

| 清单项 | 方式 | 裁决 | 证据要点 |
|--------|------|------|----------|
| 频道输入发送钮 `.mc-btn-primary` | 实测 | **修复** | accent 底色首次出现（baseline 无底色 → after `rgb(46,230,168)`），即票据点名的预期激活 |
| WU 链接 chip `.mc-wu-link` | 实测 | **修复** | accent-dim 底 + accent-border + padding 全生效，与原设计规则值一致 |
| need-input 选项 `.mc-need-option-extra` | harness | **修复** | computed 命中（虚线 border、muted、padding）；样张无新丑 |
| need-input chip `.mc-need-chip` / `.mc-need-chip-item` | harness | **修复** | warning 色系/hairline 行命中规则值 |
| livebar `.mc-livebar` | harness | **修复** | elevated 底 + hairline + flex 布局命中规则值 |
| 活动栏行 `.mc-act-row` / 徽标 `.mc-act-pmo-badge` / step `.mc-act-step` | harness | **修复** | padding/badge accent chip/step 布局命中规则值（dev 数据无 live 实例） |
| 抽屉返回 `.mc-drawer-back` / 关闭 `.mc-drawer-close` | 实测 | **修复** | 抽屉实测：accent/secondary 色 + padding 生效（drawer-back 基态 display:none 为原设计，非降权引入） |
| `.mc-rail-new`（+ 新频道） | 实测 | **修复** | accent border + accent 文字首次渲染 |
| `.mc-jump-bottom`（回到底部） | harness | **修复** | elevated 胶囊 + 999px 圆角命中规则值 |
| `.mc-icon-btn` | 实测 | **修复** | secondary 色 + padding 生效 |
| `.mc-file-chip` / `.mc-chain-node` / `.mc-toolrow` | harness | **修复** | 各命中规则值；样张无新丑 |
| `.mc-block-label` | 实测 | **修复** | fs-xs + uppercase + secondary 首次生效（含 TranscriptViewer 按钮——`u-btn-reset` 刻意不含 font/color，未压该类） |

兜底验证：`.mc-ws` 内裸 `<button>`（无任何类）computed = `cursor:pointer / background:transparent / padding:0 / border:0`——降权后重置职责完好。
**结论：20 条首次激活规则全部判「修复」，零「新丑」，无逐条修补需求，降权不回退。**

## ② report.md major 差异页归因

| 页面 | 差异率 | 归因 |
|------|--------|------|
| channel-detail ×3 | 3.4–4.7% | dev 数据根后台 agent 在两轮间新发消息（内容 churn）+ 降权预期激活面（见①） |
| channels ×2 | 3.7–4.5% | 频道列表最后消息预览/计数在两轮间变化（churn） |
| knowledge ×3 | 3.1–3.9% | 两轮间知识库新增条目（dev  distill/monitor 活动，churn）；本页样式改动仅 3 处等价替换 |
| audit-logs-1920 (+select-open) | 1.52% | 采集自身的 auth/发现 API 调用写入新审计行，表格行错位（churn） |
| settings-more-open ×3 | 1.2–1.6% | workspace/Token 区块「Loading…」沉降时序差，整页纵向错位（时序） |
| settings-bell-open-1440 | 1.49% | 通知角标/条目时序（该态点名揭开 data-visual-ignore） |
| workunit-detail-modal-reject-1440 | missing-a | baseline 轮该 modal 未触发（数据前置），非回归 |

**共享类迁移面（u-page-bg/u-page-head/hairline/u-btn-reset/§1.C）在静态页（pmo、workunits、agents、library、settings 默认态、setup-roles、workspace、notfound 及 B 档 10 张）全部 0.00% clean——零视觉差 AC 达成**；上表 major 均可归因数据/时序 churn 或票据预期的激活面，无样式回归。

## 附：样式外的两处票据偏差说明

- 两处 `background: var(--bg-secondary)` 内联（PMOPage tab 容器 / CreateOkrDialog KR 行）按维护者决议走新增的 `.u-surface-0`（= `--bg-secondary`），非票面字面的 `u-surface`（= `--bg-elevated`，会毁掉「父级下一档」层级对比）。
- `style-guide.md` 登记（含 `u-err-border` 退役注记）在本地正本完成；该文件按仓 `.gitignore` 策略（`docs/*` 忽略，仅豁免 adr/visual-reports）不入版本控制。
