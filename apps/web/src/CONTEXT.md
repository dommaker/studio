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
| `knowledgeApi` | `api/knowledge.ts` | 知识审核 + 知识库浏览；knowledge_proposal 卡审批走 review-proposal 通用端点（kind='knowledge'，#355），promote/demote 为条目生命周期端点（非提案场景） |
| `memoryApi` / `distillApi` | `api/*.ts` | 角色记忆 / 蒸馏人审闸口（均走 review-proposal 通用端点 `/review-proposals/:kind/:id/*`，#351/#353） |
| `companyApi` / `okrApi` / `notifyApi` / `harnessApi` | `api/*.ts` | 公司 / PMO OKR / 通知配置 / 质量门 |
| `transcriptsApi` / `eventsApi` | `api/*.ts` | WU transcript 只读 / 事件检索 |
| `WebSocketProvider` | `api/websocket.tsx` | SSE Context Provider，根部唯一 EventSource |
| `useGatedPoll` | `hooks/useGatedPoll.ts` | 共享门禁轮询（#313）：挂载首拉 + 仅当（visible ∧ SSE≠connected）按 interval 轮询 + 回 visible 立即补拉 |
| `useAsyncData` | `hooks/useAsyncData.ts` | 一次性拉取共享 hook（#350，与 useGatedPoll 互补）：data/loading/error + `reload()`（重拉保留旧数据、即清 error）+ `setData`（SSE 就地更新等本地修补）；deps 渲染期重置 + 微任务推迟首拉 + alive 守卫拒迟到响应；返回值 useMemo 稳身份，可直接进 effect deps（SSE 订阅类） |
| `useWorkUnitStreamEvents` | `hooks/` | WU 步内流式订阅（Layer B） |
| `rosterStore` | `stores/rosterStore.ts` | roster 数据面（#346）：三端点 TTL 缓存 + single-flight 去重、instance/workunit status_changed SSE 就地更新唯一一份（未匹配合成条目）、快照补查写回；切片独立（summary 403 → forbidden，profiles/channels 照常） |
| `useRosterStoreSync` | `hooks/useRosterStoreSync.ts` | rosterStore 实时接线（#346）：引用计数单例 SSE 路由 + useGatedPoll(ensureFresh) 兜底 + 重连强制对齐 |
| `useAgentRoster` | `hooks/useAgentRoster.ts` | Agent 作战视图私有面：roles 派生 + 执行动态 SSE 写入（execution.step/stream→rosterActivityStore，#348）+ 空闲卡最近完成 N+1 + 快照补查；数据面全在 rosterStore |
| `rosterActivityStore` / `useRosterActivities` | `stores/rosterActivityStore.ts` | 执行动态 store（#348）：step/stream chunk 按 roleId 切片（pushActivity 同 key 刷新尾条、上限 10 条），卡片级订阅 + 卸载 reset（页面私有实时面，不跨挂载残留） |
| `useNotificationStore` | `stores/notificationStore.ts` | 通知中心共享 store：后端持久面（loadFromBackend，SSE 条目保留）+ SSE atHuman 增量（pushSse，cap 50）+ 已读动作（markRead/markAllRead/markChannelRead，本地乐观 + 后端条目 POST 同步）；Notification.messageId 仅 SSE 条目有 |
| `RoleCard` | `components/monitoring/RoleCard.tsx` | AgentDashboard 作战卡（#348 自页面下沉）：memo + 自订动态切片，chunk 只重渲对应卡、静态卡壳零重渲 |
| `useAssigneeDisplay` / `AssigneeLabel` | `hooks/useAssigneeDisplay.ts` / `components/workunit/AssigneeLabel.tsx` | 负责人 instance id → 角色名解析（运行实例→离线实例 profile→短 UUID），WU 详情/抽屉/REQ 链路共用 |
| `useChannelList` / `useChannelLiveExecutions` / `useDetectedProviders` | `hooks/` | 频道列表 / live 执行 / provider 探测 |
| `ChannelHomeRedirect` / `lastChannel` | `pages/ChannelHomeRedirect.tsx` / `utils/lastChannel.ts` | #393：`/` 与 `/channels` 重定向进频道工作区（频道列表页已删除，spec §2）；落点 = 最近访问（ChannelDetailPage 进页写 localStorage）→ rnd → 首频道 → 零频道空态内联 CreateChannelForm |
| `BackButton` | `components/ui/BackButton.tsx` | #393 详情页统一左上「← 返回」（spec §4.4）：history.state.idx>0 → navigate(-1)，直开/书签回落 fallback 列表页；PMO 项目/Agent/WU/阅览室文档/Workspace 五页接入 |
| `deriveStreamView` | `utils/streamView.ts` | 消息流管线纯函数（#322）：消息集+折叠/筛选 UI 状态 → 渲染就绪 items（归组/过程折叠/连续合并/日期分隔/可见性） |
| `formatShortTime` / `formatFullTime` | `utils/datetime.ts` | zh-CN 时间格式唯一出口（#358：6 处 formatTime 拷贝 + 6 处内联 toLocaleString 收口）；短格式空值回 `-` |
| `parseWuMeta` | `utils/wuMeta.ts` | WU metadata JSON 解析唯一出口（#358：4 处逐字 try/catch 拷贝收口，模式对齐 #264 messageMeta） |
| `fanOut` | `utils/fanOut.ts` | 并行扇出统一口径（#349：PMO 徽章统计 / fog 决策单 / roster 空闲卡最近完成 / BlockedByList / memory 逐草稿结算 / WU 产出文件集 六处手写 allSettled+try-catch 收口）：单条失败隔离不炸整批 + 结果按输入 index 对齐，无并发上限；调用方自带归并策略（丢弃/兜底 null/兜底行），取消仍留调用侧。注意：① items 为无类型 axios 响应链（any）时泛型 T 退化 unknown，调用侧需显式标注元素类型；② repo 非 strict，false 分支取 error 需 `entry.ok === true`（见 fanOut.ts 内注） |
| `useStreamFollow` / `useChannelCardActions` | `hooks/` | 频道流滚动状态机（#322 自 ChannelDetailPage 整块搬移）/ 卡片 action 路由（dispatch 单一入口；#352 起人审提案分支经 PROPOSAL_ACTION_INDEX 参数化调用 proposalCardConfigs.exec） |
| `useProposalReview` / `ReviewProposalCard` | `hooks/useProposalReview.ts` / `components/channel/ReviewProposalCard.tsx` | 人审提案卡合一（#352，ADR 2026-08-25 决策 5）：6 卡坍缩为壳 + `proposalCardConfigs` 纯数据配置（#356 auditor_suggestion 并入，AuditorSuggestionCard 删除）；reviewed/pending/armed 生命周期 + 挂载期派生已审态单点化；act 执行未全绿时按提案状态重派生一次，命中终态即时收敛；memory 卡 exec 逐草稿结算含 not-pending 同向终态幂等跳过 + failed 终态标签（#367，正本闸门不可逆） |
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
- **SSE 负载消费约定·批 4**（#318，#313 follow-up）：`useWorkUnitEvents` 门铃 hook 已删——三处剩余消费面全部改负载直更。ExecutionSteps：`workunit.execution.step` 负载经 `parseExecutionStepEvents` 就地 append（executionId-step 去重后者覆盖、步号升序、首拉在途事件暂存并入），重连一次性 refetch；WorkUnitListPage：store `applyWorkunitEvent`——`status_changed` 直替/移除行（未知行不插入防跨页重复）、`created` 插头部，过滤不符就地移除/不插入，旧形状负载缺 `claimable` 保留原值（ADR D2 回退）；**取舍 a**：分页 total 本地 ±1 近似维护，页边界不追齐——本页无轮询兜底，自愈靠 SSE 重连 refetch、过滤切换/创建/审查等操作触发的 loadWorkUnits 与路由重进首拉；**取舍 c**：`status_changed` 未知行（不在当前页）即使新进过滤集也不插入（服务端过滤 + 分页下无法判定页内归属，插入会跨页重复），同靠上述路径自愈；AgentDetailPage：instance/当前卡状态面已上移 rosterStore（#346），本页保留 `workunit.status_changed` 历史行就地更新；**取舍 b**：历史任务「最近 20 条 + total」窗口无事件语义——命中本实例时 800ms 防抖只重拉历史区 1 接口对齐，不再整页 5 接口。后端 additive：`workunit.created/status_changed` 负载附 `claimable`（口径同 GET / 列表路由：unassigned 且无未了结依赖才 true，其余恒 false 不读 index）。
- **共享门禁轮询 `useGatedPoll`**（#313，架构评审候选 8）：组件级私有轮询已收敛——`useRosterStoreSync`（#346 起 ChannelRail/useAgentRoster 的 30s 轮询经 store 接线单点走该 hook）、`useChannelEvents`（10s）；语义 = 挂载首拉 + 仅当（visible ∧ SSE≠connected）轮询 + 回 visible 立即补拉；消费方 403 终态逻辑留在各自 fetch 闭包（短路请求，不新增依赖）。新轮询需求一律复用，禁止再写裸 setInterval 轮询（NotificationBell UI flash 定时器除外）。**useChannelEvents refetch = 合并语义**（#328）：同频道 refetch 最新一页按 id 归并（已存在的以服务端版本刷新、新消息按 createdAt 有序插入），prepend 的历史页不丢；首拉/频道切换仍替换。hasMore 仅当本地最老消息落在最新一页内才以响应为准（页的 hasMore 描述头部方向，prepend 出页外时直接覆盖会错误重置 prepend 方向状态）。已知留白：SSE 连着时 AgentDashboardPage 上新建 profile 要等 remount 才发现（无 `agent.profile.created` 事件，决策接受）。
- **一次性拉取 `useAsyncData`**（#350，架构评审候选 F5）：useGatedPoll 之外的姊妹 hook，吃掉 `useState(data/loading/error)+useCallback(load)+useEffect(load)` 样板——6 处消费方归一（MonitoringPage / NeedsAttentionSection / ProjectDetailPage / PMOPage / KnowledgePage / AgentDetailPage 历史窗口）。语义：挂载首拉（微任务推迟，纪律同 useGatedPoll）+ deps 渲染期重置（切参当帧清数据置回加载，prevX 微模式内建）+ `reload()`（重拉保留旧数据、即清 error，刷新按钮/事件路径复用）+ `setData`（SSE 就地更新绕过 fetch 生命周期）。约定：**错误上屏与静默的分工留在 fetcher**——主拉取直接 reject（hook 落 `error.message`，要友好文案就在 fetcher 内 `throw new Error(...)`），best-effort 子拉取 fetcher 内自 catch 落 null（hook error 不上屏）。依赖驱动级联：ProjectDetailPage 子拉取 deps=[project.data]（身份变化即级联重拉，替代原 loadData 全量串行）。新的一次性拉取一律复用，禁止再写裸 useState+useEffect 组合。已知行为差：拉取失败后成功刷新会清 error（原 MonitoringPage 永不清理的潜在 bug 顺带修正）；ProjectDetail 子拉取由串行改并行（首屏更快，pop-in 顺序不变）。
- **SSE 负载消费约定·message_updated**（#315，ADR 2026-08-24 D1/D2）：`useChannelMessages` 处理 `channel.message_updated` 优先读负载 `message` 全量本体（meta 为后端合并后真值）整体原位替换；旧形状（无 `message` 字段）回退顶层增量 `content`/`meta` patch。`createdAt` 为不可变诞生时刻（#317，ADR 2026-08-24 message-createdat-immutable），原位替换与刷新归位因此恒一致。
- **SSE 负载消费约定·instance status_changed**（#312，ADR 2026-08-24 体检；#313 修订）：`agent.instance.status_changed` 负载带 `currentWorkUnit` 快照/`channelId`/`lastError` 系字段——#346 起就地更新唯一一份在 `rosterStore.applyInstanceStatusEvent`：以负载快照为准（含悬空 null），仅旧事件（无快照字段）回退补查；instanceId ‖ roleId 匹配（error 事件带新 instanceId 时RoleId 兜底并切 id），**未匹配实例 = 新角色实例，用负载合成条目插头部**（轮询不承担发现职责）；原 useAgentRoster/ChannelRail 两副本已删。消费方 selector 订阅（roster 卡片/ChannelRail 状态点/AgentDetailPage），online 计数等派生面各自 useMemo。30s 轮询经 useRosterStoreSync→useGatedPoll 保留为 SSE 断开兜底。
- **视觉体系**：`theme.css` 深色变量 + `mission-control.css` 三栏布局（mc-*）与工具类（u-*）。#380/#392 起正文/UI = `--font-sans`，mono 限定代码/ID/时间戳/统计数字（`--fs-stat` 消费方须带 `font-mono`）。禁止写死浅色 Tailwind 类。规范：`docs/specs/ui/style-guide.md`。
- **导航骨架**（#393，spec §2/§4.1/§4.4）：左侧菜单 4 主项（频道/PMO/WorkUnit/Agent）+「更多」展开组（知识库/阅览室/监控/设置/审计日志，收纳路由激活时默认展开并高亮）；全局 sidebar 桌面宽 176px（`responsive.css` ≥640px 档）；详情页返回一律 `ui/BackButton`（PMO 项目→/pmo、Agent→/agents、WU→/workunits、阅览室文档→/library、Workspace→/settings），禁止再写右侧「返回」或散落的 navigate(-1) 拷贝。
- **频道工作区** = 左 ChannelRail / 中对话流 / 右 WorkUnitDrawer。消息分侧：人类右气泡、agent 左文档流、系统居中。
- **消息流管线**（#322）：ChannelDetailPage 只剩编排（取数 hooks 组合 + 布局）。渲染段经 `useMemo` 消费 `deriveStreamView(messages, uiState)`（`utils/streamView.ts`）——归组（`groupIntoThreads`）/过程消息折叠（`collapseProcessReplies`）/连续合并（`shouldOmitHead`）/日期分隔/completed·active·visible 可见性全部算好；折叠 UI 状态（showCompleted/expandedThreads/expandedProcGroups）留组件作输入。滚动状态机在 `hooks/useStreamFollow.ts`，卡片 action 路由在 `hooks/useChannelCardActions.ts`（dispatch 单一入口，messages 经镜像 ref 保持 identity 稳定）。`ChannelMessageItem` 已 `React.memo`，父组件稳定 props 契约（`useCallback`/镜像 ref，onToggleThread 收 anchorId）——render-count 测试断言 step 事件下既有消息项零重渲。**live 执行状态下沉**：`useChannelLiveExecutions` 由 `ChannelLiveBars` 组件自持有（原调用点在页面），`workunit.execution.step` 只重渲该组件边界。
- **AgentDashboard 渲染边界**（#348，对齐 #322 三件套）：执行动态（workunit.execution.step/stream chunk）落 `rosterActivityStore`，`RoleCard`（memo）经 `useRosterActivities(roleId)` 只订自己切片——chunk 只重渲对应卡、页面整树不动（render-count 测试断言静态卡零重渲）；页面不持有 activities state，stats useMemo；动态文案 formatter 唯一出处 `api/workunit.ts formatExecutionStreamChunkText`。
- **频道流滚动**（#289/#290；#322 起实现在 `hooks/useStreamFollow.ts`）：程序写 scrollTop 必记 observed-top 台账（useStreamFollow `scrollStreamTo`），钉底/归属/跟随/行锚点判定走 `utils/streamFollow.ts` 纯函数（钉底阈值 `FOLLOW_THRESHOLD_PX=24`）；加载更早 = 行锚点补偿（`data-message-id` 首个可见行位移校正，非高度差）；阅读位置按频道持久化 localStorage（`utils/readingPosition.ts`，切频道/卸载存档，钉底存 null；存档 cleanup 必须挂 layout effect——#340：unmount 时 React 先跑组件自身 layout destroy、后遍历子树 detach ref/DOM 移除，passive cleanup 时 `streamRef` 已 detach，`captureAnchor` 量不到锚点）；ResizeObserver 跟随撑高，离底浮「回到底部」。
- **频道流虚拟化**（#325，ADR 2026-08-24 channel-stream-virtualization；2026-08-24 实施落地）：`@tanstack/react-virtual`（core 3.17.8），一期仅渲染层、数据层裁剪归 #326。virtualizer 建在 `useStreamFollow`：`scrollToFn` 自定义过 observed-top 台账（一切 virtualizer 滚动写入记账）；`shouldAdjustScrollPositionOnItemSizeChange=()=>false`（校正权独占）；prepend 补偿 = `measurementsCache` 按 key 查 item start 位移 + item 内偏移（不用 prepend 后 DOM 查询——锚行已掉出窗口）；阅读位置恢复两段式（`scrollToIndex` 粗定位 → **reconcile 收敛后**精校正，#339：scrollToIndex 会置内部 scrollState 跑 rAF reconcile 循环、测量落地期间反复把 scrollTop 改写回 align-start 目标，锚行进 DOM 即落地必被踩掉；现收敛（scrollState 清空，`virtualizerScrollSettled` 按版本运行时锚定）后经 rAF 轮询一次性落地，决策纯函数 `planFineAdjust`（wait/abandon/apply；读者滚动在途放弃；收敛后锚行缺席有 10 帧宽限——settle 观察帧可能早于锚行 React 提交一拍）；读者滚动/换频道/回底意图均放弃挂起校正）；钉底/跟随维持元素几何（spacer 高 = totalSize，距底即末行局部几何）。页面侧：头部块（加载更早/折叠 toggle/空态）与 spacer 分离，`scrollMargin` = 头部高（RO 测量）；行渲染块平移 + `measureElement`。纯函数在 `utils/streamVirtual.ts`（key/mid→item 映射/补偿数学）。**测试 seam**：`STREAM_VIRTUAL_ENABLED`（`import.meta.env.MODE !== 'test'`）——jsdom 无布局走全量渲染，页面测试不碰虚拟化；虚拟化行为 = 纯函数单测 + 浏览器实测。实测基线（2026-08-24，#系统 599 条）：DOM 常驻 18 行、prepend 补偿漂移 0px、恢复偏差 121px、跟随/回底正常。已知坑：估计坐标系下向上滚入未测量区有「边滚边修正」漂移（估计 120px 取舍，校正权独占的代价）。
- **频道数据层降级**（#326，ADR 2026-08-25 channel-message-data-pruning）：远离视口的上方历史原位骨架化（`degraded` 标记，剥 content/meta 大头、留结构字段 + meta `{status,cardType}` 标量子集——isCompleted/mergeable 判定输入）。判定纯函数 `utils/messagePruning.ts`（`degradeMessage`/`planPrune`，K=100 保底、D1=50 降级 / D2=30 水合迟滞）；接线在 `useChannelMessages.syncPruning(anchorMid)`——ChannelDetailPage 以首个 virtual item 代表消息 id 驱动（仅虚拟化路径，jsdom 页面测试不降级）。水合 = 防抖 200ms 整页取（before=首个非骨架 id，limit 100）+ mergePage 归并原位复活，**不触碰 hasMore**；in-flight 期间触发重排不丢；`message_updated` 全量本体天然复活，legacy patch 仅带 content 才复活。骨架渲染 = `mc-msg-skeleton` 占位行（保留 data-message-id 供锚点定位；thread anchor 骨架 → 整线程项占位）。阅读位置粗锚/精锚分级：锚行骨架 ⇔ 存档 `coarse: true` 或恢复时命中骨架 → scrollToIndex 行级定位即完成，不像素精校正。
- **WU 详情页**（`/workunits/:id`）= 跳转枢纽：Header -> 归属条 -> 证据台账 -> ExecutionSteps -> TranscriptViewer -> DiscussionPanel。
- **Router basename**（#275/#291）：`main.tsx` 接 `import.meta.env.BASE_URL`（dev=`/dev/`、生产=`/`），深链/刷新依赖此对齐；路由层回归测试 `__tests__/App-basename.test.tsx`。
- **F6 铁律**：WU 状态/证据展示一律过 `deriveDisplayState()`（`@dommaker/studio-shared`）。
- **UI 件**：原生 `<select>` 弃用用 `ui/Select`；`Button`+`ConfirmDialog` 替代 `window.confirm`/`alert`。站内跳转用 `useNavigate`。
- **PMO 驾驶舱**：ProjectDetailPage = 头部 -> 进度管道（六泳道）-> 交付台账 -> 项目进展 -> 项目动态。
- **频道翻页游标（#319，2026-08-24）**：`useChannelMessages.loadMore` 的 `before` = 最老消息 **id**（原 createdAt 时间戳，同毫秒多条会漏/重）；后端锚点 id 不存在时返回空页 + hasMore=false，loadMore 据此自然停止
- **通知中心**（B2-003/B2-004；2026-08-28 三票修复）：列表与已读动作住 `stores/notificationStore`（读态跨组件共享前提——NotificationBell 只是视图）。**打开频道即读**：ChannelDetailPage 进页 `markChannelRead(id)`，只清 channelId 匹配（link 解析）的未读，其他频道/类型不动。**点击直达消息**：频道分支跳转带 `?highlight=<messageId>`，页面消费一次后交既有 highlightId 机制滚动定位+高亮 2s（目标在折叠线程先展开；掉出首页分页的老消息静默不定位——已知留白）；跳转优先级 WU > PMO > 频道不变（§5.7），后端通知 link 无消息粒度故仅 SSE 条目可直达。**标题闪烁定时器**与读态挂钩：startFlash 开新必清旧（曾闭包单变量被覆盖导致 interval 永久泄漏闪烁），未读归零/卸载即停（曾纯 10s 定时、全部已读后照闪）。
