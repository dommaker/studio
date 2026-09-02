# 频道虚拟化向上滚动漂移：成因链确认与修复方案评估

- 来源票：dommaker/studio#438（属 #419 走查 B12 前半）
- 日期：2026-09-02
- 性质：方案评估（analysis 票）。只产出结论与建议，不含实现改动；实施与否与票拆分由 maintainer 过目后定
- 证据基线：`apps/web` 源码 + `docs/adr/2026-08-24-channel-stream-virtualization.md` + `@tanstack/virtual-core@3.17.8` 库源码逐行复核（`dist/esm/index.js`）

---

## 1. 成因链确认（逐环节证据）

**结论：漂移 = 估计坐标系固有偏差 × 校正权独占下无补偿，逐环节均有代码级证据，非推测。**

1. **估计坐标系**：所有未测量行按固定估计高 `ESTIMATED_ROW_PX = 120` 占位（`useStreamFollow.ts:21-22,85`），各行 `start` 偏移与 `totalSize` 由该估计累计（库 `getMeasurements`）。行真实高 60~300（源码注释口径），单行估计偏差典型 ±60、极端 ±180。
2. **向上滚动扩窗**：窗口上沿随滚动上移，overscan（8 行）内的上方新行进 DOM。
3. **测量落地改写坐标系**：库经 ResizeObserver/`measureElement` 测得真实高，`resizeItem` 更新 `itemSizeCache` 并重算 `getMeasurements` → 该行下方**所有行**的 `start` 位移 Δ = 真实高 − 120（库 `resizeItem`，index.js:836-873）。
4. **校正权独占 = 零补偿**：`virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false`（`useStreamFollow.ts:92-95`）→ `resizeItem` 内 `shouldAdjustScroll` 恒 false → 不做任何 scrollTop 补偿（index.js:876-902）。
5. **视口位移**：行渲染 = spacer(totalSize) + 绝对定位 `translateY(start)`。scrollTop 不变而视口内行的 `start` 变 → 视口内容视觉位移 Δ。连续上滚时每行进窗首测一次、位移一次，方向随机（真实高围绕 120 两侧分布）→ 「边滚边修正」的随机游走式抖动。

**旁证（上游立场）**：库 3.17.8 的默认校正行为（`resizeItem` 内 `defaultShouldAdjust`，index.js:862-875）把「首测（估计→实测）且行 top 在视口上方」列为**必须补偿**场景，注释原文 "the estimate→actual delta must be corrected regardless of scroll direction"。即上游视本场景为应校正行为；项目经 ADR D4-2 选择让渡校正权换 prepend 补偿的独占与确定性——漂移是该取舍的已知代价，与票面定性一致。

## 2. 关键事实：库 3.17.8 的默认校正已演进

ADR D4-2（2026-08-24）在两选项间抉择：全关自动校正（采用）vs `anchorTo:'end'`（否决）。复核库源码发现 3.17.8 还存在**第三条路**——`shouldAdjustScrollPositionOnItemSizeChange` 不设置（undefined）时的库默认谓词 `defaultShouldAdjust`：

| 测量情形 | 库默认是否补偿 scrollTop |
|---------|------------------------|
| 首测（估计→实测），行 top 在视口上方 | **补偿**（无方向限制）——正是本票场景 |
| 重测（尺寸再变，如图片/卡片撑高） | 仅当整行在视口上方**且**非向上滚动中（`scrollDirection !== 'backward'`，防级联抖动，#1218） |
| 行 top 在视口内/下方 | 不补偿 |
| smooth 滚动中 | 不补偿 |
| iOS WebKit 滚动中 |  deferred 累计，触摸结束 flush（`_iosDeferredAdjustment`） |

且所有补偿写入统一走 `_scrollToOffset → options.scrollToFn`（index.js:1110-1116, 1130-1153）——项目的自定义 `scrollToFn` 把 `offset + adjustments` 经 `scrollStreamTo` 过 observed-top 台账（`useStreamFollow.ts:78-80`），**D4-5 台账纪律天然满足，库校正不会被误判为读者滚动**。

ADR 当时未评估此默认路径（评估对象是 `anchorTo:'end'` 备选）。本评估不视其为推翻 ADR——D4-2 的核心决策（prepend 补偿自家独占）不变，此处是校正权让渡范围的重新标定。

## 3. 方案对比

### 方案 A：分型静态估计（调高测量精度）

- **内容**：`estimateSize(index)` 从常量改为按 `items[index]` 类型给值（系统行 / 人类气泡 / agent 文档流 / 折叠过程组 / thread），先采样真实行高分布再定各档值。
- **改动面**：`useStreamFollow` 一处 + 采样统计。不动校正机制，对既有保证（prepend 漂移 0px、恢复两段式、钉底跟随）零机制风险。
- **效果**：降低 |Δ| 均值（估计分布拟合真实分布），漂移幅度按比例缩减，**不消除**——只要估计 ≠ 实测，首测位移就存在。
- **代价**：小（1 量级工作日含采样）。收益：漂移主观强度估计减半，取决于行高分布的类内方差。

### 方案 B：动态估计（随已测量行更新估计值）——排除

- **不可独立成立，两条硬证据**：
  1. 库 `getMeasurements` 的 memo 依赖是 `(count, paddingStart, scrollMargin, getItemKey, enabled, lanes, gap)` + `itemSizeCacheVersion`，**estimateSize 不在依赖中**；且每次 `resizeItem` 都递增 version 触发重算、重算会重读 estimateSize。意味着动态估计值一旦变化，会在**每次任意行测量落地时**重建全部未测量区 start → 视口内行 start 随之变化（环节 5 同一机制）→ **估计更新本身成为新的漂移源**，且发生在校正权独占下无补偿。
  2. 库无增量重估 API；唯一手动触发 `measure()` 会清空整个 `itemSizeCache`（已测行高全丢，index.js:1117-1122），运行中调用代价不可接受。
- 结论：B 在 virtual-core 3.17.8 上无安全落地路径，排除。其「自校准」收益可由方案 A 的采样统计一次性获得。

### 方案 C：放开库首测校正（锚点补偿策略调整）——推荐

- **内容**：删除 `shouldAdjustScrollPositionOnItemSizeChange = () => false` 覆写（或换为等效自定义谓词），启用库默认的首测补偿：向上滚动时视口上方行首测 Δ 由库实时补偿 scrollTop，视口内容保持稳定。
- **与自家校正逻辑的交互分析**（核心风险面）：
  - **prepend 补偿**：时序上分阶段互补——loadMore 渲染后 layout effect 自家补偿按**估计坐标**归位锚行；prepend 的新行均为首测（更早历史从未渲染、itemSizeCache 无 key），随后 RO 测量落地时库按实测 Δ 逐个补偿残差。两机制目标同一不变式（锚行视口位置不变），理论叠加效果是把 prepend 补偿从估计精度提升到实测精度，**非对冲**。须实测确认无双重校正。
  - **阅读位置恢复两段式**：scrollToIndex reconcile 期间（behavior='auto' 非 smooth）校正可发生，被 reconcile 的动态重算收敛吸收；收敛后 `planFineAdjust` 精校正逻辑不变。恢复偏差 121px 基线可能改善，须实测。
  - **钉底/跟随**：重测分支在非 backward 方向仍补偿视口上方行，钉底语义（末行局部几何）不受影响；ResizeObserver 跟随逻辑不变。
  - **读者滚动判定**：库补偿过 `scrollToFn` → 台账记录（§2），不触发 `isReaderScroll` 误判，不改写钉底状态。
- **改动面**：一行级（删覆写）。真正的成本在**浏览器实测矩阵**（见 §4）。
- **风险**：①行为绑定库默认语义，升级 `@tanstack/react-virtual` 须复核（与既有 `scrollState` 运行时假设同级，CONTEXT 已有先例）；②交互矩阵若实测暴露双重校正/手感问题，退路 = 自定义谓词（复制默认逻辑 + prepend 窗口屏蔽），代码量仍小。

### 方案 D：维持现状

零成本零风险，接受体验受损（有 ADR 背书）。若 C 的实测矩阵不通过，落此项并把实测结论回写本报告与 CONTEXT。

## 4. 推荐意见

**推荐 C（首选）+ A（可选叠加），排除 B，D 为退路。**

- C 是唯一消除（而非缓解）首测漂移的路径，改动极小且机制上强化既有保证（prepend/恢复精度提升）；成本集中在实测验证。
- A 与 C 正交：C 解决位移，A 降低需要补偿的 Δ 量级与滚动条比例失真，可低成本叠加，不阻塞 C。
- 实施票建议拆两张：①C + 实测矩阵；②A（采样统计 + 分型表）。若 C 实测翻车，②仍可独立交付减半收益。

**实施票验收实测矩阵**（#系统 长频道，对齐 2026-08-24 基线口径）：

1. 向上连续滚动穿过未测量区，视口内容无明显跳变（本票 AC）；
2. prepend 补偿漂移保持 0px（回防 ADR 验证结论 1）；
3. 阅读位置恢复偏差 ≤ 121px 基线或改善（两段式不回退）；
4. 钉底跟随 / 回到底部 / 新消息到达行为不变；
5. 快速滚动 + loadMore + 新消息混合时序下无双重校正、无累计位移。

## 5. 范围边界（对齐票面）

- 本报告不含任何实现改动；prototype 若需要，走一次性分支不合并。
- B12 后半（通知点击直达老消息静默不定位）为另一条留白，不在本票。
- 数据层裁剪（#326 已完成）、消息摘要投影（#416 在途）不涉及。
