# #393 导航与布局骨架 实施计划

> 来源：studio#393，spec `docs/specs/ui/redesign-2026-08.md` §2 + §4.1 + §4.4。前置 #392 已落地。

## AC 对照

1. 左侧菜单仅 4 项（频道/PMO/WorkUnit/Agent）+「更多」，知识库/阅览室/监控/设置/audit-logs 收进「更多」且全部可达
2. 频道列表页及路由删除；`/`、`/channels` 重定向最近访问频道工作区；无历史兜底 rnd → 首频道 → 零频道空态（内联创建表单）
3. 全局 sidebar 256 → 176px，无内容溢出
4. 全站详情页统一左上「← 返回」（14px / 6×12 padding）：有站内历史 `navigate(-1)`，直开/书签回落默认列表页

## 改动清单

### 新增
- `apps/web/src/utils/lastChannel.ts` — 纯函数：localStorage 读写 + `resolveChannelHome(channels, lastId)`（lastId 命中 → rnd → 首频道 → null）
- `apps/web/src/pages/ChannelHomeRedirect.tsx` — `/` 与 `/channels` 的重定向页：复用 `useChannelList`（rosterStore），loading → 加载态；有目标 → `<Navigate replace>`；零频道 → 空态 + `CreateChannelForm`
- `apps/web/src/components/ui/BackButton.tsx` — 统一返回按钮：`window.history.state.idx > 0` → `navigate(-1)`，否则 `navigate(fallback)`（沿用 WorkUnitDetailPage 既有判定逻辑）

### 修改
- `App.tsx` — 删 ChannelListPage 懒加载与两条路由，改挂 ChannelHomeRedirect
- `ChannelDetailPage.tsx` — `useEffect(id)` 写 lastChannel
- `SidebarNew.tsx` — 4 主项 + 「更多」展开组（5 收纳项，含 /audit-logs 现仅 TopNav 可达）；子项激活时「更多」头同步高亮
- `responsive.css` — `.sidebar` 桌面 width 256 → 176
- 四个详情页接入 BackButton 并移到左上：ProjectDetailPage（fallback /pmo）、AgentDetailPage（/agents，替换右侧「返回 /agents」）、WorkUnitDetailPage（/workunits，替换右侧「返回」+ handleBack）、LibraryDocPage（/library，替换既有 ghost 按钮）
- 注释/文档同步：useChannelList、ChannelRail、CreateChannelForm、statusClasses、useRosterStoreSync、rosterStore 头部注释中 ChannelListPage 引用；`apps/web/src/CONTEXT.md`

### 删除
- `pages/ChannelListPage.tsx` + `pages/__tests__/ChannelListPage.test.tsx`

### 不动
- TopNav MoreDropdown（票面只管左侧菜单；它含 PMO 重复项属现状，非本票范围）
- 各列表页「返回首页」链接（'/' 重定向后语义仍通）
- AuthModal `navigate('/channels')`（重定向后仍达频道）

## 测试（RED 先行）

1. `utils/__tests__/lastChannel.test.ts` — resolveChannelHome 五分支 + 存取 roundtrip
2. `components/ui/__tests__/BackButton.test.tsx` — idx>0 → -1；idx=0/缺失 → fallback
3. `components/__tests__/SidebarNew.test.tsx` — 4 主项；更多折叠/展开；子项激活高亮
4. `pages/__tests__/ChannelHomeRedirect.test.tsx` — lastId 命中 / stale → rnd / 无 rnd → 首频道 / 零频道空态
5. 更新 `__tests__/App-basename.test.tsx`（ChannelListPage mock → ChannelHomeRedirect）
6. 更新 `AgentDetailPage.test.tsx` 返回断言

## 验证

`pnpm typecheck` + 上述单测文件 + 收尾 `vitest run --changed origin/master`（在 apps/web）。
