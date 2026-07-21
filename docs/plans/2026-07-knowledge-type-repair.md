# 2026-07 知识类型断链修复（决策链/交互模式/解法库/行为模式 + seed 污染清洗）

> 依据：2026-07-20 知识类型断链核查（`~/.studio/knowledge/index.json` 770 条实证 + 读写路径全查）。
> 与 `2026-07-flywheel-repair.md` 断点 D/E 同批性质（数据通路与污染清洗）；与 `2026-07-knowledge-review-loop.md` 有明确衔接点（见 §3）。
> 状态：设计待评审。
> 执行轨道：**γ（数据/类型修复）** 承担 R2/R3（routes 口径与影子库合并脚本）/R4/R5 与 `2026-07-flywheel-wireups.md` 的 ④；其中 **R1 与 R3 的 `createResolution` 改写归 β 轨道**（同函数/同文件避让，见各节标注）。存量数据操作（seed 清洗/tag 回填/影子库合并）统一由 γ 的清洗脚本执行，**先 dry-run 出报告**；tag 回填以 β 的约定 `['decision', <category>]` 为准。

## 1. 现状（全部已查证）

UI `KnowledgePage.tsx` 标题宣称"八大知识类型"，实际渲染 7 个 tab，有数据的只有 4 个（统一视图/偏好/规则/环境）。实证：

| 类型 | 查询口径 | 写入方 | 实际数据 | 断链原因 |
|---|---|---|---|---|
| 决策链 | `decisionChainExtractor.query` → store 按 `tags:['decision']` 过滤（decision-chain-extractor.ts:222） | `extractFromExecution`（生产零调用）；`KnowledgeBus.recordDecision`（@deprecated，生产零调用） | store 有 4 条 `type='decision'` 但 **tags 无 'decision'**，查不到 | ① 无生产触发；② 两种口径并存：`type='decision'`（LLM 提取产物）vs `tags=['decision']`（extractor 产物） |
| 交互模式 | `patternMiner.getActivePatterns` | `patternMiner.analyzeDaily`（evolution-scheduler 每日，index.ts:168） | 0 | 门槛 = 24h 内 ≥10 条真实 `tool:call`；写入侧 R2 已修（agent-loop.ts:453-457 统一目录），但**无真实执行流量**；存量 333 条全是 `__` 前缀测试事件（miner 过滤口径，正确） |
| 解法库 | `resolutionService.listPending` 只返回 `maturity=pending`（search.routes.ts:42） | seed + auditor/triage `createResolution` | 720 条文件全是 `canonical` → **UI 显示 0**；另有 5 条影子库 `~/.studio/data/resolutions/*.json` UI 不读 | ① 查询口径与数据 maturity 错配；② seed 去重失效（见 R5）；③ 双库存储 |
| 行为模式 | 读端残留（search.routes.ts:131 按 `tags:['behavior']`） | **全库无写入方**（extractUserBehavior 已于 2026-07-20 清理批删除） | 0 | 写链路整体已删，读端与 UI 文案是残尸 |
| （污染） | — | `ensureSeedResolutions()`（index.ts:106，每次启动跑） | 720 条 = 2 条 seed × 360 份重复，全 `canonical` | 去重失效；monitor 已报 duplicate rate 94%、index inconsistency 728 处 |

## 2. 修复项

### R1 决策链 —— 复用 LLM 提取，不重建 extractor 链路

方案对比：(a) 把 `decisionChainExtractor.extractFromExecution` 接回 agent-loop——多一次 LLM 调用，与 `extractFromConversation` 功能重复；(b) **复用现有 LLM 会话提取**（推荐）——`ingestConversationEntry` 已接受 `type='decision'`。

- `ingestConversationEntry`（knowledge-service.ts:1438 附近）：对 `type='decision'` 条目补 tags `['decision', <category>]`；
- `decisionChainExtractor.query` 口径放宽：`type='decision'` OR `tags` 含 `'decision'`；存量 4 条回填 tag（一次性脚本，可并入 R5 清洗）；
- tab 展示 draft 条目并标注"待审"；**注入仍须 verified**（与审核闭环衔接，见 §3）；
- `KnowledgeBus.recordDecision` 不复活（@deprecated，随断点 H 收敛）。
- **实现归属：并入审核闭环轨道**（与"入库即发卡"改同一函数 `ingestConversationEntry`，避免同函数冲突）。decision 类提案复用 `knowledge_proposal` 卡片，不单独做卡。

### R2 交互模式 —— 先验证真实流量，再谈门槛

- 验证：跑一个真实任务，确认 `writeToolCallEvents` 落盘非零（风险点：CLI 输出非 stream-json 时 `parseStreamEvents` 产 0 条——接线在但数据可能为空）；
- 若落盘为 0：修 stream 解析或改从 agent-runner 侧记录；
- 门槛（24h≥10 条）与 `__` 过滤口径**不动**（过滤正确；门槛待有真实流量后再评估）；
- 依赖一期 MVP 链路可用（无真实任务则无数据，属架构性事实而非 bug）。

### R3 解法库 —— 口径统一 + 双库合并

- `search.routes.ts:42`：`listPending` 改为返回 `pending + canonical`（canonical 是审核通过的正式解法，本应展示）；
- 影子库 `~/.studio/data/resolutions/*.json`（5 条，triage 经 `knowledgeService.createResolution` 写入）：合并进 resolutionService 主存储，createResolution 改写到同一处；
- 验收：UI 解法库 tab 显示去重后的 canonical 条目；triage 新建的 Resolution 同 tab 可见。

### R4 行为模式 —— 清残尸，不重建

- 删读端死代码：`search.routes.ts:131` behavior 查询、`KnowledgePage.tsx:138` 标题中"行为模式"文案（8 改 7，与实际 tab 一致）；
- 未来若做"用户行为模式"，走审核闭环的 LLM 提取通道（vision §4 提取范围含用户偏好），不开独立链路。

### R5 seed 污染清洗 + 去重修复

- 修 `ensureSeedResolutions()` 去重判据（按 title+内容 hash 查重，启动时幂等）；
- 一次性清洗：保留 2 条 canonical seed，删 718 条重复；**先 dry-run 出报告再执行**；同步回填 R1 的 4 条 decision tag；
- 清洗后 monitor 的 duplicate rate / index inconsistency 报警应归零——纳入看板复核。

## 3. 与其他文档的衔接

- **审核闭环**（`2026-07-knowledge-review-loop.md`）：R1 的 decision 条目以 draft 入库，"展示"不依赖审核闭环，"参与注入"依赖。R1 的代码改动（`ingestConversationEntry` 补 tags）与审核闭环的"入库即发卡"同函数，**实现时并入审核闭环轨道，由同一执行方完成**。
- **flywheel-repair.md**：断点 D 写入侧已修（统一目录），R2 是其数据面验证；断点 E 污染清洗（`.harness/knowledge` 测试污染）与 R5 同一性质，可共用清洗脚本框架。
- **flywheel-wireups.md**（②③④）：无文件重叠；④改 agent-loop `recordResult`，R2 验证改 agent-loop 事件写入区域，实现时归同一执行方。

## 4. 验收

- 决策链 tab：完成一个含架构取舍的任务 → 提取产出 decision → tab 可见（标"待审"）→ 频道审核通过 → 后续任务注入命中。
- 交互模式 tab：有真实执行流量后，tab 出现 pattern；无流量时显式"cold_start"而非空表。
- 解法库 tab：显示 2 条 seed（去重后）+ triage 新建条目；duplicate rate 报警归零。
- 知识页标题与实际 tab 数一致（7 个）。
