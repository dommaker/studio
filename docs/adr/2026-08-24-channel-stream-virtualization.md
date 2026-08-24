# 频道消息流虚拟化（2026-08-24）

> 来源：#325 grilling（2026-08-24，维护者当场确认 Q1–Q8 全部推荐案）。
> 状态：**accepted**（待 #325 实施落地）。

## 背景

频道消息随时间无界累积，`deriveStreamView` 输出的 items 全量常驻 DOM（含每条消息
的 MarkdownBody 解析产物），长频道下 DOM 节点数与内存持续增长。痛点 = 滚动/渲染
随消息数退化且单向不可恢复。难点不在 windowing 本身，而在 #289/#290 建立的锚点
机制（行锚点补偿、阅读位置存档、钉底跟随）全部假设全量消息行常驻 DOM。

## 决策

### D1 方案：真 windowing，否决两条替代路

- **否决 `content-visibility: auto`**：只解渲染成本，DOM 节点数与内存仍线性增长
  （痛点只解三分之一）；变高行估值不准致滚动条抖动。
- **否决产品层限载（cap N 条）**：破坏 #289/#290 刚建立的连续滚动 + 阅读位置体系，
  「回到底部」与钉底跟随语义全变。
- content-visibility 可作为 windowing 之上的叠加优化，不作替代。

### D2 库选型：`@tanstack/react-virtual`

headless 核心 + `measureElement` 动态变高测量，chat/反向滚动是其一手场景，React 19
兼容；与现有架构（`streamView` 纯函数 + `useStreamFollow` 状态机）同构——virtualizer
只管窗口计算，锚点/钉底判定仍握在自己手里。否决 react-window（定高假设强，变高需
hack）与自研（重造动态测量/滚动校正轮子）。

### D3 一期范围：仅渲染层

`messages` 数据数组、`loadMore` 分页、`deriveStreamView` 管线语义全部不动，
virtualizer 只决定 items 哪段进 DOM。数据层裁剪（JS 堆内存）另开 #326。

### D4 锚点机制语义重定义（虚拟化模型下）

1. **视口行必渲染不变式**：视口内（含 overscan 缓冲带）的行必然已渲染。
   `captureFirstVisibleAnchor` 捕获首个可见行，永远在窗口内——捕获语义与
   `ScrollAnchor` 形状（`{mid, top}`）零改动。
2. **行锚点补偿保持唯一校正权**：prepend 时锚行是首个可见行、仍在窗口内，DOM 位移
   校正继续成立；virtualizer 的自动滚动调整必须关掉或接管，两个校正源不得并存。
   **前置验证**：实现期先以官方文档 + 最小复现确认 `@tanstack/react-virtual` 对
   prepend + 动态测量的滚动校正行为可关/可接管，结论作为实现约束记录。
3. **阅读位置恢复两段式**：粗定位（`scrollToIndex` 跳到存档锚行，估计高度、落点
   近似）→ 精校正（锚行测量落地后按存档 top 差值 DOM 微调，复用
   `anchorScrollDelta`）。接受一次微小可见跳动；锚行不在已加载消息集时维持现状
   兜底定位底部。
4. **钉底重定义为末行局部几何**：钉底 = 最后一行已渲染且其底部距视口底 ≤ 阈值，
   不再依赖总高度（虚拟化下总高 = 实测 + 估计，随测量落地漂移，全局几何不可靠）；
   `scrollToBottom` 改为 `scrollToIndex(末行, align: end)`。
5. **台账纪律不变**：`scrollStreamTo` 仍是 scrollTop 唯一写入口；virtualizer 引起的
   一切滚动落地（含内部校正、两段定位、末行跟随）必须过台账或在 scroll 事件里
   掩蔽，否则误判为读者滚动改写钉底状态。

## 约束（不变）

- ADR 2026-08-18 D1「过程展示归抽屉」：勿借虚拟化把执行过程渲染引回频道流。

## Consequences

- 新增运行时依赖 `@tanstack/react-virtual`（2026-08-24 grilling 已过人闸确认）。
- 实施前置：D4-2 的外部能力验证未过不得动工（verify_external_capability）。
- 数据层内存增长仍在，由 #326 跟进。
