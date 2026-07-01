# 知识库优化 — 第一性分析 (2026-07-01)

## 问题陈述

`~/.studio/knowledge/` 52 条目中，大量内容不属于"知识"形态：能力(Skill)、规则(Constraint)、数据(Data)、文档(Doc) 混入知识库，导致：
1. grep 搜索被噪音干扰
2. 真正有用的知识（pitfall/decision）被淹没
3. Agent 消费效率低

## 第一性分析

### 知识的定义

知识 = 可复用、可操作、不在代码/docs 中显式存在、通过搜索消费的信息。

三个必要条件：可搜索 + 可操作 + 不在别处。

### 形态分类

| 形态 | 消费方式 | 存储位置 | 例子 |
|------|---------|---------|------|
| **知识** | 搜索消费 | `~/.studio/knowledge/` | "file:./ SQLite 从 CWD 解析" |
| **能力** | 触发消费 | `~/.studio/skills/` | forensic-review 法证审查流程 |
| **规则** | 预注入消费 | CLAUDE.md / harness | "新文件零测试不可提交" |
| **数据** | 参考消费 | `~/.studio/data/` | 路由分布统计、构建时间趋势 |
| **文档** | 按需阅读 | `studio/docs/specs/` | prompt 上下文注入模式分析 |

### 数据→知识→Skill 链路

三层形态，两种转化：

| 层 | 形态 | 特征 | 存储 |
|----|------|------|------|
| L1 | 数据 | 一次性、可过期、具体数值 | `~/.studio/data/` |
| L2 | 知识 | 可复用、可操作、抽象结论 | `~/.studio/knowledge/` |
| L3 | Skill | 可执行、有流程、触发消费 | `~/.studio/skills/` |

两种转化：
1. **数据→知识**：从多条数据中提取模式。单条"路由分布 60/40"是数据；连续7天降级率上升→知识
2. **知识→Skill**：当知识描述的流程足够稳定，固化为可执行步骤

recordTrend() 问题：把 L1 数据直接写入 L2 知识库 = 把原料当成品。

### MonitorAgent 本质：基础设施，不是 Agent

"MonitorAgent 是 Agent Network 8 Agent 之一" 是错误结论。第一性分析：

| 维度 | Agent Network 的 Agent | MonitorAgent |
|------|----------------------|-------------|
| 工作模型 | claim WorkUnit → execute → done | 定时轮询，无 WorkUnit |
| 身份 | Role + RuntimeInstance | 单例 class |
| 触发方式 | Trigger Registry | `setInterval(5min)` |
| 生命周期 | 临时会话 | 常驻进程 |

**结论**：MonitorAgent 与 Scheduler、EventBus、Trigger Registry 同层——**基础设施层**。

"8 个 Agent" 是 Pipeline 架构概念（9 阶段各一执行器），已被 Agent Network 取代。

### precipitate() 系列：数据生命周期闸门

MonitorAgent.precipitate() 是"先沉淀后清理"闸门——不是知识提取管道：

| 方法 | 数据源 | 实际行为 | 知识库影响 |
|------|--------|---------|-----------|
| precipitateStudioEvents() | DB >7d 事件 | LLM 提取失败模式 → recordPattern | ✅ 真正数据→知识 |
| precipitateSessionLogs() | .agent.log 归档 | LLM 提取失败模式 → recordPattern | ✅ 真正数据→知识 |
| precipitateRouting() | routing.jsonl | 算百分比 → recordTrend | ❌ 写数据不是知识 |

precipitateRouting() 的设计目的是让后续 TTL cleanup 合法执行（标记 precipitated=true），不是真正的知识提取。

### 写入知识库的完整路径（~40 个）

| 类别 | 路径 | 写知识库合理？ |
|------|------|:------------:|
| **数据层（不应写 knowledge/）** | recordTrend() (A1c/A2c)、Signal Aggregator (A6)、precipitateRouting (A3g)、recordAnalystAccuracy (A1d/A2d) | ❌ |
| **知识层（应写 knowledge/）** | recordPattern (A1a/A2a)、recordIncident (A1b/A2b)、recordDecision (A1e)、KnowledgeAgent extractFrom* (A4a-A4f)、upsertKnowledge (A1f) | ✅ |
| **操作层（update，合理）** | recordReference / tryPromote / decay / semanticDedup / qualityAssessment | ✅ |
| **外部 API** | HTTP ingest (A12a-A12c)、Channel confirm (A7a)、External fetcher (A8a) | 需加形态判断 |

关键发现：所有写入最终通过 `sharedIngest.ingestEntry` 或 `sharedStore.save` 落盘。没有统一的形态判断门禁。

### memory-sync 链路

**状态：死链路**。hook 配置在 `settings-deepseek.json`，当前用 `settings-bailian.json`，无 hooks。
不需要修源头。Phase 2 处理存量即可。
遗留问题：~8 条 memory-sync 产出条目，格式分裂（createdAt vs created）。

### knowledge-extraction skill 链路

**状态：休眠**。CronCreate 空，最后产出 2026-06-23。
核心缺陷：**无形态判断**。质量门检查"可复用/根因/去重/领域"但不检查"该不该是知识 vs 规则 vs Skill"。
Phase 1.2 需加形态判断，防重启时再污染。

### cstnew session 保存链路

**状态：活跃**。events-daemon 运行中，今天 11:12 还有 extract-text 调用。

```
cstnew (shell 函数 in ~/.zshrc)
  ↓ mv JSONL → JSONL.bak.时间戳
  ↓ cst-emit.sh session:archive "$bak"
  ↓ ~/events/cst.jsonl (事件文件)
  ↓ events-daemon (systemd 服务)
  ↓ POST /api/knowledge/extract-text
  ↓ knowledgeAgent.extractFromText()
  ↓ ~/.studio/knowledge/*.md
```

**问题**：单个 session JSONL 是**数据**（包含完整对话过程：用户指令、工具调用、中间推理、错误重试），不是知识。当前链路直接 LLM 提取 → 污染知识库（事件当知识、表面现象当模式）。

**正确链路**：

| 层 | 内容 | 存储 | 触发 |
|---|------|------|------|
| L1 | session JSONL | `~/.studio/data/sessions/` | cstnew 时移动，不提取 |
| L1→L2 | 跨 session 聚合 | SCHEDULE 定期 | 读 7 天 sessions → LLM 提取模式 |
| L2 | 知识条目 | `~/.studio/knowledge/` | 有形态门禁 |

### 52 条目分类审计

| 类别 | 数量 | 应去哪 |
|------|------|--------|
| ✅ 真正的知识（pitfall/decision/guideline/pattern） | ~13 | 留在 knowledge/ |
| ⚠️ 能力型（可执行流程） | ~7 | → `~/.studio/skills/` |
| ⚠️ 规则型（行为约束） | ~3 | → CLAUDE.md 或 harness |
| ⚠️ 数据型（趋势/事件） | ~3 | → `.archive/` |
| ⚠️ 文档型（设计分析） | ~5 | → `studio/docs/` 或 `.archive/` |
| ⚠️ 骨架型（stub，内容太薄） | ~11 | 评估：升级或归档 |
| ⚠️ Pipeline 遗骸 | ~7 | → `.archive/` |

### 根因：5 条生产线，3 个源头缺陷

**生产线溯源**：

| 生产线 | 产出 | 条目数 | 问题 |
|--------|------|--------|------|
| Pipeline 遗骸 | skills/ 子目录 | 7 | 旧架构 Skill 定义，系统废弃后未清理 |
| knowledge-bus.recordTrend() | `[沉淀]` 趋势 | ~3 | 数据当知识写 |
| memory-sync 迁移 | feedback→knowledge | ~8 | 批量提升，不验证分类 |
| knowledge-extraction skill | 从 memory/ 提取 | ~10 | 不区分知识 vs 能力 vs 规则 |
| 手动编写 | arch-patterns/、pattern-* | ~15 | 无 frontmatter，无生命周期 |

**三个源头缺陷**：

1. **extraction skill 无形态判断** — 质量门问"有没有根因？有没有价值？"但不问"该不该是知识？"。forensic-review 有根因有价值但应该是 Skill
2. **recordTrend() 向知识库注入数据** — 趋势是一次性统计，不是可复用模式
3. **无统一入库门禁** — 7 条生产线各自写入，无共享的形态检查

### 消费管线现状

- **AgentLoop hint** 已实现（commit `96177f4`）：Agent prompt 注入知识库路径 + grep 示例
- **E2E 验证**：auth middleware 任务 → Agent 主动搜索 2 次 ✅
- **消费追踪**：`analyzeKnowledgeSearch()` 检测 Agent 是否搜索了知识库
- **问题**：52 条目中多数不可搜索（无 tag、无标准 ID）

## 优化路径

### Phase 1: 源头修复（防新噪音） ✅ 完成

| # | 任务 | 状态 | Commit |
|---|------|:----:|--------|
| 1.1 | knowledgeService.recordTrend/recordAnalystAccuracy + Signal Aggregator + precipitateRouting() 停写 knowledge/ | ✅ | 4da9043, 36ef6cc, d383e1e |
| 1.2 | knowledgeService 加统一形态门禁 (`validateKnowledgeForm`) | ✅ | 53c2962 |
| 1.3 | extraction skill 质量门加形态判断 | ✅ | 53c2962 |
| 1.4 | KnowledgeAgent.safeIngest 引导使用统一门禁 | ✅ | 53c2962, 4f5e114 |
| 1.5 | knowledgeBus 标注 `@deprecated` | ✅ | 4da9043 |
| 1.6 | 废弃领域清单更新 | ✅ | 已完成（前置） |
| 1.7 | cstnew 链路改造（.zshrc + events-daemon） | ✅ | 系统文件 |
| 1.8 | session→知识聚合 trigger（SCHEDULE 04:17） | ✅ | 9f84026 |

### Phase 2: 存量分类迁移 ✅ 完成

> 原始分类（2.1-2.6）经第一性分析与实际存量不符，重新定义 AC。详见 `docs/sdd/kb-optimize-phase2/design.md`。

| AC | 内容 | 状态 |
|----|------|:----:|
| AC-1 | resolutions/ 166 条测试污染删除 | ✅ |
| AC-2 | archive/process-PRO-006.md 空数据删除 | ✅ |
| AC-3 | 7 条 Pipeline Skill 归档（.archive/pipeline-skills/） | ✅ |
| AC-4 | 3 条 architecture- 前缀 type=guideline → 重命名 guideline- | ✅ |
| AC-5 | 17 条无 frontmatter 补全（13 根目录 + 4 arch-patterns/） | ✅ |
| AC-6 | index.json 重建（45 条目） | ✅ |

### Phase 3: 索引质量提升 ✅ 完成

| # | 任务 | 目标 | 状态 |
|---|------|------|------|
| 3.1 | 补 tag（18 条无 tag） | grep 可发现性 | ✅ Phase 2 AC-5 已补 |
| 3.2 | 补 maturity（23 条 unknown） | 生命周期管理 | ✅ Phase 2 AC-5 已补 |
| 3.3 | 标准化 ID | FileKnowledgeStore 可管理 | ✅ 18 条补 ID，44/44 全覆盖 |

### Phase 4: 消费闭环

| # | 任务 | 目标 |
|---|------|------|
| 4.1 | Agent 搜索后记录 referencedBy | 消费数据闭环 |
| 4.2 | 零消费条目定期审查 | 长期质量保障 |
| 4.3 | 知识→Skill 路径：knowledge-synthesis-skill 检测高引用条目 → 调用 skill-creator 创建 Skill | 稳定知识固化为可执行能力 |
| 4.4 | 废弃 knowledge-skill-evolver.ts（DB 产出无法被 Agent 消费） | 消除死路径 |

## 关键文件

| 文件 | 角色 |
|------|------|
| `~/.studio/skills/knowledge-extraction/SKILL.md` | 知识提取流程（Phase 1.2 修改点） |
| `studio/apps/api/src/modules/knowledge/knowledge-bus.service.ts` | recordTrend/recordPattern/upsertKnowledge（Phase 1.1 修改点） |
| `studio/apps/api/src/modules/knowledge/knowledge-service.ts` | 并行写入路径（Phase 1.1 修改点） |
| `studio/apps/api/src/modules/agents/monitor-agent.service.ts` | precipitate* + TTL cleanup（Phase 1.1 修改点） |
| `studio/apps/api/src/modules/agents/knowledge-agent.service.ts` | extractFrom* 系列（Phase 1.3 修改点） |
| `studio/apps/api/src/modules/knowledge/signal-aggregator.ts` | trend 写入（Phase 1.1 修改点） |
| `harness/src/knowledge/audit.ts` | 审计规则（已有 deprecated-domain） |
| `harness/src/knowledge/index-generator.ts` | 索引生成 |
| `harness/src/cli/commands/knowledge.ts` | CLI 命令（已修复 index.json 同步） |
| `studio/apps/api/src/modules/agents/agent-loop.ts` | 消费管线 hint |
| `studio/apps/api/src/modules/knowledge/knowledge-skill-evolver.ts` | 知识→Skill 演化（Phase 4.4 废弃，被 skill-creator 替代） |
| `~/.studio/skills/knowledge-synthesis-skill/SKILL.md` | 语义模式检测 + Skill 提议（Phase 4.3 修改点） |
| `studio/bin/memory-knowledge-sync.js` | 死链路脚本（Q5 待确认是否废弃） |
| `/root/.zshrc` | cstnew 函数定义（Phase 1.7 修改点） |
| `/root/transport/events-daemon.js` | session:archive 路由（Phase 1.7 修改点） |

## 已完成

- [x] 17 条噪音归档（12 Pipeline + 3 假架构 + 2 个人笔记）
- [x] D7 领域相关性维度（pattern + skill + audit rule）
- [x] index.json 同步修复（commit `12cda1a`）
- [x] extraction skill tag 参考修正（移除 pipeline）
- [x] 溯源分析完成（5 条生产线 + ~40 个写入路径全景）
- [x] MonitorAgent 本质分析（基础设施，不是 Agent）
- [x] memory-sync / extraction skill 链路状态确认（均已死/休眠）

## 待确认问题

> 所有问题已有决策（D1-D8）。以下为决策依据的详细分析。

### Q1: `~/.studio/data/` 目录结构 → D1

数据层存储已确定用文件（`~/.studio/data/`），按日期 `.md` 格式。
- 关键约束：Agent 能 grep 发现，提取 skill 能读取
- 自然过期（>30 天删除）

### Q2: 数据→知识提取的触发机制 → D2

precipitateRouting() 目前只写数据不提取知识。
- 决策：独立 SCHEDULE Trigger，解耦数据写入和知识提取

### Q3: KnowledgeAgent.extractFrom* 的形态判断 → D3

- 决策：统一入库门禁函数（代码层），LLM prompt 引导使用

### Q4: 知识→Skill 的路径 → D4

当前 knowledge-skill-evolver.ts 产出 DB SkillProposal，但 Agent Network 的 Skill = `~/.studio/skills/*.md`，两者未对接。

**设计路径**：

```
知识积累 → referencedBy ≥ N → knowledge-synthesis-skill 提议
  → 调用 skill-creator → 创建 ~/.studio/skills/X.md + 注册
  → KnowledgeEntry 标记 sourceSkill
```

**决策**：废弃 knowledge-skill-evolver.ts（DB 产出无法被 Agent 消费），用 skill-creator 替代。

### Q5: memory-sync 死链路是否正式废弃 → D5

hook 配置不在当前 settings.json 中，但代码和脚本还在。
- 决策：删除代码。无恢复价值，KnowledgeAgent 已覆盖。

### 自检 3: KnowledgeBus/Service 并行写入 → D8

两套 recordPattern/recordTrend/recordIncident 逻辑重复。但：
- knowledgeBus 是 Pipeline 层组件（~15 处调用：goals/*, channels/*, evolution.service.ts）
- knowledgeService 是 Agent Network 层组件（~15 处调用：各 Agent）
- Pipeline 已废弃 30 天观察期

**决策**：不"吸收"（knowledgeBus 相比 knowledgeService 只多了 triage root_cause 弱校验，不值得迁移）。标注 knowledgeBus `@deprecated`，Phase 1.1 只改 knowledgeService 层。30 天后随 Pipeline 删除。

## 决策记录

| # | 问题 | 决策 | 理由 |
|---|------|------|------|
| D1 | data/ 目录结构 | 按日期 `.md`，`~/.studio/data/trends/` | Agent 可 grep，precipitate 按日期范围读取，自然过期 |
| D2 | 数据→知识触发 | 独立 SCHEDULE Trigger（不在 precipitate 内） | 解耦数据写入和知识提取，各做各的事 |
| D3 | 形态判断实现 | 统一入库门禁函数（代码层） | `no_model_for_deterministic`，一劳永逸 |
| D4 | 知识→Skill 路径 | 走 skill-creator，废弃 knowledge-skill-evolver | skill-creator 有完整创建+eval 流程，evolver 产出无法被 Agent 消费 |
| D5 | memory-sync | 删除代码 | 无恢复价值，KnowledgeAgent 已覆盖 |
| D6 | 存量数据条目 | 归档 .archive/ | 一次性统计无提取价值 |
| D7 | recordAnalystAccuracy | 同 Phase 1.1 一起改写 data/ | 和 recordTrend 同类问题 |
| D8 | KnowledgeBus/Service 统一 | knowledgeBus 标注 @deprecated，随 Pipeline 30 天后删除；Phase 1.1 只改 knowledgeService 层 | Pipeline 已废弃，新架构不依赖旧架构 |

## Commits

- harness: `5dbe731` (deprecated-domain audit rule)
- harness: `12cda1a` (index.json sync fix)
- studio: `f053cf9` (parseAcceptedTypes + trigger routes)
