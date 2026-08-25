# Agent 实例目录生命周期闭环（2026-08-25）

> 来源：架构评审「性能第二轮」候选 B1（#363），grilling 决策树全树经维护者当场确认（Q1-Q6）。
> 2026-08-25 由 issue 正文回填冻结；状态：**active**（随 #363 实施落地）。

## 背景

真实数据区普查：`~/.studio/data/agents` 共 753 个目录 = 7 个存活实例 + 8 个 profile +
**735 个完全空的死实例目录**，无界增长（实测每天新增 7-14 个）。成因：

- 每次 agent 启动创建随机 id 实例目录 + state.json（agent-loop.ts:234,247；出错路径 :313,328 会多建）；
  每次 API 重启每个角色新建 idle 实例 → 实例只增不减。
- 2026-07-30 防累积修复（agent-loop.ts:188-194）只做一半：deleteState 删 state.json
  **不删目录**，累积从文件残留变形为空目录残留。
- 清理死角：启动清理只清同角色 terminated；不再启动的角色的死实例永远没人收。

性能表现（bench 50x 外推）：agent-timeout 每轮 37301 次 stat、命中率 1%、wall P50 1486ms；
listProfiles 同样空扫全部目录（753 个里仅 8 个有 profile.json）。

## 决策

1. **deleteState 判空删目录**：删 state.json 后 readdir 目录，为空才 rmdir。目录里有
   profile.json 或其他文件绝不碰——`agents/<id>/` 是 profile 与 state 共享 namespace
   （file-store.ts:540）。
2. **存量清扫**：一次性 sweeper 删掉现存空目录（同判空条件，幂等）。
3. **清理职责收进 instance-timeout-scan**（每 5min 必跑，本就扫全部实例）：terminated
   实例统一回收，不再依赖「某角色恰好启动」；agent-loop.ts:188-194 的同角色启动清理
   随之拆除。
4. **负结果缓存不做**（降级为可选）：目录闭环后每轮扫描对象 ~15 个，开销可忽略；
   bench 复测不达标再议。

## 已排除的备选

- 聚合 memo（「系统状态快照」词条路线）：对本案无效——37300 文件的 mtime 校验本身就要
  stat 全部，校验成本 = 重建成本。
- 派生快照文件：踩缓存 seam ADR（2026-08-24-cache-seam-decision-rules.md）「真源唯一」红线。
- 布局迁移（state 搬出 profile namespace）/ 单文件合并真源：YAGNI，复测不达标再评。

## 验收口径

- bench 复测（apps/api/bench/loop-read-metrics.ts）：agent-timeout 50x 档每轮读次数
  37301 → ~存活实例数（~350 @50x 合成），wall P50 量级下降。
- 测试：deleteState 判空删目录（空删 / 有 profile 不删 / 有其他文件不删）；
  instance-timeout-scan 跨角色回收 terminated；存量 sweeper 幂等。
- agent-loop 启动清理拆除后，terminated 实例仍被回收（由 scan 承担）。
