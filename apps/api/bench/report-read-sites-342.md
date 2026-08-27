# studio-events 残余全量读窗口化复测报告（#342）

- 生成时间：2026-08-27（`pnpm tsx bench/read-since-windows-342.ts --runs 10 --scale 50`）
- 方法：与 #335 微基准同口径——synthesizeDataset 以真实 `~/.studio` 为模板合成 50x
  数据集（事件副本 -k*12h 保序偏移），N=10 轮顺序测量取 P50。
- 全量读 = FileStore.readJsonl，每轮 utimes 强制 mtime 失效（生产 append 高频文件
  mtime 校验恒 miss 的真·全量 parse 最坏路径）；窗口读 = readStudioEventsSince
  （裸 fs 倒扫、无缓存、窗口外早停）。

## 数据集

50x：events 34600 行 / 10.3MB（模板 692 行），WU 2260。

## 结果（P50，ms）

| 读法 | 窗口行数 | P50 |
|---|---|---|
| readJsonl 全量（mtime 恒 miss） | 34600（全量 parse） | 162.6 |
| readStudioEventsSince 24h | 10 | 2.1 |
| readStudioEventsSince 7d | 659 | 3.1 |
| readStudioEventsSince 30d | 31803 | 132.8 |

## 结论

- 读成本随窗口行数线性（≈4µs/行 + 固定开销），与文件总量解耦：24h 窗口 10 行 2.1ms、
  7d 窗口 659 行 3.1ms，对 10.3MB / 3.46 万行文件恒为个位数 ms；全量读 162.6ms。
- 30d 窗口在本合成数据集覆盖 92% 行（-k*12h 副本总共只跨 24.5d），故接近全量——
  这是分布使然，不违背「随窗口行数」结论。生产收益随文件超出窗口的增长而放大
  （轮转滞后 / 归档堆积时，窗口化读方成本仍被窗口约束，不再随文件总量线性恶化）。
- #342 的 8 个读点（6 读方）全部收进 readStudioEventsSince 单一窗口读口，读口级
  微基准成立即读方级成立（读方不再各自触碰全量 parse 路径）。

## 各读方落地窗口

| 读方 | 读点 | 窗口 |
|---|---|---|
| monitoring/monitoring.service getOverheadStats | :288 | windowDays（默认 30d，与 aggregate 同口径） |
| knowledge/knowledge-metrics computeOutcomeMetrics | :273 | windowDays（默认 30d） |
| knowledge/knowledge-metrics scanKnowledgeEvents | :338 | windowDays（默认 30d） |
| agents/token-usage.service computeAgentTokenUsage | :160 | 30d |
| agents/token-usage.service aggregateTreeTokens | :266 | 30d |
| agents/token-usage.service sumTokensForWorkUnits | :346 | 30d |
| events/session-summary-generator generateSessionSummary | :49 | 30d（session 跨度 ≪ 窗口） |
| events/session-summary-generator suggestSkillForPattern | :217 | 30d（原口径不变） |

## 口径收敛说明（有意为之，对齐既有先例）

- 无显式时间口径的读方（totals / 树聚合 / PMO 台账 / session summary）统一取 30d，
  对齐 #173 事件热保留期——与 #335 中 maintainer 确认的 wu-changed-files 30d 先例一致；
  生产热文件本就 ≈30d，语义偏移仅出现在轮转滞后时段的更旧事件。
- 窗口读口跳过无时间戳（NaT）行：token-usage totals 原全量读会把无 createdAt/timestamp
  的行计入累计，现不再计入——与 #335 auditor 口径修正（NaT 行不进窗口）一致。
- 测试 fixture 单调性：窗口倒扫早停的前提是 append-only 单调，两处 knowledge fixture
  的「窗口外噪音行」由文件尾移至文件头（最旧在前）。
