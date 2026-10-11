# 频道工作条 ChannelWorkBar：合并 LiveBars + StageBar

> 来源：2026-09-08 会话设计讨论（频道顶部两条任务状态带并存的概念问题）。
> 决策：用户确认走「合并为单一频道工作条」方案（备选「StageBar 条件化」已否决）。

## 问题

频道详情页中栏顶部并存两条任务级状态带：

- `ChannelLiveBars`（#242/#322）：本频道 active WU 的瞬态执行实况（SSE 驱动，终态即消失）
- `ChannelStageBar`（#440 Phase 2/#447）：`currentWuId` 拣选的当前工单生命周期 stepper（fail-closed 为刻意设计）

两条带各自一套数据源、一套显隐语义，用户无法区分口径；多 WU 并发时 StageBar 静默只指认一条，其余 active WU 在阶段维度完全不可见。

## 方案

合并为单一组件 `ChannelWorkBar`：频道顶部只留一条横带，回答「这个频道的工作现在什么状态」。

```
┌────────────────────────────────────────────────────────┐
│ ● WU-09cd [待接单—执行中—待验收—完成]  第 3 步·写代码   │  ← 主区
│                                          +2 进行中 ▾    │  ← 溢出区
└────────────────────────────────────────────────────────┘
```

### 渲染规则（显式状态机）

| currentWu | active WUs | 渲染 |
|-----------|-----------|------|
| 无 | 无 | 不渲染（沿用两条现有的零占位语义） |
| 无 | ≥1 | 仅 live 列表（等价旧 LiveBars，每条点击开抽屉） |
| 有（命中） | 无 | 仅 stepper 主区 |
| 有，自身 active | 仅自身 | stepper + 当前站旁叠加「第 N 步 · 动作」 |
| 有 | 有其他 active | stepper（+自身实况若 active）+「+N 进行中」chip，点击展开小列表，条目点击开抽屉 |
| currentWuId 未命中 channelWus | 任意 | fail-closed：主区不渲染，只显示 live 部分（#447 刻意设计不变） |

### 不动的部分

- `currentWuId` 后端拣选口径（建议端点，#447 单源）
- `useChannelLiveExecutions` hook（订阅与集合维护逻辑不变，仍由组件自持有，保持 #322 的重渲边界）
- `StationStepper` / `buildLifecycle` / `deriveDisplayState` 阶段语义（#440 铁律：不发明第二套阶段模型）
- 点击条目打开 WU 右抽屉的交互

## 改动清单

1. 新建 `apps/web/src/components/channel/ChannelWorkBar.tsx`
   - props: `{ channelId: string | null; currentWu: WorkUnit | null; onOpenWorkUnit: (id: string) => void }`
   - 内部自持有 `useChannelLiveExecutions(channelId)`
   - stepper 组装逻辑搬自 `ChannelStageBar`
2. `apps/web/src/pages/ChannelDetailPage.tsx:805-811`：两处挂载点并为一处 `<ChannelWorkBar channelId={id} currentWu={currentWu} onOpenWorkUnit={openWu} />`
3. 删除 `ChannelLiveBars.tsx` / `ChannelStageBar.tsx`（先确认无其他引用）
4. `apps/web/src/styles/mission-control.css`：`mc-livebars`/`mc-livebar`（~890-906）与 `mc-stagebar`（~625-630）合并为 `mc-workbar` 一组样式
5. 测试（先行，RED → GREEN）：
   - 迁移现有 ChannelDetailPage 测试中阶段条/livebar 用例到新组件断言
   - 新增：多 active WU 时主 stepper + 溢出 chip；chip 展开列表点击开抽屉；fail-closed（currentWuId 未命中）只显示 live 区；无 currentWu 有 active 时仅 live 列表
6. 沉淀：`apps/web/src/components/channel/CONTEXT.md` 更新；SDD `channel-contextual-guidance` 标注呈现层变更（阶段条并入工作条，端点口径不变）

## 验证

- `pnpm test`（受影响测试文件）+ `pnpm typecheck`
- 逐条对照上表 6 行渲染规则
