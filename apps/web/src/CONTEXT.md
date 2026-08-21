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
- **视觉体系**：`theme.css` 深色变量 + `mission-control.css` 三栏布局（mc-*）与工具类（u-*）。禁止写死浅色 Tailwind 类。规范：`docs/specs/ui/style-guide.md`。
- **频道工作区** = 左 ChannelRail / 中对话流 / 右 WorkUnitDrawer。消息分侧：人类右气泡、agent 左文档流、系统居中。
- **WU 详情页**（`/workunits/:id`）= 跳转枢纽：Header -> 归属条 -> 证据台账 -> ExecutionSteps -> TranscriptViewer -> DiscussionPanel。
- **F6 铁律**：WU 状态/证据展示一律过 `deriveDisplayState()`（`@dommaker/studio-shared`）。
- **UI 件**：原生 `<select>` 弃用用 `ui/Select`；`Button`+`ConfirmDialog` 替代 `window.confirm`/`alert`。站内跳转用 `useNavigate`。
- **PMO 驾驶舱**：ProjectDetailPage = 头部 -> 进度管道（六泳道）-> 交付台账 -> 项目进展 -> 项目动态。
