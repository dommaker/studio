# apps/api/src/modules/role-memory

### 职责

角色记忆存储服务：per-role 目录落数据区（经 `studioPath()`），三件套--`MEMORY.md` 索引 + `topics/*.md` topic 正文 + `draft.jsonl` append-only 草稿区。`role-memory.ts` 只做存储层：读索引、读/写草稿、promote 合并、demote 拒绝、容量检查。WU 收尾提取钩子在 `completion-extraction.ts`；人审卡在 `memory-proposal-card.ts` + `role-memory.routes.ts`。

数据布局：`<studioDir()>/memory/<roleId>/` 下 `MEMORY.md`（索引）、`topics/<slug>.md`（topic 正文，frontmatter + `## 标题` 段）、`draft.jsonl`（pending + promote/reject 墓碑行）。角色身份 = `AgentProfile.id`。测试经 `isTestEnv` 改写 tmpdir per-进程子目录（防并行互踩）。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `RoleMemoryStore` / `roleMemoryStore` | `role-memory.ts` | 存储服务类 + 模块单例 |
| `readIndex` / `readTopic` | `role-memory.ts` | 读索引/读 topic；不存在返回 `''`/`null` |
| `appendDraft` | `role-memory.ts` | 追加草稿（JSONL）；kind 白名单；review 档位 auto/manual；可选 `sourceRefs` |
| `readDraft` / `getDraftStatus` | `role-memory.ts` | 读 pending 草稿（去重取最新）/ 查审核状态 |
| `promote` | `role-memory.ts` | 草稿 -> topic/索引 唯一合并路径 + per-role 互斥；merge 幂等 |
| `demote` | `role-memory.ts` | 拒绝草稿：追加 rejected 墓碑行 |
| `checkCapacity` | `role-memory.ts` | 容量检查：超限 -> 结构化提醒（不拒绝写入） |
| `roleMemoryDir` / `sanitizeRoleId` / `sanitizeTopicSlug` | `role-memory.ts` | 路径函数 + 路径穿越防护 |
| `postMemoryProposalCard` | `memory-proposal-card.ts` | 发 memory_proposal 卡到 #系统 频道 |
| `role-memory.routes` | `role-memory.routes.ts` | POST `/promote`/`/demote`；GET `/draft-status` |
| `WuCompletionExtractor` / `initWuCompletionExtraction` | `completion-extraction.ts` | WU 收尾提取钩子 + 单例工厂 |
| `buildTranscriptText` / `normalizeDraftInput` | `completion-extraction.ts` | 纯函数：transcript 拼接 / appendDraft 入参转换 |

### 设计约束

- 记忆只收 `execution-knowledge`（做法/踩坑/教训）与 `preference`（偏好/约定）两类；kind 白名单拒绝其它。决策进项目级决策日志，不进角色记忆。
- 草稿 append-only（`O_APPEND`，并行写不冲突）；promote 走单一代码路径 + per-role 进程内互斥（`Map<roleId, Promise>` 链式锁，不引入 Redis）。
- 墓碑语义：promote/demote 追加墓碑行不改写原行；读 pending 按 id 去重取最新行再排除。
- 两档人审：`auto` 档（操作型事实）直 promote；`manual` 档（规律/教训/偏好）发卡，人审 approve/reject。
- 容量超限只提醒不拒绝写入、不自动删。
- 路径经 `studioPath()`（读 `STUDIO_HOME`）；禁硬编码 `~/.studio`。测试走 `isTestEnv` tmpdir。
- KnowledgeSync cycle 事件仅在有 stale/unmonitored 时落库，全零只写日志。
- `readIndex`/`readDraft`/`readTopic` 不存在文件返回 `''`/`[]`/`null`（不抛）。
- `appendDraft` 写盘失败抛出，调用方 fire-and-forget 兜底。

### 依赖关系

**上游**: `@dommaker/studio-shared`（FileStore appendJsonl/readJsonl、frontmatter 解析）、`studio-dir`（studioPath）、`studio-log-path.ts`（isTestEnv）。

**下游**: WU 收尾提取（appendDraft 写入方）、角色记忆索引注入（readIndex 读取方）、人审卡片（memory-proposal-card + routes approve/reject）、蒸馏产物落地（distill-landings 调 appendDraft 带 sourceRefs）。
