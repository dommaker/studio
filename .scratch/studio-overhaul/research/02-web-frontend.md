# 02 · Web 前端调研报告（apps/web/src）

> 调研范围：`/root/projects/studio/apps/web/src`（React 19 + TS + Vite + Tailwind 4 + Zustand + react-i18next，约 131 个源文件 / 3.3 万行含测试）。
> 后端 apps/api、packages/* 不在本报告范围。所有结论引用 `文件:行号`。

---

## 1. 组织现状

### 1.1 页面清单（pages/，21 个页面文件 + design-lab/ 4 个）

路由集中在 `App.tsx:193-222`（全部 lazy 加载）。`/auth/callback`、`/forgot-password`、`/reset-password`、`/design-lab/*` 四条路径绕过 guest 墙且不走 `<Routes>`（`App.tsx:94-137`）。未注册任何 404 兜底路由——未匹配路径会渲染空白骨架页。

| 路由 | 文件（行数） | 一句话用途 |
|---|---|---|
| `/` | `pages/ChannelListPage.tsx` (160) | 首页=频道列表+Agent 状态栏，加载后自动重定向到 #研发 频道（`ChannelListPage.tsx:27-33`） |
| `/channels` | 同上 | 同上组件 |
| `/channels/:id` | `pages/ChannelDetailPage.tsx` (458) | Mission Control 三栏：频道栏/对话流/WorkUnit 抽屉，SSE 实时消息 |
| `/pmo` | `pages/PMOPage.tsx` (929) | 项目组合 + OKR 管理（两个 tab + 三个弹窗） |
| `/project/:projectId`、`/pmo/project/:projectId` | `pages/ProjectDetailPage.tsx` (558) | 项目详情：进度管道、知识库、交付台账、项目动态 + IDE 指南弹窗 |
| `/knowledge` | `pages/KnowledgePage.tsx` (519) | 知识库浏览：统一视图 + 6 类 gap tab + 全局搜索 + 手动维护触发 |
| `/knowledge/import` | `pages/KnowledgeImportPage.tsx` (412) | 冷启动导入 4 步向导（选项目→扫描→选内容→结果） |
| `/wiki`、`/wiki/:id` | `pages/WikiPage.tsx` (239) / `pages/WikiDocPage.tsx` (320) | RequirementsDoc 档案馆（列表/图谱切换）与 Markdown 文档详情（内链/反向链接/编辑） |
| `/workunits`、`/workunits/:id` | `pages/WorkUnitListPage.tsx` (374) / `pages/WorkUnitDetailPage.tsx` (274) | WU 看板列表与详情枢纽（归属条四向回跳、证据台账、执行流、讨论区） |
| `/agents`、`/agents/:profileId` | `pages/AgentDashboardPage.tsx` (280) / `pages/AgentDetailPage.tsx` (260) | 角色作战视图（状态/当前任务/动态/强制停止）与单角色详情 |
| `/monitoring` | `pages/MonitoringPage.tsx` (301) | 系统监控（统计/飞轮/开销/证据指标） |
| `/audit-logs` | `pages/AuditLogsPage.tsx` (456) | 审计日志查询/筛选/导出 |
| `/settings` | `pages/Settings.tsx` (482) | 角色执行参数、算力接入、三方通知 webhook、上下文监控、公司、语言/主题 |
| `/skills` | `pages/ToolsStdPage.tsx` (154) | 技能（skills）管理——**无任何导航入口**（Sidebar/MoreDropdown 均未列出，见 §5） |
| `/workspaces/:id` | `pages/WorkspacePage.tsx` (175) | Workspace runtime 清单 + 创建角色 |
| `/setup/roles` | `pages/RolesSetup.tsx` (181) | 角色初始化向导（扫描 CLI→勾选批量建角色） |
| `/goals` | — | 重定向到 `/workunits`（`App.tsx:203`） |
| `/design-lab`、`/design-lab/a`、`/design-lab/b` | `pages/design-lab/*` (504+250+728css) | T1 视觉方向稿原型，全 mock 数据，所有按钮均无真实效果（有意为之） |

### 1.2 components/ 分类与规模（61 个 tsx，另有 ui/ 4 个）

- **根目录平铺 40 个**：通用组件（TopNav/SidebarNew/NotificationBell/toast 配套）与历史遗留组件混杂，无再分层。
- `channel/`（13 个）：频道域组件——ChannelRail、ChannelMessageItem、ChannelInput、WorkUnitDrawer(353)、ChannelMemberManager、RequirementsDocCard(303)、ConvertToTaskDialog、KnowledgeProposalCard/KnowledgeConfirmCard/AuditorSuggestionCard、AuthorAvatar。
- `pmo/`（4 个）：DeliveryPanel(246)、ProjectPipeline、ProjectActivity、pipelineUtils（纯函数）。
- `workunit/`（5 个）：ExecutionSteps、EvidenceLedger、TreeTokenDrawer、ReviewHint、SelfReviewBadge。
- `knowledge/`（2 个）：MarkdownBody、DocReaderDrawer。
- `requirement/`（1 个）：RequirementChainPanel。`setup/`（2 个）：两个角色引导弹窗。
- `ui/`（3 个组件 + barrel）：Modal(61)、Select(199)、ManualTaskButton(56)——**设计系统组件层极薄**，大量页面仍手写 `modal-overlay`/`btn` 原始结构。
- 根目录存在一批无引用死组件，见 §5。

### 1.3 stores / hooks / api 层

- **状态管理 = Zustand**，5 个 store：
  - `stores/authStore.ts` (240)：唯一大 store，token/user/guest 会话 + `persist` 中间件落 localStorage（key=`auth-storage`）。注意 `isAuthenticated()/isGuest()` 是闭包函数而非 selector 值，`App.tsx:57-58` 以 `useAuthStore((s) => s.isGuest())` 调用——只有 user 字段变化才触发重渲染（恰好够用，但模式脆弱）。
  - `agentStore`(20)、`runtimeStore`(91)、`uiStore`(11)、`workunitStore`(82)。`stores/index.ts:11-36` 的 `useAppStore` 组合导出**零调用方**。
  - 大量页面状态根本不进 store，用本地 useState + 手拉数据（PMOPage/KnowledgePage/Settings 等），stores 只覆盖 auth/agent/runtime/workunit 四域。
- **hooks/（8 个）**：数据 hook（useChannelList、useChannelEvents、useAgentRoster(262)、useCompanyId、useDetectedProviders、useCapabilities）+ SSE 订阅 hook（useWorkUnitEvents、useWorkUnitStreamEvents）。约定：页面不直接订阅 SSE，经 `api/websocket.tsx` 的 `WebSocketProvider`（实为 SSE 客户端，名字误导，`api/websocket.tsx:1`）+ `onEvent` 注册（`useChannelList.ts:38-51`）。
- **api/ 层约定**（`src/CONTEXT.md:44` 明确写为 API seam）：axios 单实例在 `api/index.ts:6-10`（baseURL=`/api/v1`，Bearer 注入 + 401 刷新重排队列，`api/index.ts:35-130`），各域一个模块（channel/company/harness/knowledge/maintenance/monitoring/notify/pmo/requirements/workunit）。`api/index.ts` 本身仍混装 agentApi/runtimeWorkflowApi/superpowersApi/authApi/projectApi/wikiApi/workspaceApi 七个命名空间（346 行）。**但 seam 有漏**——5 个调用点绕过 axios 直接 fetch，见 §3.2。
- 轮询与 SSE 并存：`useChannelEvents.ts:62`（10s 轮询兜底）、`useAgentRoster.ts:161`（30s）、`ChannelRail.tsx:46`（30s）、`RequirementsDocCard.tsx:149`（5s）。

---

## 2. 大文件剖析（拆分缝）

### 2.1 `pages/PMOPage.tsx`（929 行）

内部职责清单：
1. **OKR/KR 领域逻辑**：`getCurrentQuarter`(`:15`)、`parseIdArray`(`:24`)、KR/OKR 三个 interface(`:35-60`)、`METRIC_TYPE_OPTIONS`/`METRIC_META`(`:62-81`)、`validateKRTarget`(`:88-120`)——纯函数+常量，与 UI 无关，约 110 行可直接抽 `pmo/okrUtils.ts`。
2. **列表数据加载**：`loadData`(`:253`)、`loadChannels`(`:283`)、徽章批量统计 effect(`:213-251`，N+1 并行查询 reqChain+knowledge)。
3. **项目 Tab 渲染**：项目卡片列表(`:488-562`)。
4. **OKR Tab 渲染**：OKR 卡片(`:585-632`)。
5. **创建 OKR 弹窗**：状态 6 个(`:154-159`)+KR 增删改(`:161-179`)+提交(`:342-377`)+JSX(`:638-782`，145 行）。
6. **新建 PMO 弹窗**：状态 7 个(`:196-205`)+工程扫描(`:380-397`)+提交(`:400-426`)+JSX(`:785-874`)。
7. **发起讨论弹窗**：状态 5 个(`:186-193`)+响应者解析 effect(`:294-315`)+JSX(`:877-925`)。

拆分缝（天然边界，互不影响）：
- 抽 `pmo/okrMetric.ts`（职责 1，零依赖）。
- 三个弹窗各自独立成 `pmo/CreateOkrDialog.tsx`、`pmo/CreateProjectDialog.tsx`、`pmo/PublishProjectDialog.tsx`——三者状态、提交函数、JSX 完全自包含，仅通过 `onCreated/onPublished` 回调与页面耦合。仅此一项可削掉约 380 行 JSX + 15 个 useState。
- 剩余主体（列表+两个 tab）约 300 行，可再按 tab 拆 `pmo/ProjectListPanel` / `pmo/OkrListPanel`。
- 项目卡片内的徽章行（`:505-529`）与 OKR 卡 KR 行（`:611-629`）可下沉为小组件。

### 2.2 `pages/ProjectDetailPage.tsx`（558 行）

职责：
1. **页面数据装配**：`loadData`(`:109-151`) 串行拉 project→(docs/delivery/chain+agents)，best-effort 容错。
2. **Header 区块**：标题/徽章/别名/需求折叠/状态 stepper(`:246-340`)。
3. **知识库三列卡片**(`:349-393`)——按 type 分三列的纯展示。
4. **项目进展卡**(`:401-462`)——进度条 + 六统计格 + 证据警告条。
5. **VS Code / Cloud IDE 两个指南弹窗**(`:504-554`) + `vscodeSteps`/`cloudIdeSteps` 常量(`:55-67`)。**硬编码生产 IP `root@49.232.195.87`、`http://49.232.195.87:8443`（`:58`、`:64`）**——环境信息泄漏在前端代码里，重构时应配置化。
6. **归档/复制路径交互**(`:153-205`)。

拆分缝：
- 两个 IDE 指南弹窗 + steps 常量 + copyStep → 一个 `pmo/IdeGuideDialogs.tsx`（约 90 行纯展示）。
- 知识库三列 → `KnowledgeDocGrid`（列定义可数据驱动，消掉三段重复 JSX）。
- 进展卡（进度条+六格+警告条）→ `pmo/ProjectProgressCard.tsx`。
- `loadData` 的四路 best-effort 加载可收进 `useProjectDetail(projectId)` hook。

### 2.3 `pages/KnowledgePage.tsx`（519 行）

职责：
1. **统一视图 tab**：状态 7 个(`:44-51`)+加载(`:74-86`)+手动新建表单(`:94-104`、`:261-290`)+列表渲染(`:243-333`)。
2. **全局搜索**：状态+`handleGlobalSearch`(`:107-115`)+结果 overlay(`:202-226`)。
3. **6 个 gap tab**：`loadGapData`(`:59-71`)+`renderGapItem` 分发(`:125-142`)。
4. **6 个展示卡片组件**：PreferenceCard/BusinessRuleCard/EnvSnapshotCard/DecisionChainCard/InteractionPatternCard/ResolutionCard(`:366-517`)——全部是纯展示、全部 `item: any`。
5. **手动维护三连按钮**(`:154-181`，复用 ManualTaskButton）。

拆分缝：
- 底部 6 个卡片组件共 150 行、彼此零耦合，直接移入 `components/knowledge/gap-cards.tsx`（并趁机补类型替代 `any`）。
- 手动新建条目表单 → `knowledge/ManualEntryForm.tsx`。
- 搜索结果 overlay → 小组件。
- 页面主体即 tab 容器，拆完约剩 200 行。

### 2.4 `pages/design-lab/PrototypeShell.tsx`（504 行）

职责：A/B 两方向共用的三栏原型壳。
1. **消息领域逻辑**：`groupIntoThreads`(`:29-44`，与 `ChannelDetailPage.tsx:34-54` 逐行重复）、`STATUS_META`/`StatusBadge`(`:50-72`)。
2. **中栏对话流**：`renderMessage`(`:152-236`，按 cardType 分 text/progress/need_input/approval 四支）、`renderStream`(`:238-288`，日期分隔+线程折叠）。
3. **左栏频道/Agent 列表**(`:297-328`)。
4. **右抽屉**：`WuDetail`(`:396-469`，checkpoints/知识命中/token 条）、`ReqChain`(`:471-503`)。
5. mock 交互状态（needDrafts/approvals 等 6 个 useState，`:75-81`）。

拆分缝：renderMessage 的四个 cardType 分支、WuDetail、ReqChain 都是独立纯组件；`groupIntoThreads` 应与 ChannelDetailPage 单源化。**注意此文件是视觉原型（全 mock），价值在于定稿后反哺 ChannelDetailPage 重构，本身不值得精雕细琢。**

### 2.5 `pages/Settings.tsx`（482 行）

职责（8 个 section 竖排）：
1. 角色执行配置（并发/阈值/显示 token，`:243-275`）。
2. 算力接入（WorkspaceStatusBar + JoinComputeDialog + TokenManager，`:278-301`）。
3. 通知配置×3（Discord/企微/Telegram，`:324-372`，三段近乎复制的 JSX）+ 同步状态提示(`:303-322`)。
4. 上下文监控（`:374-399`）。
5. 公司信息（`:401-434`）——**公司名称输入框每次击键直接调 `companyApi.update`（`:410-418`），无防抖无保存按钮，失败仅 toast**。
6. 知识库入口（`:436-452`）——用 `window.location.href` 跳页（见 §3.1）。
7. 语言/主题（`LanguageSettings`/`ThemeSettings`，`:25-72`，已抽为文件内组件）。
8. **加载/保存链路**(`:90-219`)：secrets 存 localStorage(`agent-studio-secrets`) + 服务端进程内存 + Redis 三处写（`handleSave:183-219`），服务端重启即丢 → `needs-resave` 状态要求用户手动重存（`:108-130`）——这是产品级卡点，不只是代码问题。

拆分缝：三个通知 section 合并为一个数据驱动的 `NotifyChannelSection`；公司信息、算力接入各成一组件；`loadConfig`/`fetchOrCreateCompany` 抽 `useSettingsConfig()` hook。

### 2.6 `components/KnowledgeGraphView.tsx`（488 行）

职责：
1. **类型定义**（KnowledgeNode/Edge/Graph/Layer，`:19-67`）。
2. **自定义节点组件** `CustomKnowledgeNode`(`:96-168`，含 diff/选中/高亮三套着色逻辑）。
3. **布局算法** `applySimpleLayout`(`:177-278`)——手写拓扑分层布局，注释自称「简化的 dagre」，100 行纯算法，可独立成 `graph/layout.ts`（或直接用 dagre/elk 依赖替换）。
4. **ReactFlow 装配** `KnowledgeGraphViewInner`(`:283-403`)——含 JSON.stringify 深比较同步节点的反模式（`:335-346`，每次渲染两次全量序列化）。
5. **工具函数** `buildKnowledgeGraphFromAnalysis`(`:430`)、`analyzeDiffImpact`(`:445-488`)。

唯一消费方是 `pages/WikiPage.tsx:176`（图谱视图），且 `diffMode`/`analyzeDiffImpact` 相关 props 在 WikiPage 未使用——diff 影响分析能力疑似为未落地功能预留。拆分缝：types/layout/diff 三段都可纯函数化抽出，组件本体只剩 ReactFlow 装配。

---

## 3. 交互断点与卡点候选

### 3.1 原生 alert/confirm 与整页刷新跳转（体验断裂）

- `pages/ChannelListPage.tsx:55` — 创建频道失败用 `alert(err?.response?.data?.error || ...)`。操作路径：首页 → +新频道 → 输入名称 → 创建。同时该表单**无 loading 态**（`handleCreate:45-57` 无 creating state，`:97` 创建按钮无 disabled），连点可重复提交。
- `pages/AgentDashboardPage.tsx:21` 与 `pages/AgentDetailPage.tsx:93` — 强制停止用 `window.confirm('强制停止会将当前任务转人工处理，确认？')`，且确认后 `terminate` 失败无 try/catch（`AgentDashboardPage.tsx:20-23`），失败静默。项目已有 DeleteConfirmModal/Modal 组件可替。
- `pages/Settings.tsx:444,446` — 「查看知识库」「冷启动导入」用 `window.location.href` 整页刷新跳转（同 SPA 内应 `navigate`）。
- `components/AuthModal.tsx:24` — 登录成功 `window.location.href='/channels'` 整页刷新。
- `components/PmoNumberBadge.tsx:61` — `PmoNumberLink` 点击跳 `window.location.href = `/projects/${projectId}``：**路由表中不存在 `/projects/:id`**（App.tsx 只有 `/project/:projectId` 与 `/pmo/project/:projectId`），点中即空白页。该组件当前无引用（死代码），但修复路由表时需一并清理。

### 3.2 绕过 api/ adapter 层的直接 fetch（违反 `src/CONTEXT.md:44` 的 API seam 约定）

- `pages/AuditLogsPage.tsx:77-78,101,117` — 4 处裸 `fetch(`${apiBase}/audit-logs...`)`，**不带 Authorization header**（axios 拦截器注入的 Bearer 这里全丢），也无 401 刷新；`:132` 导出用 `window.open` 同理。
- `pages/ToolsStdPage.tsx:42` — `fetch(`${getApiBase()}/skills`)` 裸 fetch 无鉴权头。
- `components/CreateToolStdModal.tsx:63,92` — `fetch('/api/v1/skills/generate'、'/api/v1/skills/save')` 硬编码 baseURL、无鉴权头。
- `components/DeleteButton.tsx:75` — 手动拼 auth header 的裸 fetch DELETE（`:75-81`）；`handleConfirmDelete` 的 catch 里 `throw new Error(...)`（`:103`）向上抛但调用栈是 onConfirm 回调，存在未处理 rejection 风险。
- `components/IronLawsSection.tsx:48` — `fetch('/api/v1/iron-laws')`（组件本身无引用，死代码）。
- 旁证：`utils/api.ts`（apiFetch/apiGet/apiPost）也是 seam 外通道，ToolsStdPage/AuditLogsPage 经 `getApiBase()` 使用它。

### 3.3 异步后状态不刷新 / 静默失败

- `pages/PMOPage.tsx:277` — `loadData` 失败仅 `console.error`，页面停留空列表无任何错误 UI。
- `pages/KnowledgePage.tsx:103` — 手动新建知识条目失败仅 `console.error`，无 toast、表单不清空，用户无法分辨是否保存成功。
- `pages/PMOPage.tsx:213-251` — WU/文档徽章批量查询 `Promise.allSettled` + 失败静默，徽章可能永久缺失且无重试入口。
- `pages/ChannelDetailPage.tsx:123,131` — 挂起 WU 与 REQ 列表以 `messages.length` 为依赖重拉，但 `workunitApi.list` 结果经 `setWaitingWuIds` 后，**NEED_INPUT 卡片回复成功后没有主动 invalidate**，要等下一条 SSE 消息改变 length 才刷新。
- 多处 `.catch(() => {})` 完全吞错：`App.tsx:90`、`ChannelListPage.tsx:40`、`ChannelDetailPage.tsx:107,122,130`、`WorkUnitDetailPage.tsx:107,117`。

### 3.4 表单无校验 / 无错误反馈 / 无 loading

- `pages/ChannelListPage.tsx:45-57` — 新频道表单：仅 `newName.trim()` 非空判断，失败 alert，无提交中状态（上述 3.1）。
- `pages/Settings.tsx:410-418` — 公司名称逐击键自动保存（无防抖、无乐观锁），与底部「保存设置」按钮并存，心智模型冲突（有的字段即时生效、有的要按保存）。
- `pages/PMOPage.tsx:649-666` — OKR 弹窗的季度/标题是普通 input，季度格式（`2026-Q3`）无校验，填错直接 500。
- `pages/KnowledgePage.tsx:285-288` — 新建条目仅 title/content 非空 disabled，保存无 loading 态。
- 对比正面例子：PMOPage 新建 PMO(`:868-870`)、发起讨论(`:915-921`) 有 creating/publishing loading + toast 错误——说明规范存在但不统一。

### 3.5 多步繁琐链路

- **通知配置链路**（Settings）：填 webhook → 保存（写 localStorage+进程内存+Redis 三处）→ 服务端重启后配置丢失 → 页面提示「需要重新保存」(`Settings.tsx:304-314`) → 用户再点一次保存。根因在服务端不持久化，但前端可将「检测丢失→一键重同步」做成单按钮。
- **发起需求讨论链路**（PMO）：`/pmo` 列表 → 发起讨论按钮（仅 `status==='pending'` 显示，`PMOPage.tsx:548-557`）→ 弹窗选频道（无频道时按钮 disabled 但无引导去建频道，`:551-553`）→ 确认 → 跳频道页。整体可达，但「频道无响应 Agent」只有警告文字（`:903-907`），仍允许提交，需求可能石沉大海。
- **知识冷启动导入**（KnowledgeImportPage 4 步向导）本身是重流程，入口分散：KnowledgePage 头部按钮(`:182`)、Settings 知识库卡(`:446`)，两处样式/文案不一致。

### 3.6 死按钮 / 假交互

- `pages/design-lab/*` 全部按钮均为 mock（有意，`:198`、`:369` 等已注明），但若设计稿转正需注意清一色补链路。
- `components/PmoNumberBadge.tsx:61` — PmoNumberLink 跳死路由（见 3.1）。
- 未发现已上线页面中存在完全无 onClick 的装饰性按钮（grep 验证）。

---

## 4. 样式与 i18n

### 4.1 样式方案（四层混用）

1. **Tailwind 4 工具类**（`index.css:1` `@import "tailwindcss"`）——布局类大量使用。
2. **CSS 变量主题**：`styles/theme.css`（1507 行，78 个 `--*` 变量 + `.btn/.card/.modal/.input/.tag/.page-title` 等组件类），入口在 `App.tsx:50`；theme.css 再 `@import` animations/responsive/mission-control（`theme.css:1-3`），即**全站 CSS 实际是一整包**。
3. **mission-control.css**（724 行，146 个 `mc-*` 类 + 29 个 `u-*` 工具类）——注意 `u-*` 工具类（u-text/u-accent/u-surface/u-ok…）定义在这里（`mission-control.css:689+`）而非 theme.css，但消费方遍布所有页面（不只是频道页），命名/归属错位。
4. **行内 style**：大量组件混写 `style={{ background: 'var(--bg-primary)' }}` 等（SidebarNew/TopNav/MoreDropdown/PMOPage/Settings 比比皆是），与 class 方案无统一取舍标准；`components/setup/*.tsx:8` 注释明文「禁止内联写死颜色」说明规范刚立、存量未清。
5. **design-lab.css**（728 行 `dl-*`）——原型专用，独立。
6. **重复/冲突定义**：
   - `styles/responsive.css` 在媒体查询里**覆写 Tailwind 同名工具类**（`.p-8`/`.px-8`/`.py-6`/`.text-xl` 等，`responsive.css:13-35`）——Tailwind 4 与手写覆写共存，特异性冲突高风险，重构时必须清除。
   - responsive.css 还重复定义 `.btn`/`.card`/`.card-glow`/`.nav-header`（与 theme.css 同名）。
   - 多个组件重复 `import '../styles/theme.css'`（SidebarNew:5、TopNav:10、MoreDropdown:5、Settings:13、setup modals、IntentResult:3）——bundler 会去重但反映归属不清。

### 4.2 i18n（形同虚设）

- 基础设施齐：react-i18next + LanguageDetector，`i18n/index.ts`，fallback `zh-CN`。
- **但 locales 只有 19 个 key**（`i18n/locales/zh-CN.json`、`en-US.json` 各 19），全代码库 `t(...)` 调用 171 处——绝大多数形如 `t('nav.channels', '频道')`（`SidebarNew.tsx:18-25`）即**靠 defaultValue 兜底，翻译文件里根本没有这些 key**，切到 en-US 后仍显示中文。
- 只有 6 个文件 import 了 useTranslation（App、Settings、MoreDropdown、SidebarNew、TopNav、AuditLogsPage）；**87 个 tsx 含硬编码中文文案**（页面标题、按钮、toast、placeholder、确认框全部裸写中文，如 `PMOPage.tsx:434`、`ChannelDetailPage.tsx:337`、`AgentDashboardPage.tsx:21`）。
- 结论：i18n 目前是装饰性的；重构要么全量补 key（工作量大），要么明确「单语言中文」并摘除失效的切换入口。

---

## 5. 疑似死代码

### 5.1 确认死组件（生产代码零引用，按引用扫描验证）

根目录 16 个组件无 import 方（`grep` 全 src 验证）：

- **仅测试引用**（留了测试但无生产消费，疑似功能已下线）：`CheckpointTimeline.tsx`、`ConversationActions.tsx`、`ConversationMessageList.tsx`、`DirectoryBrowser.tsx`、`ExecutionTargetSelector.tsx`、`IronLawAlert.tsx`、`TaskCard.tsx`（各自有 `__tests__` 对应测试）。
- **测试与生产均无引用**：`FilePreview.tsx`、`IntentResult.tsx`、`IronLawsSection.tsx`、`IronLawWarningBanner.tsx`、`Onboarding.tsx`、`SpeakingQueuePanel.tsx`（文件头自述「已废弃，meeting 模块已删除」）、`Timeline.tsx`、`DeleteButton.tsx`、`ConversationMessageList` 同类。
- **评审组件死循环簇**：`ReviewPanel.tsx`/`MultiStanceReviewPanel.tsx`/`ReviewOpinionCard.tsx`/`StanceBadge.tsx` 互相引用成环，**无页面入口消费**——整簇不可达。
- **PMO 卡片链**：`PMOCard.tsx` 零引用（api/pmo.ts 的注释提及不算），其唯一引用者关系倒挂——`CompanyHallCard.tsx` 只被 PMOCard 引用 → 两个一起死。
- `components/DeleteConfirmModal.tsx` 只被死组件 DeleteButton 引用 → 连带死（或被其它弹窗复制了结构）。

### 5.2 死 hook / 死 API / 死导出

- `hooks/useCapabilities.ts` + `api/index.ts:191-194` 的 `capabilitiesStageApi`：零消费。
- `hooks/useCompanyId.ts`：零消费（PMOPage 改为直读 `localStorage.getItem('companyId')`，`PMOPage.tsx:355`）。
- `stores/index.ts:11-36` `useAppStore` 兼容导出：零消费。
- `api/index.ts` 注释自述清理史（`:132,183`）：`agentApi` 只剩 list、`superpowersApi` 只剩 listIronLaws——而 listIronLaws 的唯一消费者 IronLawWarningBanner 已是死组件 → `superpowersApi` 实际也死。
- `utils/api.ts`（apiFetch/apiGet/apiPost）：仅存服务于 §3.2 的 seam 外调用，收编后可删。

### 5.3 死路由 / 无入口页面

- `pages/ToolsStdPage.tsx`（`/skills` 路由存在）——SidebarNew(`:17-26`)、MoreDropdown(`:14-21`) 均无入口，只能手输 URL 到达。
- `/setup/roles`：仅从 AgentDashboardPage「创建角色」(`AgentDashboardPage.tsx:45`) 与 WorkUnitListPage(`:304`) 可达，属正常深层入口。
- `components/PmoNumberBadge.tsx:54-72` `PmoNumberLink`：零引用且跳死路由 `/projects/:id`。

### 5.4 历史残迹注释（功能已删、注释残留）

- `stores/runtimeStore.ts:33` — 「Workflows 功能已废弃，返回空数组」：整个 runtimeStore 的 workflow 半边是空壳。
- `ProjectDetailPage.tsx:10-11,207` — 老 Task 看板双轨删除声明。
- `KnowledgePage.tsx:5` — 行为模式 tab 残尸清理声明。
- `App.tsx:1` — 文件头注释「路由重构」，与现状相符但无信息量。

---

## 6. 给重构规划者的要点（TL;DR）

1. **拆分优先级**：PMOPage（3 弹窗独立即削 40%）→ KnowledgePage（6 卡片搬家）→ Settings（section 组件化 + 公司名防抖）→ ProjectDetailPage（IDE 弹窗/知识网格/进展卡）。拆分缝全部已在 §2 标出，均不牵扯状态管理改造。
2. **先补设计系统底座再动页面**：`ui/` 只有 3 个组件；统一 Modal/Form/Button(loading 态）/Toast/Confirm，可一次性消灭 §3.1/3.4 的 alert、confirm、无 loading 三类问题。
3. **API seam 收口**：5 个裸 fetch 调用点（§3.2）收进 axios 实例即同时获得鉴权头 + 401 刷新；`utils/api.ts` 随之删除。
4. **死代码一次清**：§5 约 20 个文件、粗估 2500+ 行（含 ReviewPanel 簇、PMOCard 链、16 个死组件、2 个死 hook、useAppStore、superpowersApi、PmoNumberLink、runtimeStore 空壳半边），删除前先确认 `__tests__` 同步移除。
5. **样式三选一**：`u-*` 工具类归入 theme.css、清除 responsive.css 对 Tailwind 工具类的覆写、行内 style 收敛为 class——否则主题切换永远做不干净。
6. **i18n 二选一**：补全 171 处 t() 的 locale key，或摘除 LanguageSwitcher 承认单语言。现状是最坏中间态。
7. **已知坑**：ProjectDetailPage 硬编码生产 IP（`:58,64`）、Settings secrets 落 localStorage（`:88-103`）、AuditLogsPage 裸 fetch 无鉴权头（`:77-117`）、`/projects/:id` 死路由（PmoNumberBadge:61）。
