# src

> 此文件描述 apps/web/src 目录的职责和上下文

## 职责

该目录是 Agent Studio Web 前端应用的主源码目录，负责管理路由、全局状态、API 客户端、UI 组件和样式。它通过 React 应用入口 (App.tsx) 组织页面懒加载，并通过 axios 封装与后端 RESTful API 及 SSE 通信，提供认证、通道、工作单元、监控、需求等模块的交互界面。

## 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `App` | `App.tsx` | 根组件，包含路由定义、主题、全局布局（TopNav、Sidebar）及懒加载页面；频道工作区路由为满高三栏（各栏独立滚动） |
| `api` (axios 实例) | `api/index.ts` | 统一 API 客户端，含 Bearer token 注入和 401 自动刷新 |
| `channelApi` | `api/channel.ts` | 频道、消息、Agent 配置相关 API |
| `monitoringApi` | `api/monitoring.ts` | 监控、飞轮指标、开销 API |
| `requirementApi` | `api/requirements.ts` | 需求（REQ）CRUD 及关联工作单元链 API |
| `workunitApi` | `api/workunit.ts` | 工作单元（WorkUnit）全生命周期 API + token 度量事件查询/解析 + 执行步事件查询/解析（`listExecutionStepEvents`/`parseExecutionStepEvents`，WU 过程可视化） |
| `useWebSocket` / `WebSocketProvider` | `api/websocket.tsx` | SSE 客户端 hook 及 Context Provider（替代原生 WebSocket） |
| `useWorkUnitEvents` | `hooks/useWorkUnitEvents.ts` | workunit.created/status_changed/execution.step（SSE）订阅 hook（防抖合并）；WorkUnitListPage 列表与 WorkUnitDrawer 详情据此实时刷新（execution.step 驱动执行过程近实时更新） |
| `useWorkUnitStreamEvents` | `hooks/useWorkUnitStreamEvents.ts` | workunit.execution.stream（Layer B 步内流式，SSE-only）订阅 hook：按 workUnitId 过滤、内存保留当前步 ≤50 条、新步 step-start 清空；WorkUnitDrawer「执行过程」实时区块消费 |
| `useChannelList` | `hooks/useChannelList.ts` | 频道列表数据 hook（ChannelListPage 与 ChannelRail 共用：列表/未读 SSE/新建） |
| `useDetectedProviders` / `buildProviderOptions` | `hooks/useDetectedProviders.ts` | 运行环境已装 agent CLI 探测（GET /workspaces/runtimes，服务端聚合前 best-effort 重扫本机）；provider 下拉统一数据源（FirstRoleSetupModal / StudioRoleSetupModal / ChannelMemberManager 创建表单），一个都没扫到时回退 4 个内置全量可选 |
| `ChannelRail` | `components/channel/ChannelRail.tsx` | Mission Control 左栏：频道列表（未读 badge、agent 在线数）+ Agent 状态 |
| `WorkUnitDrawer` | `components/channel/WorkUnitDrawer.tsx` | 右抽屉：WorkUnit 详情（证据台账 L1/L2/L3 + 人工确认入口（in_review=审查硬门/done 缺 l3=L3 留痕不阻断）、执行过程（步级时间线 + 步内实时流区块，REST 卡片落位后实时区自动让位）、token 开销与全局开销红线）/ REQ 全链路，只展示真实 API 数据 |
| `AuthModal` | `components/AuthModal.tsx` | 隐身认证模态框（双击手势触发） |

## 依赖关系

上游：依赖同目录下的子模块（`pages/`、`components/`、`stores/`、`hooks/`、`contexts/`、`styles/`）以及外部库（`react`, `react-router-dom`, `react-i18next`, `axios` 等）。
下游：暂无。

## 注意事项

- 路由使用 `React.lazy` 进行代码分割，懒加载页面组件需通过 `Suspense` 包裹。
- API 客户端（`api/index.ts`）的认证 token 直接从 `localStorage` 读取，避免与 `authStore` 的循环依赖。
- 实时通信使用 SSE（EventSource）代替 WebSocket，`api/websocket.tsx` 提供与旧 `useWebSocket` 兼容的接口。
- Design Lab 页面（`pages/design-lab/*`）使用 mock 数据，全屏三栏布局，不嵌入通用导航骨架；作为 A/B 方向参照保留。
- 视觉体系（2026-07 T1b，方向 A「Mission Control」）：`styles/theme.css` 深色 `:root` 变量组 = A 方向 token（近纯黑 #050507、磷光青绿 #2ee6a8、终端黄 #e6c85c、全等宽、12.5px 基准）；`[data-theme="light"]` 浅色机制保留（ThemeContext 不变）。`styles/mission-control.css` 承载三栏布局（mc-*）与语义工具类（u-*）；页面禁止写死浅色 Tailwind 类（bg-white/text-gray-*），一律消费变量或 u-* 类。**样式规范唯一权威来源：`docs/specs/ui/style-guide.md`**（token、组件类、弹框标准结构、禁用规则）。2026-08 增补：`--chart-1…9` 图表分类色（深/浅两套，数据可视化专用）、`--fs-stat` 统计大数字字号、`--info-dim/border`；弹框唯一合法结构 = `.modal-overlay` + `.modal` + `modal-header/body/footer`（style-guide §4.3），禁止自写 `bg-black/NN` 遮罩。
- 频道工作区（`pages/ChannelDetailPage.tsx`）= 左 ChannelRail / 中对话流 / 右 WorkUnitDrawer；REQ 全链路原 Modal 形态（`components/requirement/RequirementChainPanel.tsx`）保留给其他页面使用。
- **WU 详情页（`/workunits/:id`，`pages/WorkUnitDetailPage.tsx`，2026-07 agents-pmo-flow-ux §5.4）**：全站跳转枢纽——Header（类型/状态/标题/时间/failureType）→ 归属条（PMO chip → `/pmo/project/:id`，解析顺序 metadata.pmoProjectId → reqId→requirement.projectId；REQ chip 开 RequirementChainPanel；频道 chip → `/channels/:id`；认领 agent chip 按 instance id 匹配 /monitoring/agents → `/agents/:roleId`，匹配不到显示 id 前 8 位不可点）→ 证据台账 L1/L2/L3（同 WorkUnitDrawer 数据路径：deriveDisplayState/parseAttestations）→ 复用 ExecutionSteps（自带 REST 回放+实时流，页面不接 SSE）→ 复用 DiscussionPanel。`/workunits` 列表行标题已改为详情页链接（行其余区域点击仍为行内展开）。
- 频道消息流滚动约定（2026-07，仿 QQ/微信）：打开/切换频道定位到最新一条；新消息仅当人在底部附近（≤80px）或是自己发送时跟随到底；"加载更早的消息"前插后按 scrollHeight 差值补偿，视口不跳。实现在 `ChannelDetailPage.tsx` 的 streamRef + useLayoutEffect。
- 角色（AgentProfile）创建入口时间线：进 App 时 `App.tsx` 检测（studio 角色 provider=null → StudioRoleSetupModal 补 CLI；**无任何 provider 非空的 active 用户角色** → FirstRoleSetupModal 建首个角色——F2 2026-07-28，原"无用户角色"条件被内置 seed 废掉后改为此口径）；常规入口 = Agent 管理页"创建角色"按钮 → `/setup/roles` 向导（勾选扫描到的 runtime 批量建）；频道内快捷入口 = 成员面板"+ 创建新 Agent"（name + 描述 + CLI 下拉）。所有入口共用 `channelApi.createAgent` → `POST /agent-profiles`（服务端 F1：provider 缺省打戳为扫描到的默认 CLI）。
- `AgentDashboardPage`（侧边栏 Agent 菜单，2026-07-31 agents-pmo-flow-ux §5.2 重构为作战视图）= 角色（profile）中心平铺卡片：`channelApi.listAllAgents()`（全量含 studio/inactive）按 `roleId` 合并 `monitoringApi.getAgentSummary()` 运行时状态；每卡三段式——左=状态 pill（`utils/agentStatus.ts` 的 `deriveAgentStatus`：active 按当前 WU.status 细分执行中/待评审/阻塞）/角色名（→`/agents/:profileId`）/CLI badge，中=当前 WU（类型+标题→`/workunits/:id`+已耗时）· PMO/频道链接 · 最近一条动态（空闲时"等待派活"+最近完成，按 assigneeId=instance.id 查 done/completed），右=运行时长+「强制停止」（确认"转人工处理"，POST /agent-instances/:id/terminate）；展开=最近 10 条动态+静态字段。实时：`useWebSocketContext().onEvent` 订阅 `agent.instance.status_changed`（按 profileId 更新并增量补查 WU 详情）/`workunit.status_changed`/`workunit.execution.step|stream`（按 currentWorkUnitId 反查归属追加动态，内存每 agent ≤10 条），30s 轮询兜底，无手动刷新按钮。`AgentDetailPage`（`/agents/:profileId`，§5.3）= Header（角色/CLI/状态/频道/ID/强制停止）→「正在执行」大卡（当前 WU + PMO/频道链接 + 嵌入 ExecutionSteps 实时执行流；无 WU 空态"当前空闲"）→ 统计行 →「历史任务」（assigneeId=instance.id 最近 20 条，每行 →`/workunits/:id`）。
- 频道 @提及（`components/channel/ChannelInput.tsx`）：候选 = `GET /agent-profiles?status=active&channelId=`（服务端按频道成员过滤）；选中插入纯文本 `@name `（带尾随空格，无结构化 id），发送走 `POST /channels/:id/messages`，mention 解析在服务端 message-routing 完成。成员弹框 `ChannelMemberManager` 的 memberIds 必须经 useEffect 从 props membersJson 同步（channel 异步加载，useState 初始值只跑一次）。
- 下拉选择约定（2026-07-29 起）：原生 `<select>` **弃用**（弹出面板由 OS 绘制、无法适配主题），一律用 `components/ui/Select`（options 数组传入；触发器视觉对齐 `.input`，面板 portal 到 body、fixed 定位、z-index 100，键盘导航 + listbox ARIA，零动画全 token；样式类 `.select-*` 在 theme.css，规范见 style-guide §4.6）。theme.css 的 `color-scheme` 声明保留（滚动条等原生控件仍需按主题渲染）。
- 所有 API 模块返回的响应数据结构需与后端约定一致（如 `{ success, data }` 或 `{ data, total }`）。
- **F6 派生口径铁律（决策 1，2026-07-28 分析文档）**：WU 状态/证据的展示一律过 `@dommaker/studio-shared` 的 `deriveDisplayState()`（列表页徽章/计数/按钮、抽屉详情/REQ 链路节点、RequirementChainPanel；进度统计用 `workFinished` 所有权口径）——禁止各自读 `metadata.attestations` 自行解释。列表页「待人工」pill = 派生过滤（done ∧ ¬l3 + 手写 in_review）；done 缺 l3 显示「确认」按钮（服务端幂等补写 l3）；`SelfReviewBadge`（components/workunit/）标记自评（评审 WU 自身 selfReview / 父 WU 台账 l2.selfReview）。MonitoringPage「证据台账」区块读 `/monitoring/overview` 的 evidence 段。
- **PMO 页（决策 2/4 + PMO-b）**：PMOPage 有「新建 PMO」表单（标题/需求描述/gitRepo/交付策略，projectApi.create）；卡片显示杂务徽章与交付策略。ProjectDetailPage 头部显示 REQ 别名/分支/交付策略，「📦 交付」区块（projectApi.getDelivery/deliver）：台账（WU 完成度 + 三层证据缺口 + missing 清单）、auto-merge 显示交付合并按钮（human-only，409 缺口/冲突内联展示）、branch-only 只显示自行合并说明。
- **PMO 驾驶舱（2026-07-31，§5.5/§5.6/§10）**：ProjectDetailPage 自上而下 = 头部卡（原始需求可折叠块 + 状态 stepper 讨论→进行中→待验收→已交付 + channelId「去频道」）→「🚦 进度管道」（`components/pmo/ProjectPipeline`：总进度条 x/y（workFinished 口径）+ 待认领/执行中/评审中/阻塞/已完成五泳道；数据 = `requirementApi.getChain(reqAlias)`（§10 起条目自带 id/title/status/assigneeId/metadata + type/createdAt/claimedAt/completedAt，原逐 WU `workunitApi.get` N+1 补全已移除）+ `monitoringApi.getAgentSummary()` 名册解析认领人（assigneeId=instance.id → name，点击 →`/agents/:roleId`）；泳道/徽章走 deriveDisplayState 派生列，纯函数在 `components/pmo/pipelineUtils.ts`）→ 知识库（卡片点开 `components/knowledge/DocReaderDrawer` 右抽屉，`knowledgeApi`（`api/knowledge.ts`）listByProject/getDetail，正文渲染 = `components/knowledge/MarkdownBody`（见下条）；空态「暂无文档产出」）→ 交付台账（gaps 每行加「查看 WU ›」→`/workunits/:id`）→ 任务看板/执行历史 →「🕐 项目动态」（`ProjectActivity`，buildProjectTimeline 拼 chain WU 时间戳 + deliveredAt，倒序 ≤20 条）。§10 去重：「📈 项目进展」卡内旧四节点 stepper 已移除（与头部 stepper 重复，进度条/统计卡保留）。PMOPage 卡片徽章（§5.6）：列表加载后对可见项目并行 getChain（WU x/y）+ knowledgeApi.listByProject（📄 计数），allSettled 失败静默、0 值不显示。
- **MarkdownBody 统一渲染（2026-07-31，§10 任务 4b）**：`components/knowledge/MarkdownBody.tsx` = react-markdown + remark-gfm（新依赖；默认不渲染原始 HTML，agent 产出按不可信输入免 DOMPurify），components 映射到 u-* 类/CSS 变量（--bg-tertiary/--border-subtle）适配暗色，不引 typography 插件；`[[wiki 链接]]` 预处理为 /wiki/<title> 站内 router Link（沿用 WikiDocPage 原 renderContent 语义），外链 target=_blank。DocReaderDrawer 与 WikiDocPage 正文统一接入（React.lazy 按需加载，fallback = 原 plain-text pre-wrap 形态；WikiDocPage 旧 renderContent 与无效 prose 类已删）。
- **PMO 发起讨论弹窗（2026-07-29）**：选频道后实时解析「会响应的 Agent」（与 AgentLoop.observe 同口径——channel.members 非空取成员交集；空则回退 profile.channels，空 channels = 全频道可见；数据源 listAllAgents 客户端过滤 active/非 studio），0 人可响应时显示 ⚠ 警示（不阻断发起）；确认后跳转该频道闭环。
- **频道线程内过程消息折叠（2026-07-29）**：ChannelDetailPage 线程回复里连续 ≥3 条「过程消息」聚合为一组默认折叠（`collapseProcessReplies`）；里程碑不折叠 = 人类消息 / 卡片消息 / NEED_INPUT 等待回复 / 最后一条回复（最新状态恒可见）。频道只留里程碑、过程可展开——防止 agent 每步 summary 淹没讨论。
- **通知/消息可点击跳转（2026-07-31，§5.7）**：NotificationBell 从 SSE payload 取 `message.workUnitId` + `message.meta.pmoId`（老消息缺 pmoId → null，防御），每条通知右侧「WU」「PMO」直跳小按钮（stopPropagation + 标记已读 + 收起）；点本体优先级 WU 详情 `/workunits/:id` > PMO 详情 `/pmo/project/:id` > 频道。ChannelMessageItem 的 WU chip（仍开右抽屉）旁加「↗」直跳 `/workunits/:id`；`meta.pmoId` 存在时渲染「PMO ›」chip 直跳 `/pmo/project/:id`。
