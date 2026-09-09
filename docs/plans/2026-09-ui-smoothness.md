# Studio Web UI 丝滑化改造（任务列表 / 频道折叠 / Agent 状态）

2026-09-08。全部改动在 `apps/web`（词表在 `packages/studio-shared`）。单票直落 local master，分 3 个 checkpoint 提交。

## 方向（已与需求方确认）

- 任务列表：两套筛选合一，只留「数字+状态」统计条且可点击筛选；状态集合缩小；列表行去大边框重设计，展开区要有设计感
- 频道折叠：默认展开 + localStorage 记住状态，折叠层级 4 → 2
- Agent 状态：7+1 态合并为 4 态，异常改为红点角标
- 范围：三块全做

## Step 1：Agent 状态合并为 4 态

改动 `apps/web/src/utils/agentStatus.ts` + 消费方，不动后端。

- 新增展示层分组（内部 `CardStatusKey` 7+1 态保留作细分依据）：
  - `DisplayStatusKey = 'working' | 'attention' | 'idle' | 'offline'`
  - 映射：`running→working`；`in_review / blocked / error→attention`（待处理，需人介入）；`idle→idle`；`none / terminated / disabled→offline`
  - 新词表 `DISPLAY_STATUS_LABELS`：工作中 / 待处理 / 空闲 / 离线；配色 working=绿、attention=黄（error 叠加红）、idle/offline=灰
  - 新增 `resolveDisplayStatus(profileStatus, instanceStatus, wuStatus)`，内部走现有 `resolveCardStatusKey`
- `AgentDashboardPage.tsx`：7 个 StatFilter chip → 5 个（总数 / 工作中 / 待处理 / 空闲 / 离线），`StatusFilter` 类型同步收窄
- `RoleCard.tsx`：状态 pill 显示 4 态词；`statusKey === 'error'` 时在角色名前加红点角标（`agent-dashboard.css` 加 `.agd-dot-err`）；`data-status` 改挂 display key
- `AgentDetailPage.tsx` 头部 pill 同步消费新口径（#433 同源契约），pill 旁小字保留细分原文（如「待处理 · 阻塞」）
- 测试：`utils/__tests__/agentStatus.test.ts`、`pages/__tests__/AgentDashboardPage.test.tsx`、`AgentDashboardPage-render-count.test.tsx`、`AgentDetailPage.test.tsx`

## Step 2：任务列表重做

文件 `apps/web/src/pages/WorkUnitListPage.tsx` + `styles/` 新增 `.wu-*` 样式。

- 筛选合一：删除第二套 pill 行（`STATUS_OPTIONS` 8 项 + 待人工 + 未归属）；统计条改造为可点击 chip（复用 AgentDashboard `StatFilter` 模式：数字+状态+点击过滤/再点取消）：
  - chip 集：全部(总数) / 待确认 / 待领取 / 进行中 / 待验收 / 待人工 — 6 个
  - 待确认/待领取/进行中/待验收 → 服务端 `statusFilter`；待人工 → 现有 `humanOnly` 客户端派生过滤
  - 「未归属」保留为一个低调小 chip（#405 归因信号）
  - 完成/已关闭/阻塞不再单列筛选，列表行徽标照常显示；`?status=` URL 初始化（#184 下钻链接）保留兼容
- 行重设计：
  - 去 `card` 边框块 → 无边框行：行间细分隔线 + 左侧 3px 状态色条 + hover 底色；展开时左侧色条延伸、背景微亮
  - 头部行信息层级：状态色点+状态词（小字）→ 标题（主）→ 类型/REQ/被阻塞 弱化 chip → 右侧时间 + 操作按钮 + 展开符
  - 次行 ID/Agent/创建时间等 mono 小字合并为一行 meta
- 展开区重设计：
  - metadata grid → 复用 `components/ui/MetaStrip` 紧凑横排
  - Metadata JSON `<pre>` 默认收进「查看 metadata」toggle
  - ExecutionSteps / DiscussionPanel 加分节小标题，区块间距统一
- 测试：`pages/__tests__/WorkUnitListPage.test.tsx`

## Step 3：频道折叠 4 层 → 2 层 + 持久化

文件：`apps/web/src/utils/streamView.ts`、`pages/ChannelDetailPage.tsx`、新增 hook。

- 层级归并：
  - 线程默认展开：`expandedThreads: Set` 语义反转为 `collapsedThreads: Set`（默认空 = 全展开）；`deriveStreamView` 的 `StreamUiState` 相应调整；`locateWaitingQuestion` / highlight 定位里「先展开线程」的逻辑改为「从 collapsedThreads 移除」
  - 线程内过程消息组保持为一层折叠（默认收拢成「▸ N 条过程消息」摘要），不再嵌套第二层
  - 已完成消息 toggle、翻页按钮维持现状（翻页是数据边界非折叠）
- 持久化：新增 `hooks/usePersistentStreamUI.ts`——`{ showCompleted, collapsedThreads[], expandedProcGroups[] }` 按频道存 localStorage（key `mc-stream-ui:v1:<channelId>`），切换频道/刷新后恢复；读取失败静默回退默认值
- 测试：`utils/__tests__/`（streamView 折叠语义反转）、`pages/__tests__/ChannelDetailPage.test.tsx`、持久化 hook 单测

## 收尾

- 同步改动目录的 `CONTEXT.md`（pages / utils / components/monitoring / hooks）
- 验证（收尾最小验证）：相关测试文件 + `pnpm --filter @dommaker/studio-web typecheck`，不跑全量
- 每个 checkpoint 单独 commit（feat 前缀），不 push、不 ship
- 视觉走查：起 `pnpm dev` 人工过目三页
