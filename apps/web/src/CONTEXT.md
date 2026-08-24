# apps/web/src

### 职责

Web 前端主源码。路由、全局状态、API 客户端、UI 组件、样式。App.tsx 组织页面懒加载，axios 封装 RESTful API + SSE 通信。

### 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `App` | `App.tsx` | 根组件：路由/主题/布局/懒加载；频道工作区满高三栏 |
| `api` | `api/index.ts` | axios 实例，Bearer token + 401 自动刷新 |
| `channelApi` | `api/channel.ts` | 频道 CRUD、消息、Agent 配置 |
| `monitoringApi` | `api/monitoring.ts` | 监控/飞轮指标/开销 + terminateInstance |
| `workunitApi` | `api/workunit.ts` | WU 全生命周期 + token/步事件解析 + 流式文案格式化 |
| `requirementApi` | `api/requirements.ts` | 需求 CRUD + 关联 WU 链 |
| `knowledgeApi` | `api/knowledge.ts` | 知识审核 + 知识库浏览 |
| `memoryApi` / `distillApi` | `api/*.ts` | 角色记忆 / 蒸馏人审闸口 |
| `companyApi` / `okrApi` / `notifyApi` / `harnessApi` | `api/*.ts` | 公司 / PMO OKR / 通知配置 / 质量门 |
| `transcriptsApi` / `eventsApi` | `api/*.ts` | WU transcript 只读 / 事件检索 |
| `WebSocketProvider` | `api/websocket.tsx` | SSE Context Provider，根部唯一 EventSource |
| `useWorkUnitEvents` / `useWorkUnitStreamEvents` | `hooks/` | WU SSE 事件 / 步内流式订阅 |
| `useAgentRoster` | `hooks/useAgentRoster.ts` | Agent 作战视图：名册 + SSE 路由 + 轮询 |
| `useAssigneeDisplay` / `AssigneeLabel` | `hooks/useAssigneeDisplay.ts` / `components/workunit/AssigneeLabel.tsx` | 负责人 instance id → 角色名解析（运行实例→离线实例 profile→短 UUID），WU 详情/抽屉/REQ 链路共用 |
| `useChannelList` / `useChannelLiveExecutions` / `useDetectedProviders` | `hooks/` | 频道列表 / live 执行 / provider 探测 |
| `NeedsAttentionSection` | `components/monitoring/` | 监控页「需要处理」区 |
| `ProjectMap` / `NextActionCard` | `components/pmo/ProjectMap.tsx` | PMO 地图 + 下一个该干什么 |
| `ChannelRail` / `WorkUnitDrawer` | `components/channel/` | 左栏频道列表 / 右抽屉 WU 详情（证据/审查/执行/token/REQ） |
| `EvidenceLedger` / `BlockedByList` / `AuthModal` | `components/` | 证据台账 / 依赖清单 / 认证模态框 |

### 依赖关系

上游：同目录子模块（pages/components/stores/hooks/contexts/styles）+ 外部库（react, react-router-dom, axios）。下游：暂无。

### 运行时约定

- 路由用 `React.lazy` 代码分割；API token 从 `localStorage` 直读。**API seam**：端点知识只在 `api/*` 适配模块，页面/hooks 不直接拼 URL。
- **SSE 单连接**：全应用仅根部 `WebSocketProvider` 建一个 EventSource（/events/stream），禁止开第二条。
- **SSE 事件负载消费约定**（2026-08 负载深化批 2，决策 4-6）：`workunit.execution.step` 负载带可选 `channelId`——`useChannelLiveExecutions` 带上时按频道过滤、缺省不过滤（向后兼容）；`workunit.status_changed` 负载 = 全量 WorkUnitData（`parseLiveWuRef` 解析出 id/status/channelId/metadata/type/scope），终态清理 step 条目不限频道（防他频道残留）；ChannelDetailPage 的 waitingWus chip 与 REQ chips = 进频道一次 REST 打底 + SSE 增量维护（`status_changed` / `requirement.created|updated`），不再依赖 messages.length 触发重拉。
- **SSE 负载消费约定·批 3**（决策 7-9）：RequirementsDocCard 纯静态渲染（5s 轮询与 executing 进度分支已删——#278 后无 `meta.status='executing'` 写入方，死代码）；WorkUnitDrawer = 开抽屉一次性 REST 打底（wu 详情/token 历史/overhead 各一次）+ `workunit.status_changed`（同 id 负载直替本地 wu）/ `workunit.tokens`（复用 `parseWorkunitTokenEvents` 防御解析，他 WU/缺字段跳过）SSE 增量，无 eventTick 防抖重拉，`getOverhead` 不随事件重拉；`useWebSocket`/`WebSocketProvider` 暴露 `onReconnect` 注册口（首次 onopen 不触发，重连 onopen 触发一次），ChannelDetailPage 重连落点 = messages `refresh`（chips 缺口靠后续 SSE 增量自愈，强制对齐留收尾批）。
- **`useWorkUnitEvents` 剩余消费面**：AgentDetailPage / WorkUnitListPage / ExecutionSteps（抽屉已改直订阅，hook 保留，共享 poll adapter 属延期工单候选 8）。
- **SSE 负载消费约定·message_updated**（#315，ADR 2026-08-24 D1/D2）：`useChannelMessages` 处理 `channel.message_updated` 优先读负载 `message` 全量本体（meta 为后端合并后真值）整体原位替换；旧形状（无 `message` 字段）回退顶层增量 `content`/`meta` patch。注意生产侧更新会 bump `createdAt`，原位替换不重排序（与刷新后按新 createdAt 归位的差异见 #317）。
- **SSE 负载消费约定·instance status_changed**（#312，ADR 2026-08-24 体检）：`agent.instance.status_changed` 负载带 `currentWorkUnit` 快照/`channelId`/`lastError` 系字段——`useAgentRoster` 以负载快照为准就地更新（含悬空 null），仅旧事件（无快照字段）回退 fillWorkUnit 补查；`ChannelRail` 订阅同事件就地刷状态点/lastError（按 instanceId ‖ roleId 匹配，未加载实例不动、靠轮询发现），online 计数从 agents 状态 useMemo 重算。两处 30s 轮询保留为纯兜底。
- **视觉体系**：`theme.css` 深色变量 + `mission-control.css` 三栏布局（mc-*）与工具类（u-*）。禁止写死浅色 Tailwind 类。规范：`docs/specs/ui/style-guide.md`。
- **频道工作区** = 左 ChannelRail / 中对话流 / 右 WorkUnitDrawer。消息分侧：人类右气泡、agent 左文档流、系统居中。
- **频道流滚动**（#289/#290）：程序写 scrollTop 必记 observed-top 台账（ChannelDetailPage `scrollStreamTo`），钉底/归属/跟随/行锚点判定走 `utils/streamFollow.ts` 纯函数（钉底阈值 `FOLLOW_THRESHOLD_PX=24`）；加载更早 = 行锚点补偿（`data-message-id` 首个可见行位移校正，非高度差）；阅读位置按频道持久化 localStorage（`utils/readingPosition.ts`，切频道/卸载存档，钉底存 null）；ResizeObserver 跟随撑高，离底浮「回到底部」。
- **WU 详情页**（`/workunits/:id`）= 跳转枢纽：Header -> 归属条 -> 证据台账 -> ExecutionSteps -> TranscriptViewer -> DiscussionPanel。
- **Router basename**（#275/#291）：`main.tsx` 接 `import.meta.env.BASE_URL`（dev=`/dev/`、生产=`/`），深链/刷新依赖此对齐；路由层回归测试 `__tests__/App-basename.test.tsx`。
- **F6 铁律**：WU 状态/证据展示一律过 `deriveDisplayState()`（`@dommaker/studio-shared`）。
- **UI 件**：原生 `<select>` 弃用用 `ui/Select`；`Button`+`ConfirmDialog` 替代 `window.confirm`/`alert`。站内跳转用 `useNavigate`。
- **PMO 驾驶舱**：ProjectDetailPage = 头部 -> 进度管道（六泳道）-> 交付台账 -> 项目进展 -> 项目动态。
