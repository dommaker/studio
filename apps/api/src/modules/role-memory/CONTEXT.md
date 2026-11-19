# apps/api/src/modules/role-memory

### 职责

角色记忆存储服务：per-role 目录落数据区（经 `studioPath()`），`MEMORY.md` 索引 + `topics/*.md` 正文 + `draft.jsonl` 草稿 + `maintenance.jsonl` 持久维护 run。`role-memory.ts` 负责存储、scope/lifecycle 召回、usage/verification 与 topic 合并；`maintenance.ts` 负责可恢复 promote/merge/archive/restore/capacity。WU 收尾提取钩子在 `completion-extraction.ts`（committed 增量 + watermark + 启动续扫），真实使用由 `usage-scan.ts` 后验扫描 transcript 正文路径并回写；人审提案生命周期经 review-proposal 正本，adapter 在 `review-adapter.ts`。

数据布局：`<studioDir()>/memory/<roleId>/` 下 `MEMORY.md`（全量浏览索引）、`topics/<slug>.md`（frontmatter + `## 标题` 段；learning/lastUsage/lastVerification/status/supersededBy 以 JSON frontmatter 保存）、`draft.jsonl`（草稿与墓碑）、`maintenance.jsonl`（#718，同 id 完整快照追加、读侧折叠）。角色身份 = `AgentProfile.id`。测试经 `isTestEnv` 改写 tmpdir per-进程子目录。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| index.ts | 模块公共出口（barrel） | P2-c 立界：跨模块唯一合法 import 面（实际消费反推生成）；深路径 import 由 eslint `local/no-deep-module-import` 拦截 |
| `RoleMemoryStore` / `roleMemoryStore` | `role-memory.ts` | 存储服务类 + 模块单例 |
| `readIndex` / `readTopic` | `role-memory.ts` | 全量浏览索引/topic；不存在返回 `''`/`null`；archive 原文仍可恢复 |
| `readApplicableIndex` | `role-memory.ts` | #718 自动注入索引：learning scope 匹配且 active、未 superseded；legacy 未知 scope 暂停注入 |
| `appendDraft` | `role-memory.ts` | 追加草稿（JSONL）；kind 白名单；review 档位 auto/manual；可选 `sourceRefs` 与 `learning` |
| `readDraft` | `role-memory.ts` | 读 pending 草稿（foldDraftRows 折叠后只留 pending） |
| `foldDraftRows` / `isDraftStatusRow` | `role-memory.ts` | draft.jsonl 行折叠（读侧归一，ADR 决策 3）：旧 promoted→executed；`kind:'status'` 状态行直取；#360 起分组折叠走共享 `foldJsonlById`，旗标/状态行取舍口径留本模块 adapter |
| `promote` / `mergeTopics` | `role-memory.ts` | 草稿或既有 topic 合并 + per-role 互斥；标题段幂等，源 topic 标 archived/supersededBy 且保留原文 |
| `recordUsage` / `setLifecycleStatus` / `supersedeTopic` | `role-memory.ts` | 回写 Assignment/StepRecord 使用与最终验证；维护 active/stale/conflicting/archived/supersession |
| `demote` | `role-memory.ts` | 拒绝草稿：追加 rejected 墓碑行 |
| `checkCapacity` | `role-memory.ts` | 只读容量检查，不计 archived；执行归 RoleMemoryMaintenance |
| `RoleMemoryMaintenance` / `roleMemoryMaintenance` | `maintenance.ts` | #718 持久 promote/merge/archive/restore/capacity run；意图先于副作用，`recoverPending()` 重放 triggered/running 并重试 failed（最多 3 次） |
| `RoleMemoryUsageScanner` / `initRoleMemoryUsageScan` | `usage-scan.ts` | #718 done + 启动续扫 committed transcript，只把真实 topic 正文路径记为使用；按 entry.assignmentId 关联该轮 StepRecord/verification；独立 `role-memory-usage` watermark |
| `roleMemoryDir` / `sanitizeRoleId` / `sanitizeTopicSlug` | `role-memory.ts` | 路径函数 + 路径穿越防护 |
| `MemoryProposalStore` / `submitMemoryProposal` / `repostMemoryProposal` | `review-adapter.ts` | review-proposal 正本 adapter（#353）：per-role draft.jsonl 存取 + 聚合 memory_proposal 卡；#716 起蒸馏恢复可重发 card-failed 原卡，不重复写草稿 |
| `registerMemoryReviewAdapter` | `review-adapter.ts` | 注册 kind='memory' adapter（onApprove→promote / onReject→demote）；initWuCompletionExtraction 装配 + submit 自助注册 |
| `WuCompletionExtractor` / `initWuCompletionExtraction` | `completion-extraction.ts` | WU 收尾提取钩子 + 单例工厂；`recoverPending()` 启动续扫 done WU 的未消费 watermark |
| `buildTranscriptText` / `normalizeDraftInput` | `completion-extraction.ts` | 纯函数：transcript 拼接 / appendDraft 入参转换 |

### 设计约束

- 记忆只收 `execution-knowledge`（做法/踩坑/教训）与 `preference`（偏好/约定）两类；kind 白名单拒绝其它。决策进项目级决策日志，不进角色记忆。
- 草稿 append-only（`O_APPEND`，并行写不冲突）；promote 走单一代码路径 + per-role 进程内互斥（`Map<roleId, Promise>` 链式锁，不引入 Redis）。
- 墓碑语义：promote/demote 追加墓碑行不改写原行；正本审批（#353）追加 `kind:'status'` 状态行；读侧统一经 `foldDraftRows` 折叠（旧 `promoted` 归一为 `executed`，ADR 决策 3，存量历史行不改写）。
- 两档人审：`auto` 与审批 `approve` 都经 RoleMemoryMaintenance 持久 promote；`manual` 档经 `submitMemoryProposal` 聚合一张 memory_proposal 卡，reject→demote。
- 容量超限不拒绝写入；capacity run 只自动归档 stale/superseded，活跃 topic 与 pending 草稿仍需显式 merge/archive，不自动删除。
- 路径经 `studioPath()`（读 `STUDIO_HOME`）；禁硬编码 `~/.studio`。测试走 `isTestEnv` tmpdir。
- KnowledgeSync cycle 事件仅在有 stale/unmonitored 时落库，全零只写日志。
- `readIndex`/`readDraft`/`readTopic` 不存在文件返回 `''`/`[]`/`null`（不抛）。
- #404：模块内裸 fs 读清零——索引/topic 正文走 FileStore 读穿 seam（`readDoc`/mdCache，mtime 校验），目录清单走 `store.readdir`（dirCache）；命中返回结构克隆（#343 语义基线）。P2-e：topic 正文写也收口 `writeDoc` seam（写后失效缓存）；仅存裸 fs 写 = `rebuildIndex` 的 MEMORY.md 索引——无 frontmatter，`writeDoc` 会强加空 fence 改变形态，保留并在 rebuildIndex 注释注明。
- `appendDraft` 写盘失败抛出，调用方 fire-and-forget 兜底。
- **完成提取冷启动（SEC-04 回归根因，2026-10-26）**：AC1 超时不是 FileStore 数据隔离问题，而是 budget/agents barrel 串行动态首载叠加。生产加载顺序不为此改变；仅 `completion-extraction.test.ts` 在 `beforeAll` 预载真实依赖，消除测试环境冷启动，既有 3s 窗口和全部 AC 断言不变。

### 依赖关系

**上游**: `@dommaker/studio-shared`（FileStore appendJsonl/readJsonl、frontmatter 解析、log-path isTestEnv/testTmpRoot）、`studio-dir`（studioPath）。

**下游**: WU 收尾提取（auto/manual 草稿均带最终 LearningMetadata）、角色记忆适用索引注入（readApplicableIndex）、真实使用扫描（recordUsage）、人审提案审批（review-proposal kind='memory' → maintenance promote/demote）、蒸馏产物落地（distill-landings 调 submitMemoryProposal 带 sourceRefs）、bootstrap 启动恢复 maintenance 与 usage watermark。
- **契约驱动迁移（2026-10 批次 7/8）结论**：本模块无自有 HTTP 面——专有端点已随 #353 退役，人审走 /review-proposals kind='memory' 通用端点（批次 4 已迁）。
