# 频道展示体验与交互优化

> 决策来源：`docs/decisions/2026-08-18-channel-display-ux-decisions.md`（D1-D5，已与所有者达成共识）
> 参照系：deepseek-harness（dsh）web 会话展示

## Problem Statement

频道工作区（`/channels/:id`）在大屏上体验不佳、执行过程不透明：

1. **布局浪费**：中栏消息流与输入框被 `max-width: 760px` 居中压住，卡片另限 560px，大屏两侧大量留白，信息密度低。
2. **执行黑盒**：agent 执行 WU 时，频道流里只能看到里程碑消息；过程中 agent 在思考什么、调了什么工具、卡在哪一步，必须手动点开右抽屉才能看到。
3. **抽屉内展示粗糙**：`ExecutionSteps` 现状是步级卡片 + chunk 逐行平铺，工具调用没有独立状态表达（进行中/成功/失败/中断分不清），thinking 与正文混杂，长输出直接撑爆消息流。

## Solution

参照 dsh 的交互范式（分层 loading、工具行四态、折叠工具卡、turn 级状态条），在**不推翻"过程不进频道"既定决策**的前提下做三件事：

1. **布局响应式放宽**：大屏（≥1440px）下消息流/输入框/卡片上限放宽到 ~1000px，小屏维持现状。
2. **ExecutionSteps 升级**：工具调用渲染为可折叠单行卡片，每行带 running/ok/error/stopped 四态指示；thinking 独立成行；执行中显示不随步闪烁的整体状态条。
3. **频道 live 状态条**：频道流顶部（或活跃 WU 锚点处）显示"WU-X 正在执行 · 第 N 步"轻量状态条，点击打开对应 WU 抽屉。

## User Stories

1. As a 频道观察者, I want 大屏下消息流占满可用宽度, so that 一眼能看到更多内容、减少滚动
2. As a 频道观察者, I want 小屏下布局维持现状, so that 移动端/窄窗口不被破坏
3. As a 频道观察者, I want 输入框宽度与消息流一致, so that 视觉对齐不突兀
4. As a 频道观察者, I want 卡片（需求文档/提案等）随消息流同步放宽, so that 卡片内容不再被 560px 挤压
5. As a 频道观察者, I want 有 WU 正在执行时频道里能看到进行中的指示, so that 不用点进抽屉就知道 agent 在干活
6. As a 频道观察者, I want live 状态条显示当前步号/动作, so that 对执行进度有量化感知
7. As a 频道观察者, I want 点击 live 状态条直接打开对应 WU 抽屉, so that 一步跳到过程详情
8. As a 频道观察者, I want WU 执行结束/失败后状态条消失或转为终态, so that 不被过时信息误导
9. As a 过程查看者, I want 每个工具调用是一行可折叠卡片, so that 一屏能扫完整个执行过程
10. As a 过程查看者, I want 工具行 summary 从调用参数自动派生（命令/路径/查询等）, so that 不展开也知道这步干了什么
11. As a 过程查看者, I want 工具行有明确的 running/ok/error 状态标识, so that 一眼定位失败步骤
12. As a 过程查看者, I want 中断的执行显示为 stopped 而不是一直转圈, so that 状态真实可信
13. As a 过程查看者, I want 工具行默认折叠、点击整行展开, so that 信息密度由我自己控制
14. As a 过程查看者, I want 展开的长输出在内部滚动容器中, so that 不撑爆消息流
15. As a 过程查看者, I want thinking 独立成行、与正文分开, so that 推理过程清晰可读
16. As a 过程查看者, I want 执行期间有一个贯穿整体的状态条（不随步切换闪烁）, so that 等待体验平稳
17. As a 过程查看者, I want 执行中的实时 chunk 仍可见但组织在状态条/当前步区域内, so that 实时感不丢失

## Implementation Decisions

- **范围**：基本纯前端（apps/web）。后端 Layer A 步级事件（thinking/toolCalls/usage）与 Layer B 流式 chunk（step-start/thinking/text/tool/result）已够推导全部目标状态，不改事件模型、不加 seq、不做 render intent 后端下发（D2）。
- **布局**：通过现有 mc-* 样式体系加媒体查询实现；正文行宽保持克制，卡片/代码块可吃满新宽度；rail（224px）不动（D3/D4）。
- **工具行状态推导**：从 Layer A/B 事件推导四态——tool call 未配对 result = running；result.isError = error；执行结束仍未配对 = stopped（前端合成，参照 dsh 做法）。推导逻辑抽为纯函数（参照 dsh `toolRowModel` 设计），组件只负责渲染。
- **turn 级状态条**：loading 挂整个执行（execution）而非单步，避免步间闪烁（dsh 经验："rides the whole running turn"）。
- **频道 live 状态条数据源**：复用现有 `workunit.execution.step` / `workunit.status_changed` SSE 事件与 useAgentRoster/useWorkUnitEvents 消费层，不新增事件类型。
- **折叠默认值**：工具行默认折叠，展开状态组件本地管理。
- **视觉规范**：全部走 `mission-control.css` mc-* 类与 theme.css 变量，禁写死 Tailwind 浅色类（style-guide 为唯一权威）。

## Testing Decisions

- **主接缝**：React 组件渲染层（vitest + Testing Library，mock SSE/REST），与仓库 120+ 现有测试同一接缝，不新开接缝。
- **状态推导纯函数**单测：四态推导（含中断合成）、summary 从参数派生。
- **票① 布局**：复用 `ChannelDetailPage` 现有渲染测试断言结构不回归；宽度数值人工目检（CSS 值不做单测断言）。
- **票② ExecutionSteps**：扩展现有 `ExecutionSteps.test.tsx`——四态渲染、折叠/展开交互、thinking 独立行。
- **票③ 状态条**：`ChannelDetailPage.test.tsx` 层模拟 `workunit.execution.step` 事件，断言状态条出现/更新/终态/点击开抽屉。
- 好测试标准：只测外部可观察行为（渲染结果、交互），不断言实现细节。

## Out of Scope

- 频道消息流内嵌完整过程展示（维持"过程不进频道"决策）
- 后端事件模型升级（seq/生命周期事件/事件 fold 架构/render intent）——若状态推导真推不出来再单独立项
- 频道 rail 折叠/重排
- 小屏专项优化（不破坏即可）
- dsh 的 cordis/slot 插件体系、通知合批等重基建
- 键盘操作、可访问性打磨等外围（内部工具定位）

## Further Notes

- dsh 浏览器端实际是 WebSocket 而非 SSE；"明明白白"的本质是事件模型 + 分层 loading + render intent，本 spec 只搬交互范式层。
- 遗留升级路径：若后续要搬数据模型（事件 fold + render intent），以本 spec 的纯函数推导层为替换点。
