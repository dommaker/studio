# role-memory

> 此文件描述 apps/api/src/modules/role-memory 目录的职责和上下文

## 职责

角色记忆存储服务（#98，#88 spec §A）：per-role 目录落数据区（经 `studioDir()`/`studioPath()`），三件套——`MEMORY.md` 索引 + `topics/*.md` topic 正文 + `draft.jsonl` append-only 草稿区。`role-memory.ts` 只做存储层：读索引（供 #100 注入）、读/写草稿（供 #99 写、#101 读）、promote 合并（草稿 → topic/索引）、容量检查；不实现注入（#100）、人审卡片（#101）。WU 收尾提取钩子（#99）在本目录 `completion-extraction.ts`（存储层之外的消费方，订阅 `workunit.status_changed` → done）。

## 数据布局

```
<studioDir()>/memory/<roleId>/
  MEMORY.md            # 索引：每 topic 一行 `- [slug](topics/slug.md) — 一句话摘要`（auto-generated）
  topics/<slug>.md     # topic 正文：frontmatter(title/summary/kind/updatedAt) + 正文（每条目一个 `## 标题` 段）
  draft.jsonl          # append-only 草稿：pending 行 + promote 墓碑行（promoted:true/promotedAt）
```

角色身份 = `AgentProfile.id`（agent-loop `this.role.id`）。测试环境经 `isTestEnv` 改写 `os.tmpdir()/studio-test-role-memory`（同 studio-log-path 约定，防测试写生产 `~/.studio/memory`）。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `RoleMemoryStore` | `role-memory.ts` | 存储服务类（`new RoleMemoryStore(limits?)`，可注入容量上限） |
| `roleMemoryStore` | `role-memory.ts` | 模块级单例（#99/#100/#101 共用同一互斥与缓存） |
| `readIndex` | `role-memory.ts` | 读 `MEMORY.md` 索引全文；不存在返回 `''`（供 #100 注入兜底） |
| `readTopic` | `role-memory.ts` | 读单个 topic 文档；不存在返回 `null` |
| `appendDraft` | `role-memory.ts` | 追加草稿（JSONL 一行）；kind 白名单外抛错 |
| `readDraft` | `role-memory.ts` | 读 pending 草稿（按 id 去重取最新行，排除已 promote） |
| `promote` | `role-memory.ts` | 草稿条目 → topic/索引 的唯一合并路径 + per-role 互斥 |
| `checkCapacity` | `role-memory.ts` | 容量检查：topic 数 / pending 草稿数超限 → 结构化提醒 |
| `roleMemoryDir` | `role-memory.ts` | per-role 目录路径（纯函数，含 `env` 注入测试） |
| `sanitizeRoleId` / `sanitizeTopicSlug` | `role-memory.ts` | 路径穿越防护（拒 `..` / 分隔符 / 空） |
| `MemoryKind` / `MemoryDraftEntry` / `TopicDoc` / `CapacityCheck` / `PromoteResult` 等 | `role-memory.ts` | 类型定义 |
| `WuCompletionExtractor` | `completion-extraction.ts` | #99 WU 收尾批量提取钩子：订阅 `workunit.status_changed` → done，读 transcript → LLM → `appendDraft`；可熔断/可审计，fire-and-forget |
| `initWuCompletionExtraction` | `completion-extraction.ts` | 单例工厂（懒初始化 + 订阅，index.ts 启动调用，形态同 `initAnalysisHandoff`） |
| `MEMORY_EXTRACTION_SYSTEM_PROMPT` | `completion-extraction.ts` | 角色记忆提取 prompt（产出 execution-knowledge/preference，适配 appendDraft） |
| `buildTranscriptText` / `normalizeDraftInput` | `completion-extraction.ts` | 纯函数：transcript 拼接截断 / LLM 条目 → appendDraft 入参 |

## 设计决策

- **内容纪律（spec §A）**：记忆只收两类——`execution-knowledge`（有效做法/踩坑/失败教训）与 `preference`（偏好/约定）；`appendDraft` 按 kind 白名单拒绝其它形态。决策不进角色记忆（留项目级决策日志，索引存指针）；persona/职责属静态 preset 不算记忆。
- **并发安全**：草稿 append-only（`FileStore.appendJsonl` 的 `O_APPEND`，多 WU 并行写不冲突）；promote 合并走**单一代码路径**（唯一写 topic + 索引的方法）且 per-role **进程内互斥**（`Map<roleId, Promise>` 链式锁，单进程模型，不引入 Redis）。
- **墓碑语义**：草稿 append-only，promote 追加 `{...entry, promoted:true}` 墓碑行而非改写原行；读 pending 须按 id 去重取最新行（否则原 pending 行仍会被当作未 promote）。
- **容量上限 + GC（最简）**：超限只提醒（`checkCapacity` 返回结构化 signal），**不落新人罪**（不拒绝写入）、**不自动删**。GC = 超限提醒人合并 topic / 淘汰草稿。
- **KnowledgeSync「零值 trend 止血 + GC」合并**：defer。#88 该子项指向 #83（知识飞轮 GC，spec 明确 Out of Scope）；本仓库 grep「零值」无命中，`knowledge-sync.service.ts` 的 trend 写入（`recordPattern({type:'trend'})`）与 `knowledge-metrics.ts` 的 `deriveOutcomeTrend`（零数据已返 `insufficient-data`/`stable`）均无「零值 trend」实现锚点。本票只留 `checkCapacity` 作为未来 GC 可消费的 hook，不深入改 KnowledgeSync。建议另开票跟进。
- **路径**：生产经 `studioPath()`（读 `STUDIO_HOME`，dev/prod 隔离）；禁硬编码 `~/.studio`。测试隔离走 `isTestEnv` 改写 tmpdir，不全局设 `STUDIO_HOME`（会破坏既有测试）。

## 依赖关系

**上游**:
- `@dommaker/studio-shared`（`FileStore` 的 `appendJsonl`/`readJsonl`、`parseFrontmatter`/`serializeFrontmatter`）
- `@dommaker/studio-shared/studio-dir`（`studioPath` 数据根解析）
- `apps/api/src/utils/studio-log-path.ts`（`isTestEnv` 测试隔离判定）

**下游**:
- #99 WU 收尾批量提取（`appendDraft` 写入方，已落地：本目录 `completion-extraction.ts`）
- #100 角色记忆索引常驻注入（`readIndex` 读取方）
- #101 记忆人审卡片（`readDraft`/`promote` 读取与 approve→promote 路径）

## 注意事项

- `readIndex`/`readDraft`/`readTopic` 对不存在文件返回 `''`/`[]`/`null`（不抛），供注入与召回兜底。
- `appendDraft` 写盘失败会抛出——调用方按 fire-and-forget 兜底（同 transcript-archive 约定）。
- promote 结果 `topicsUpdated` 已按 slug 排序（结果确定）。
- 测试经 `new RoleMemoryStore({ maxTopics, maxPendingDrafts })` 注入小上限验证容量提醒；`FileStore` 读穿缓存按绝对路径 + mtime 失效，append 后立即读一致。
