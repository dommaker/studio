# 频道页视觉优化（工作条 / 右栏降噪 / 播报卡 / 浮钮 / 空态 / 输入区）

2026-09-08。依据：当日生产实例截图走查（`.wayfinder-tmp/channel-audit-20260908/`，17 张）+ 用户确认的 7 项清单。
全部改动在 `apps/web`。与并行计划 `2026-09-ui-smoothness.md` 的冲突面已切分：批次 1 零冲突先做；批次 2 落在 `ChannelDetailPage.tsx`，等对方 Step 3（频道折叠）落本地 master 后再做。

## 批次 1（零冲突）

### ① P0 ChannelWorkBar stepper 视觉强化
文件：`components/channel/ChannelWorkBar.tsx`（仅 className/结构微调）+ `styles/mission-control.css`（`.mc-workbar` 段）+ 必要时 `styles/wu-detail.css` 的 stepper 类。
问题：四站圆点等距摊满全宽，点径小、连线几乎不可见、站名/时间戳暗灰小字，大屏两端大量留白；不读作进度指示。
方向：
- stepper 不再全宽等分：紧凑排列（站间距固定、左对齐），容器设合理 max-width
- 当前站强化：点径加大 + accent 描边/发光，站名提色提亮；已完成站 accent 实心保留
- 连线可见性：hairline 提对比（用现有 css 变量，不引入新色）
- 时间戳保留但进一步弱化（更小一档/更暗），不抢站名
- 工作条容器与消息流之间拉开分隔（底 hairline 或底色微差），让「这是状态区不是消息」一眼可辨

### ② P0 右栏「其他动态」降噪
文件：右栏组件（`ChannelActivityRail` 一带，先定位「其他动态」列表的渲染处）。
问题：几十条同权重蓝点小字，例行播报（每日洞察/执行失败连刷）淹没有用信号（需要输入/blocked）。
方向（尽量纯前端派生，不动数据源）：
- 同类连续条目折叠：同类型（如 daily_reflection / 执行失败）相邻重复 → 合并为「标题 ×N」一条
- 信号分级：「需要输入 / blocked / 等待人工」类条目提权重（accent/warning 色点 + 正常字色），例行播报降权（更暗一档）
- 折叠与分级规则写成纯函数（如 `deriveActivityRows`），可单测

### ③ P1 系统播报卡层级
文件：agent 文档流消息的 markdown 渲染组件（消息项内）。
问题：DailyReflection 每日洞察卡标题/节标题/正文/bullet 同字号同灰度，扫读成本高。
方向：
- 卡内节标题（如「代码变更」「知识积累」）提层级：accent 色或加重 + 上间距
- 正文与 bullet 保持现字号，微调行高/间距节奏
- 只动样式类，不动 markdown 解析逻辑

### ⑤ P2 WU chip 旁 ↗ 冗余按钮去除
文件：消息项内 WU 链接 chip 渲染处。
问题：chip 本身可点开抽屉，旁又跟一个小箭头按钮，同一目的地两个入口。
方向：删 ↗ 按钮，保留 chip 点击；确认 chip 的 hover/title 已表达「可点开详情」。

### ⑦ P2 输入区细节
文件：`ChannelInput` 组件一带。
- 「0 字」计数器在无输入时隐藏（>0 才显示）
- 底部辅助行（@mention Agent · 回复引用 · Enter 发送）提亮一档到可读（仍保持次级），或收成 hover 提示——取更简单者

## 批次 2（等 ui-smoothness Step 3 落 master 后做）

### ④ P1「回到底部」浮钮
文件：`ChannelDetailPage.tsx` 流区 + css。
问题：浮钮居中悬浮压消息文字。
方向：改贴右下角（输入区上方右对齐），缩小、半透明底色，不遮内容；显隐逻辑（滚动向上才出现）若已有则不动。

### ⑥ P2 空频道态
文件：`ChannelDetailPage.tsx` 空态块。
方向：两行小字之外加 2-3 个可点示例提示 chip（如「@pm 分析需求 …」），点击走现有 prefill 通道填入输入框（复用 SuggestionChips 的 prefill 机制，不新造）；视觉保持低调。

## 验收

- 每项：相关测试（新派生逻辑先 RED 后 GREEN；纯样式改动跑既有相关测试防回归）+ `pnpm --filter @dommaker/studio-web typecheck`
- 批次各自 commit（feat 前缀，只 add 本批文件——工作树有他会话 api 侧未提交改动，严禁混入），不 push
- 全部完成后重截频道页对比走查（复用 `.wayfinder-tmp/channel-audit-20260908/` 的采集脚本）
- 沉淀：改动目录 `CONTEXT.md` 同步
