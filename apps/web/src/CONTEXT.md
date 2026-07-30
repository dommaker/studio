# src

> 此文件描述 apps/web/src 目录的职责和上下文

<!-- STALE_SINCE: 2026-07-30 -->
⚠️ 以下文件已变更，本节可能过期: apps/web/src/CONTEXT.md

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
| `useChannelList` | `hooks/useChannelList.ts` | 频道列表数据 hook（ChannelListPage 与 ChannelRail 共用：列表/未读 SSE/新建） |
| `useDetectedProviders` / `buildProviderOptions` | `hooks/useDetectedProviders.ts` | 运行环境已装 agent CLI 探测（GET /workspaces/runtimes，服务端聚合前 best-effort 重扫本机）；provider 下拉统一数据源（FirstRoleSetupModal / StudioRoleSetupModal / ChannelMemberManager 创建表单），一个都没扫到时回退 4 个内置全量可选 |
| `ChannelRail` | `components/channel/ChannelRail.tsx` | Mission Control 左栏：频道列表（未读 badge、agent 在线数）+ Agent 状态 |
| `WorkUnitDrawer` | `components/channel/WorkUnitDrawer.tsx` | 右抽屉：WorkUnit 详情（证据台账 L1/L2/L3 + 人工确认入口（in_review=审查硬门/done 缺 l3=L3 留痕不阻断）、执行过程（思考/工具/skill/用量步级时间线）、token 开销与全局开销红线）/ REQ 全链路，只展示真实 API 数据 |
| `AuthModal` | `components/AuthModal.tsx` | 隐身认证模态框（双击手势触发） |

## 依赖关系

上游：依赖同目录下的子模块（`pages/`、`components/`、`stores/`、`hooks/`、`contexts/`、`styles/`）以及外部库（`react`, `react-router-dom`, `react-i18next`, `axios` 等）。
下游：暂无。

## 注意事项

- 路由使用 `React.lazy` 进行代码分割，懒加载页面组件需通过 `Suspense` 包裹。
- API 客户端（`api/index.ts`）的认证 token 直接从 `localStorage` 读取，避免与 `authStore` 的循环依赖。
- 实时通信使用 SSE（EventSource）代替 WebSocket，`api/websocket.tsx` 提供与旧 `useWebSocket` 兼容的接口。
- Design Lab 页面（`pages/design-lab/*`）使用 mock 数据，全屏三栏布局，不嵌入通用导航骨架；作为 A/B 方向参照保留。
- 视觉体系（2026-07 T1b，方向 A「Mission Control」）：`styles/theme.css` 深色 `:root` 变量组 = A 方向 token（近纯黑 #050507、磷光青绿 #2ee6a8、终端黄 #e6c85c、全等宽、12.5px 基准）；`[data-theme="light"]` 浅色机制保留（ThemeContext 不变）。`styles/mission-control.css` 承载三栏布局（mc-*）与语义工具类（u-*）；页面禁止写死浅色 Tailwind 类（bg-white/text-gray-*），一律消费变量或 u-* 类。**样式规范唯一权威来源：`docs/specs/ui/style-guide.md`**（token、组件类、弹框标准结构、禁用规则）。
- 频道工作区（`pages/ChannelDetailPage.tsx`）= 左 ChannelRail / 中对话流 / 右 WorkUnitDrawer；REQ 全链路原 Modal 形态（`components/requirement/RequirementChainPanel.tsx`）保留给其他页面使用。
- 频道消息流滚动约定（2026-07，仿 QQ/微信）：打开/切换频道定位到最新一条；新消息仅当人在底部附近（≤80px）或是自己发送时跟随到底；"加载更早的消息"前插后按 scrollHeight 差值补偿，视口不跳。实现在 `ChannelDetailPage.tsx` 的 streamRef + useLayoutEffect。
- 角色（AgentProfile）创建入口时间线：进 App 时 `App.tsx` 检测（studio 角色 provider=null → StudioRoleSetupModal 补 CLI；**无任何 provider 非空的 active 用户角色** → FirstRoleSetupModal 建首个角色——F2 2026-07-28，原"无用户角色"条件被内置 seed 废掉后改为此口径）；常规入口 = Agent 管理页"创建角色"按钮 → `/setup/roles` 向导（勾选扫描到的 runtime 批量建）；频道内快捷入口 = 成员面板"+ 创建新 Agent"（name + 描述 + CLI 下拉）。所有入口共用 `channelApi.createAgent` → `POST /agent-profiles`（服务端 F1：provider 缺省打戳为扫描到的默认 CLI）。
- `AgentDashboardPage`（侧边栏 Agent 菜单）= 角色（profile）中心列表：`channelApi.listAllAgents()`（全量含 studio/inactive）按 `roleId` 合并 `monitoringApi.getAgentSummary()` 运行时状态；每行展示名称 / 背后 CLI(provider) / 描述 / profile 状态 / 运行时状态 / lastError。
- 频道 @提及（`components/channel/ChannelInput.tsx`）：候选 = `GET /agent-profiles?status=active&channelId=`（服务端按频道成员过滤）；选中插入纯文本 `@name `（带尾随空格，无结构化 id），发送走 `POST /channels/:id/messages`，mention 解析在服务端 message-routing 完成。成员弹框 `ChannelMemberManager` 的 memberIds 必须经 useEffect 从 props membersJson 同步（channel 异步加载，useState 初始值只跑一次）。
- 下拉选择约定（2026-07-29 起）：原生 `<select>` **弃用**（弹出面板由 OS 绘制、无法适配主题），一律用 `components/ui/Select`（options 数组传入；触发器视觉对齐 `.input`，面板 portal 到 body、fixed 定位、z-index 100，键盘导航 + listbox ARIA，零动画全 token；样式类 `.select-*` 在 theme.css，规范见 style-guide §4.6）。theme.css 的 `color-scheme` 声明保留（滚动条等原生控件仍需按主题渲染）。
- 所有 API 模块返回的响应数据结构需与后端约定一致（如 `{ success, data }` 或 `{ data, total }`）。
- **F6 派生口径铁律（决策 1，2026-07-28 分析文档）**：WU 状态/证据的展示一律过 `@dommaker/studio-shared` 的 `deriveDisplayState()`（列表页徽章/计数/按钮、抽屉详情/REQ 链路节点、RequirementChainPanel；进度统计用 `workFinished` 所有权口径）——禁止各自读 `metadata.attestations` 自行解释。列表页「待人工」pill = 派生过滤（done ∧ ¬l3 + 手写 in_review）；done 缺 l3 显示「确认」按钮（服务端幂等补写 l3）；`SelfReviewBadge`（components/workunit/）标记自评（评审 WU 自身 selfReview / 父 WU 台账 l2.selfReview）。MonitoringPage「证据台账」区块读 `/monitoring/overview` 的 evidence 段。
- **PMO 页（决策 2/4 + PMO-b）**：PMOPage 有「新建 PMO」表单（标题/需求描述/gitRepo/交付策略，projectApi.create）；卡片显示杂务徽章与交付策略。ProjectDetailPage 头部显示 REQ 别名/分支/交付策略，「📦 交付」区块（projectApi.getDelivery/deliver）：台账（WU 完成度 + 三层证据缺口 + missing 清单）、auto-merge 显示交付合并按钮（human-only，409 缺口/冲突内联展示）、branch-only 只显示自行合并说明。
- **PMO 发起讨论弹窗（2026-07-29）**：选频道后实时解析「会响应的 Agent」（与 AgentLoop.observe 同口径——channel.members 非空取成员交集；空则回退 profile.channels，空 channels = 全频道可见；数据源 listAllAgents 客户端过滤 active/非 studio），0 人可响应时显示 ⚠ 警示（不阻断发起）；确认后跳转该频道闭环。
- **频道线程内过程消息折叠（2026-07-29）**：ChannelDetailPage 线程回复里连续 ≥3 条「过程消息」聚合为一组默认折叠（`collapseProcessReplies`）；里程碑不折叠 = 人类消息 / 卡片消息 / NEED_INPUT 等待回复 / 最后一条回复（最新状态恒可见）。频道只留里程碑、过程可展开——防止 agent 每步 summary 淹没讨论。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `280a7329`: PMO 走查修复 — agent 执行可靠性 + 多实例单活 + 链路优化
- ✅ 2026-07-29: StudioRoleSetupModal 按 style-guide §4.3 规范重写 — 旧版全量内联硬编码浅色样式（white 底、#2563eb 按钮、#666/#999 文字，规范 §6 反例同类）改为 modal-* 结构 + `.btn btn-secondary/primary` + `u-text/u-text-2` + Select 组件，与 FirstRoleSetupModal 同构；行为与 data-testid 零变更
- ✅ 2026-07-29: 自定义主题感知 Select 替换全部原生 select（18 处 / 11 文件）— 新增 `components/ui/Select.tsx`（触发器 `.select-trigger` 视觉对齐 `.input`；选项面板 portal 到 `document.body`、fixed 定位、宽对齐触发器、max-height 240px、z-index 100；Enter/Space/↑↓/Escape 键盘导航 + listbox/option ARIA；点外部/滚动/resize 关闭；零动画全 token）；theme.css 增 `.select-*` 组件类并删除 2026-07-27 的 `select option` 死规则（全仓已无原生 select，`color-scheme` 保留）；style-guide §4.6 新增组件条目、§4.2 改为 input/textarea 通用；相关测试改为「点触发器 → 点选项」交互
- ✅ 2026-07-28: llm-configs 子系统下线（web 侧）— Settings 页「🧠 LLM 配置」卡片（LLMConfigSection + LLM_SCOPES/LLM_PROVIDERS/MaskedLLMConfig）、未挂载的 LlmConfigDisplay 组件及其测试、api/index.ts 的 llmConfigApi 一并删除；后端 /api/v1/settings/llm 路由与同日子系统移除，模型选择归角色绑定 CLI 的自身配置
- ✅ `66c2bd93`: web): ChannelMemberManager 异步数据同步 + 创建提交态 + select 深色适配
- ✅ 2026-07-27: ChannelMemberManager 成员列表刷新丢失修复 — memberIds 曾只用 useState 初始值消费 membersJson（channel 异步到达后不同步，刷新/切频道即显示空），改为 useEffect 同步；创建表单加提交态（创建中…/禁用）与行内错误，按钮文案「创建并加入频道」；全局原生 select 白面板修复 — theme.css `:root`/`[data-theme=light]` 加 color-scheme + option 变量样式（全项目 19 处 select 共性）
- ✅ 2026-07 频道角色修复：频道打开自动定位最新消息（此前停在顶部）；provider 下拉从硬编码 4 项改为运行环境扫描（useDetectedProviders）；频道成员面板创建 Agent 补 CLI/描述；AgentDashboardPage 从 runtime 实例列表改为 profile 中心（名称/CLI/描述/状态），页头加"创建角色"入口
- ✅ `5b7ec85c`: web): 修复 4 个生产崩溃 + 菜单冗余整合
