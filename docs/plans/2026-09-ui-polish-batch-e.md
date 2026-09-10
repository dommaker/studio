# 批次 E：UI 交互/视觉增强（加载/错误/空态统一 + 微交互）

> 2026-09-10 立项。前序批次 D-0~D-4 已全部落地（见 2026-09-ui-interaction-polish.md），本批为收官后的深化批。
> 治理触碰两项，已获人在场当场批准（方案评审时选择「全含」），相关 commit 带 `Governance-Approved: session`：
> 1. toast 进出场 fade —— 推翻批次 C「toast 无进出场动效」决策（apps/web/src/CONTEXT.md），本批起 toast 允许 opacity 进出场（--motion-base），归入白名单场景②「弹窗进出场」语义扩展；
> 2. 新内容进场渐隐高亮（SSE 新 WU 行 / 频道新消息 / mc-msg-highlight 渐隐）—— 按白名单场景③「状态色切换」解释落地：底色/描边从 accent-dim 过渡到常态，仅颜色属性过渡，无 transform/位移动画。

## AC（验收标准）

1. 范围内页面（WU 列表/详情、PMO、ProjectDetail、频道 DiscussionPanel、ProjectPipeline）加载态由纯文字「加载中...」改为 Skeleton 静态骨架占位（无 shimmer 动画，不碰白名单）。
2. 上述页面错误态统一带「重试」按钮（以 PMOPage 错误条为正本）。
3. DiscussionPanel 加载/发送失败从 console.error 升级为 toast 可见反馈；发送失败保留草稿（抄 ChannelInput 模式）。
4. 空态统一「ui/icons 图标 + 文案 + CTA」：WU 列表空态去 emoji 📋 补 CTA；PMO OKR 空态补 CTA。
5. WU 列表「创建」「加载更多」按钮改用 ui/Button loading 态（.btn-spinner）。
6. token 合规：workunits.css:53、responsive.css 6 处硬编码 transition 归 token；BackButton/ProjectDetailPage/ProjectMap/ProjectProgressCard 范围内内联间距字号归 token。
7. 微交互：wu-detail.css 全页补白名单内过渡（stepper 状态切换、卡片 hover）；WU 详情首屏标题/徽章区加占位缓解布局跳变；PMO tab 激活指示改 u-tab + 过渡；「✓ 已复制」补颜色过渡。
8. 已批治理项：toast 进出场 fade；mc-msg-highlight 渐隐；SSE 新行/新消息 accent-dim 底色渐隐；频道「回到底部」按钮补未读计数。
9. 每 Phase 独立 commit；web test 全绿 + typecheck + lint 无新增警告。

## 手动走查清单（Phase 3 后执行）

- /workunits：加载骨架 → 列表；SSE 插入新行有底色渐隐；空态（过滤到无结果）图标+CTA。
- /workunits/:id：骨架 → 详情；stepper 状态切换有过渡；首屏无明显布局跳变。
- /pmo：加载骨架；错误态重试可用；tab 切换指示过渡；OKR 空态 CTA。
- /projects/:id：加载骨架；错误重试；复制路径反馈过渡。
- /channels/:id：新消息渐隐高亮；回到底部按钮未读计数；toast 进出场 fade。
- prefers-reduced-motion 下全部动效消失（系统设置模拟）。

## 明确不做

- 不改 token 定义值（色板/字号/间距/圆角档位）；不引入新依赖。
- 不动 LandingPage、AgentDashboard、监控页、知识库、阅览室。
- 范围外内联 style 重灾区（ChannelRoutingEditor/WorkUnitDrawer/KnowledgeConfirmCard/ConvertToTaskDialog/TreeTokenChart）留后续批次。
