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
| `memoryApi` / `distillApi` | `api/*.ts` | 角色记忆 / 蒸馏人审闸口（均走 review-proposal 通用端点 `/review-proposals/:kind/:id/*`，#351/#353） |
| `companyApi` / `okrApi` / `notifyApi` / `harnessApi` | `api/*.ts` | 公司 / PMO OKR / 通知配置 / 质量门 |
| `transcriptsApi` / `eventsApi` | `api/*.ts` | WU transcript 只读 / 事件检索 |
| `WebSocketProvider` | `api/websocket.tsx` | SSE Context Provider，根部唯一 EventSource |
| `useGatedPoll` | `hooks/useGatedPoll.ts` | 共享门禁轮询（#313）：挂载首拉 + 仅当（visible ∧ SSE≠connected）按 interval 轮询 + 回 visible 立即补拉 |
| `useWorkUnitStreamEvents` | `hooks/` | WU 步内流式订阅（Layer B） |
| `useAgentRoster` | `hooks/useAgentRoster.ts` | Agent 作战视图：名册 + SSE 路由 + 轮询 |
| `useAssigneeDisplay` / `AssigneeLabel` | `hooks/useAssigneeDisplay.ts` / `components/workunit/AssigneeLabel.tsx` | 负责人 instance id → 角色名解析（运行实例→离线实例 profile→短 UUID），WU 详情/抽屉/REQ 链路共用 |
| `useChannelList` / `useChannelLiveExecutions` / `useDetectedProviders` | `hooks/` | 频道列表 / live 执行 / provider 探测 |
| `deriveStreamView` | `utils/streamView.ts` | 消息流管线纯函数（#322）：消息集+折叠/筛选 UI 状态 → 渲染就绪 items（归组/过程折叠/连续合并/日期分隔/可见性） |
| `useStreamFollow` / `useChannelCardActions` | `hooks/` | 频道流滚动状态机（#322 自 ChannelDetailPage 整块搬移）/ 卡片 action 路由（dispatch 单一入口；#352 起人审提案分支经 PROPOSAL_ACTION_INDEX 参数化调用 proposalCardConfigs.exec） |
| `useProposalReview` / `ReviewProposalCard` | `hooks/useProposalReview.ts` / `components/channel/ReviewProposalCard.tsx` | 人审提案卡合一（#352，ADR 2026-08-25 决策 5）：5 卡坍缩为壳 + `proposalCardConfigs` 纯数据配置；reviewed/pending/armed 生命周期 + 挂载期派生已审态单点化 |
| `ChannelLiveBars` | `components/channel/` | live 执行状态条（#322 自持有 useChannelLiveExecutions，step 事件不触达页面） |
| `NeedsAttentionSection` | `components/monitoring/` | 监控页「需要处理」区 |
| `ProjectMap` / `NextActionCard` | `components/pmo/ProjectMap.tsx` | PMO 地图 + 下一个该干什么 |
| `ChannelRail` / `WorkUnitDrawer` | `components/channel/` | 左栏频道列表 / 右抽屉 WU 详情（证据/审查/执行/token/REQ） |
| `EvidenceLedger` / `BlockedByList` / `AuthModal` | `components/` | 证据台账 / 依赖清单 / 认证模态框 |

### 依赖关系

上游：同目录子模块（pages/components/stores/hooks/contexts/styles）+ 外部库（react, react-router-dom, axios）。下游：暂无。

### 运行时约定

- 路由用 `React.lazy` 代码分割；API token 从 `localStorage` 直读。**API seam**：端点知识只在 `api/*` 适配模块，页面/hooks 不直接拼 URL。
- **SSE 单连接**：全应用仅根部 `WebSocketProvider` 建一个 EventSource（/events/stream），禁止开第二条。**2026-08-25**：/events/stream 已移出 PUBLIC_API，URL 经 `?token=` 携带 JWT（buildSseUrl 每次连接现取 authStore token，EventSource 无法设 Authorization 头）。
- **SSE 事件负载消费约定**（2026-08 负载深化批 2，决策 4-6）：`workunit.execution.step` 负载带可选 `channelId`——`useChannelLiveExecutions` 带上时按频道过滤、缺省不过滤（向后兼容）；`workunit.status_changed` 负载 = 全量 WorkUnitData（`parseLiveWuRef` 解析出 id/status/channelId/metadata/type/scope），终态清理 step 条目不限频道（防他频道残留）；ChannelDetailPage 的 waitingWus chip 与 REQ chips = 进频道一次 REST 打底 + SSE 增量维护（`status_changed` / `requirement.created|updated`），不再依赖 messages.length 触发重拉。
- **SSE 负载消费约定·批 3**（决策 7-9）：RequirementsDocCard 纯静态渲染（5s 轮询与 executing 进度分支已删——#278 后无 `meta.status='executing'` 写入方，死代码）；WorkUnitDrawer = 开抽屉一次性 REST 打底（wu 详情/token 历史/overhead 各一次）+ `workunit.status_changed`（同 id 负载直替本地 wu）/ `workunit.tokens`（复用 `parseWorkunitTokenEvents` 防御解析，他 WU/缺字段跳过）SSE 增量，无 eventTick 防抖重拉，`getOverhead` 不随事件重拉；`useWebSocket`/`WebSocketProvider` 暴露 `onReconnect` 注册口（首次 onopen 不触发，重连 onopen 触发一次），ChannelDetailPage 重连落点 = messages `refresh`（chips 缺口靠后续 SSE 增量自愈，强制对齐留收尾批）。
- **SSE 负载消费约定·批 4**（#318，#313 follow-up）：`useWorkUnitEvents` 门铃 hook 已删——三处剩余消费面全部改负载直更。ExecutionSteps：`workunit.execution.step` 负载经 `parseExecutionStepEvents` 就地 append（executionId-step 去重后者覆盖、步号升序、首拉在途事件暂存并入），重连一次性 refetch；WorkUnitListPage：store `applyWorkunitEvent`——`status_changed` 直替/移除行（未知行不插入防跨页重复）、`created` 插头部，过滤不符就地移除/不插入，旧形状负载缺 `claimable` 保留原值（ADR D2 回退）；**取舍 a**：分页 total 本地 ±1 近似维护，页边界不追齐——本页无轮询兜底，自愈靠 SSE 重连 refetch、过滤切换/创建/审查等操作触发的 loadWorkUnits 与路由重进首拉；**取舍 c**：`status_changed` 未知行（不在当前页）即使新进过滤集也不插入（服务端过滤 + 分页下无法判定页内归属，插入会跨页重复），同靠上述路径自愈；AgentDetailPage：`agent.instance.status_changed`（profileId 匹配）就地更新（additive `pmo`/`startedAt`，旧形状缺键回退保留），`workunit.status_changed` 就地更新当前卡状态与历史行；**取舍 b**：历史任务「最近 20 条 + total」窗口无事件语义——命中本实例时 800ms 防抖只重拉历史区 1 接口对齐，不再整页 5 接口。后端 additive：`workunit.created/status_changed` 负载附 `claimable`（口径同 GET / 列表路由：unassigned 且无未了结依赖才 true，其余恒 false 不读 index）。
- **共享门禁轮询 `useGatedPoll`**（#313，架构评审候选 8）：组件级私有轮询已收敛——`ChannelRail`/`useAgentRoster`（30s）、`useChannelEvents`（10s）全部走该 hook；语义 = 挂载首拉 + 仅当（visible ∧ SSE≠connected）轮询 + 回 visible 立即补拉；消费方 403 终态逻辑留在各自 fetch 闭包（短路请求，不新增依赖）。新轮询需求一律复用，禁止再写裸 setInterval 轮询（NotificationBell UI flash 定时器除外）。**useChannelEvents refetch = 合并语义**（#328）：同频道 refetch 最新一页按 id 归并（已存在的以服务端版本刷新、新消息按 createdAt 有序插入），prepend 的历史页不丢；首拉/频道切换仍替换。hasMore 仅当本地最老消息落在最新一页内才以响应为准（页的 hasMore 描述头部方向，prepend 出页外时直接覆盖会错误重置 prepend 方向状态）。已知留白：SSE 连着时 AgentDashboardPage 上新建 profile 要等 remount 才发现（无 `agent.profile.created` 事件，决策接受）。
- **SSE 负载消费约定·message_updated**（#315，ADR 2026-08-24 D1/D2）：`useChannelMessages` 处理 `channel.message_updated` 优先读负载 `message` 全量本体（meta 为后端合并后真值）整体原位替换；旧形状（无 `message` 字段）回退顶层增量 `content`/`meta` patch。`createdAt` 为不可变诞生时刻（#317，ADR 2026-08-24 message-createdat-immutable），原位替换与刷新归位因此恒一致。
- **SSE 负载消费约定·instance status_changed**（#312，ADR 2026-08-24 体检；#313 修订）：`agent.instance.status_changed` 负载带 `currentWorkUnit` 快照/`channelId`/`lastError` 系字段——`useAgentRoster` 以负载快照为准就地更新（含悬空 null），仅旧事件（无快照字段）回退 fillWorkUnit 补查；`ChannelRail` 订阅同事件就地刷状态点/lastError（按 instanceId ‖ roleId 匹配），**未匹配实例 = 新角色实例，用负载（profileId/instanceId/name/status）合成条目插头部**（#313 起轮询不再承担发现职责——SSE 连着时它不起表），online 计数从 agents 状态 useMemo 重算。两处 30s 轮询经 useGatedPoll 保留为 SSE 断开兜底。
- **视觉体系**：`theme.css` 深色变量 + `mission-control.css` 三栏布局（mc-*）与工具类（u-*）。禁止写死浅色 Tailwind 类。规范：`docs/specs/ui/style-guide.md`。
- **频道工作区** = 左 ChannelRail / 中对话流 / 右 WorkUnitDrawer。消息分侧：人类右气泡、agent 左文档流、系统居中。
- **消息流管线**（#322）：ChannelDetailPage 只剩编排（取数 hooks 组合 + 布局）。渲染段经 `useMemo` 消费 `deriveStreamView(messages, uiState)`（`utils/streamView.ts`）——归组（`groupIntoThreads`）/过程消息折叠（`collapseProcessReplies`）/连续合并（`shouldOmitHead`）/日期分隔/completed·active·visible 可见性全部算好；折叠 UI 状态（showCompleted/expandedThreads/expandedProcGroups）留组件作输入。滚动状态机在 `hooks/useStreamFollow.ts`，卡片 action 路由在 `hooks/useChannelCardActions.ts`（dispatch 单一入口，messages 经镜像 ref 保持 identity 稳定）。`ChannelMessageItem` 已 `React.memo`，父组件稳定 props 契约（`useCallback`/镜像 ref，onToggleThread 收 anchorId）——render-count 测试断言 step 事件下既有消息项零重渲。**live 执行状态下沉**：`useChannelLiveExecutions` 由 `ChannelLiveBars` 组件自持有（原调用点在页面），`workunit.execution.step` 只重渲该组件边界。
- **频道流滚动**（#289/#290；#322 起实现在 `hooks/useStreamFollow.ts`）：程序写 scrollTop 必记 observed-top 台账（useStreamFollow `scrollStreamTo`），钉底/归属/跟随/行锚点判定走 `utils/streamFollow.ts` 纯函数（钉底阈值 `FOLLOW_THRESHOLD_PX=24`）；加载更早 = 行锚点补偿（`data-message-id` 首个可见行位移校正，非高度差）；阅读位置按频道持久化 localStorage（`utils/readingPosition.ts`，切频道/卸载存档，钉底存 null）；ResizeObserver 跟随撑高，离底浮「回到底部」。
- **频道流虚拟化**（#325，ADR 2026-08-24 channel-stream-virtualization；2026-08-24 实施落地）：`@tanstack/react-virtual`（core 3.17.8），一期仅渲染层、数据层裁剪归 #326。virtualizer 建在 `useStreamFollow`：`scrollToFn` 自定义过 observed-top 台账（一切 virtualizer 滚动写入记账）；`shouldAdjustScrollPositionOnItemSizeChange=()=>false`（校正权独占）；prepend 补偿 = `measurementsCache` 按 key 查 item start 位移 + item 内偏移（不用 prepend 后 DOM 查询——锚行已掉出窗口）；阅读位置恢复两段式（`scrollToIndex` 粗定位自带收敛 → 锚行进 DOM 精校正一次）；钉底/跟随维持元素几何（spacer 高 = totalSize，距底即末行局部几何）。页面侧：头部块（加载更早/折叠 toggle/空态）与 spacer 分离，`scrollMargin` = 头部高（RO 测量）；行渲染块平移 + `measureElement`。纯函数在 `utils/streamVirtual.ts`（key/mid→item 映射/补偿数学）。**测试 seam**：`STREAM_VIRTUAL_ENABLED`（`import.meta.env.MODE !== 'test'`）——jsdom 无布局走全量渲染，页面测试不碰虚拟化；虚拟化行为 = 纯函数单测 + 浏览器实测。实测基线（2026-08-24，#系统 599 条）：DOM 常驻 18 行、prepend 补偿漂移 0px、恢复偏差 121px、跟随/回底正常。已知坑：估计坐标系下向上滚入未测量区有「边滚边修正」漂移（估计 120px 取舍，校正权独占的代价）。
- **频道数据层降级**（#326，ADR 2026-08-25 channel-message-data-pruning）：远离视口的上方历史原位骨架化（`degraded` 标记，剥 content/meta 大头、留结构字段 + meta `{status,cardType}` 标量子集——isCompleted/mergeable 判定输入）。判定纯函数 `utils/messagePruning.ts`（`degradeMessage`/`planPrune`，K=100 保底、D1=50 降级 / D2=30 水合迟滞）；接线在 `useChannelMessages.syncPruning(anchorMid)`——ChannelDetailPage 以首个 virtual item 代表消息 id 驱动（仅虚拟化路径，jsdom 页面测试不降级）。水合 = 防抖 200ms 整页取（before=首个非骨架 id，limit 100）+ mergePage 归并原位复活，**不触碰 hasMore**；in-flight 期间触发重排不丢；`message_updated` 全量本体天然复活，legacy patch 仅带 content 才复活。骨架渲染 = `mc-msg-skeleton` 占位行（保留 data-message-id 供锚点定位；thread anchor 骨架 → 整线程项占位）。阅读位置粗锚/精锚分级：锚行骨架 ⇔ 存档 `coarse: true` 或恢复时命中骨架 → scrollToIndex 行级定位即完成，不像素精校正。
- **WU 详情页**（`/workunits/:id`）= 跳转枢纽：Header -> 归属条 -> 证据台账 -> ExecutionSteps -> TranscriptViewer -> DiscussionPanel。
- **Router basename**（#275/#291）：`main.tsx` 接 `import.meta.env.BASE_URL`（dev=`/dev/`、生产=`/`），深链/刷新依赖此对齐；路由层回归测试 `__tests__/App-basename.test.tsx`。
- **F6 铁律**：WU 状态/证据展示一律过 `deriveDisplayState()`（`@dommaker/studio-shared`）。
- **UI 件**：原生 `<select>` 弃用用 `ui/Select`；`Button`+`ConfirmDialog` 替代 `window.confirm`/`alert`。站内跳转用 `useNavigate`。
- **PMO 驾驶舱**：ProjectDetailPage = 头部 -> 进度管道（六泳道）-> 交付台账 -> 项目进展 -> 项目动态。
- **频道翻页游标（#319，2026-08-24）**：`useChannelMessages.loadMore` 的 `before` = 最老消息 **id**（原 createdAt 时间戳，同毫秒多条会漏/重）；后端锚点 id 不存在时返回空页 + hasMore=false，loadMore 据此自然停止
