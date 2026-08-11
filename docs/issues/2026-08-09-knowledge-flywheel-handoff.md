# 知识引擎飞轮数据沉淀 — 下一张地图的种子文档

> 2026-08-09 由 wayfinder 地图 [#53](https://github.com/dommaker/studio/issues/53) 研究票 [#68](https://github.com/dommaker/studio/issues/68) 的支线考察留痕。
> 用户的设计意图：知识引擎在本地沉淀会话数据用于蒸馏进化。考察结论：**注入/消费侧活着，沉淀/输入侧已死，维护侧在空转烧钱**。

## 议题范围（待下一会话细化）

知识引擎飞轮的数据沉淀健康度：会话数据落盘 → 知识提取 → 知识库质量 → 注入消费的闭环是否转得动。

## 已知线索（2026-08-09 实测）

1. **会话沉淀输入管线已死（约 2026-07-18 起）**
   - `~/.studio/data/sessions/` 共 19 个文件，全部 `.done`，最新沉积 2026-07-16/18；此后无任何新会话文件落盘。
   - 代码库中**没有任何写入该目录的逻辑**——唯一引用是 `apps/api/src/modules/agents/default-triggers.ts:67,205` 里 `session-knowledge-extraction` 触发器给 agent 的 scope 文本（"Scan ~/.studio/data/sessions/ for unprocessed JSONL…"）。存量文件是手工拷贝的 `.bak`（文件名 `a1b2c3d4-...` 为占位 UUID）。
   - 后果：该触发器每天 04:17 照常建 WU，agent 扫描后空转退出（`workunit:execution_step` 事件实证："All files already have .done suffix"）——每日白烧一轮 token。
   - 真正的会话数据源其实存在：claude transcript 在 `/root/.claude/projects/<cwd-slug>/*.jsonl`（生产 106+ 个 studio 步会话，见 `docs/research/timeout-data-measurement.md`），kimi 在 `~/.kimi-code/sessions/`。**缺的是 transcript → data/sessions 的自动归档器**。

2. **KnowledgeSync 每小时写零值噪声条目**
   - `apps/api/src/modules/knowledge/knowledge-sync.service.ts:344`：每个 sync cycle 无条件 `recordPattern` 一条 trend 条目，即使 `0 stale, 0 unmonitored, 0 healed`。
   - 近 7 天 `knowledge:entry_created` 487 条中约 196 条（40%）是这种零值条目（标题聚类：`KnowledgeSync cycle: 0 stale, 0 unmonitored, 0 healed` ×177 + 变体 ×19）。稀释检索与注入质量。
   - 建议方向：零值 cycle 只写日志不落知识条目（severity=info 时不落库）。

3. **飞轮维护 WU 恰好是 120s 超时的主要受害者**
   - `knowledge-quality-audit` / `zero-consumption-audit` / `session-knowledge-extraction` 三类触发器的 WU 反复 `Command timed out after 2min`（31 个超杀 WU 的大头），知识质量审计、零消费审计从未真正跑完。与 #54 超时决策直接相关。

4. **无界增长无 GC**
   - `~/.studio/data/sessions/` 143MB `.done` 文件（单文件最大 33MB）永久保留；`~/.studio/knowledge/` 223 条 + `archive/` 220 条（6.3MB）只进不出。
   - 消费侧对比：`knowledge:skill_used` 近 7 天 13,944 条（注入活跃），真实知识条目每日仍有产出（[Session Feature]/[Exec] 等标题聚类）——闭环断在沉淀与维护，不在注入。

## 建议的启动方式

下一个会话：`/wayfinder` + 本文档路径，目的地草案——"修复知识飞轮沉淀链路：transcript 自动归档器 + 噪声条目止血 + 沉淀 GC 策略 + 维护 WU 可完成（依赖 #54 超时修复）"。
