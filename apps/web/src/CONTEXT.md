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
| `workunitApi` | `api/workunit.ts` | 工作单元（WorkUnit）全生命周期 API + token 度量事件查询/解析 |
| `useWebSocket` / `WebSocketProvider` | `api/websocket.tsx` | SSE 客户端 hook 及 Context Provider（替代原生 WebSocket） |
| `useChannelList` | `hooks/useChannelList.ts` | 频道列表数据 hook（ChannelListPage 与 ChannelRail 共用：列表/未读 SSE/新建） |
| `ChannelRail` | `components/channel/ChannelRail.tsx` | Mission Control 左栏：频道列表（未读 badge、agent 在线数）+ Agent 状态 |
| `WorkUnitDrawer` | `components/channel/WorkUnitDrawer.tsx` | 右抽屉：WorkUnit 详情（含 token 开销与全局开销红线）/ REQ 全链路，只展示真实 API 数据 |
| `AuthModal` | `components/AuthModal.tsx` | 隐身认证模态框（双击手势触发） |

## 依赖关系

上游：依赖同目录下的子模块（`pages/`、`components/`、`stores/`、`hooks/`、`contexts/`、`styles/`）以及外部库（`react`, `react-router-dom`, `react-i18next`, `axios` 等）。
下游：暂无。

## 注意事项

- 路由使用 `React.lazy` 进行代码分割，懒加载页面组件需通过 `Suspense` 包裹。
- API 客户端（`api/index.ts`）的认证 token 直接从 `localStorage` 读取，避免与 `authStore` 的循环依赖。
- 实时通信使用 SSE（EventSource）代替 WebSocket，`api/websocket.tsx` 提供与旧 `useWebSocket` 兼容的接口。
- Design Lab 页面（`pages/design-lab/*`）使用 mock 数据，全屏三栏布局，不嵌入通用导航骨架；作为 A/B 方向参照保留。
- 视觉体系（2026-07 T1b，方向 A「Mission Control」）：`styles/theme.css` 深色 `:root` 变量组 = A 方向 token（近纯黑 #050507、磷光青绿 #2ee6a8、终端黄 #e6c85c、全等宽、12.5px 基准）；`[data-theme="light"]` 浅色机制保留（ThemeContext 不变）。`styles/mission-control.css` 承载三栏布局（mc-*）与语义工具类（u-*）；页面禁止写死浅色 Tailwind 类（bg-white/text-gray-*），一律消费变量或 u-* 类。
- 频道工作区（`pages/ChannelDetailPage.tsx`）= 左 ChannelRail / 中对话流 / 右 WorkUnitDrawer；REQ 全链路原 Modal 形态（`components/requirement/RequirementChainPanel.tsx`）保留给其他页面使用。
- 所有 API 模块返回的响应数据结构需与后端约定一致（如 `{ success, data }` 或 `{ data, total }`）。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `5b7ec85c`: web): 修复 4 个生产崩溃 + 菜单冗余整合
