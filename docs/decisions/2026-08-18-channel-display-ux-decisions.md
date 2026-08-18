# 频道展示体验优化决策记录（2026-08-18）

> 本文档记录"频道展示体验与交互优化"访谈（grilling）达成的共识。所有决策均已由所有者确认。
> 状态：**已达成共识，待拆票动工**。

## 0. 背景：调研发现的关键事实

- 频道页 = Mission Control 三栏：左 `ChannelRail`（224px）/ 中消息流 / 右 `WorkUnitDrawer`（336px）
- 大屏留白根因：`mc-stream-inner` 与 `mc-inputbar-inner` 均 `max-width: 760px; margin: 0 auto`（mission-control.css:215/:459），消息卡片另限 560px（:329）
- 频道消息流只承载里程碑是既定决策（docs/plans/2026-07-30-wu-execution-observability.md："过程可视化属于 WU 详情抽屉"），过程展示现状 = 抽屉内 `ExecutionSteps`（步级卡片 + chunk 逐行）
- 后端数据已够：Layer A 步级事件（thinking ≤3 条、toolCalls ≤30 条）+ Layer B 流式 chunk（step-start/thinking/text/tool/result），均已在发 SSE
- 参照系 deepseek-harness（dsh）的"明明白白"本质是四样：事件溯源日志 + seq、loading 分层（turn 级状态条 / 工具行 running-ok-error-stopped 四态 / thinking 独立成行）、render intent（后端声明 card 类型前端画卡）、一行折叠工具卡。其浏览器端实为 WebSocket 而非 SSE

## 1. 已确认决策

### D1 过程展示落点：抽屉为主 + 频道轻量 live 指示
- 不推翻"过程不进频道"决策。完整过程展示升级放在右抽屉 `ExecutionSteps`
- 频道消息流只加轻量 live 状态条："WU-X 正在执行 · 第 N 步"，点击打开对应抽屉，解决"执行黑盒"感知

### D2 借鉴深度：只搬交互范式，不动数据模型
- 搬：分层 loading、工具行 running/ok/error/stopped 四态、折叠工具卡（summary 从参数派生）、turn 级状态条（不随 step 闪烁）
- 不搬：seq/事件 fold 架构、render intent 后端下发、cordis/slot 体系
- 用 studio 现有 Layer A/B 事件 + mc-* 样式体系实现，基本纯前端；若状态推导（如中断态）推不出来再单独立项升级数据模型

### D3 布局宽度：响应式断点放宽
- `mc-stream-inner` / `mc-inputbar-inner` / 消息卡片同步放宽：屏宽 ≥1440px 时上限提至 ~1000px（具体断点与目标值实现时定稿），小屏维持现状
- 消息正文行宽保持克制，卡片/代码块可吃满新宽度

### D4 rail 不动
224px 频道 rail 本次保留，可折叠作为后续独立优化。

### D5 定位与拆票
- 内部工具定位：以大屏为准，小屏不破坏即可、不专门优化
- 拆 3 张票：① 布局宽度放宽（纯 CSS/结构）② ExecutionSteps 升级（分层 loading + 折叠工具卡）③ 频道 live 状态条
