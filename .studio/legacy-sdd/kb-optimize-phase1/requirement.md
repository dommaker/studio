---
status: "done"
version: "1.0"
source: studio/docs/issues/2026-07-01-knowledge-base-optimization.md
design_ref: design-analyst output 2026-07-01
---

# Phase 1 知识库源头修复 — 需求

## 源项目追溯

| # | 源项目 | 产出类型 | AC Group | AC |
|---|--------|---------|----------|-----|
| 1 | 1.5 knowledgeBus @deprecated | 注释 | A | AC-A.5 |
| 2 | 1.1 recordTrend → data/ | 代码改写 | A | AC-A.1 |
| 3 | 1.1 recordAnalystAccuracy → data/ | 代码改写 | A | AC-A.2 |
| 4 | 1.1 precipitateRouting → data/ | 代码改写 | A | AC-A.3 |
| 5 | 1.1 signal-aggregator → data/ | 代码改写 | A | AC-A.4 |
| 6 | 1.2 validateKnowledgeForm() | 新函数 | B | AC-B.1 |
| 7 | 1.3 extraction skill 形态判断 | Skill 文档 | B | AC-B.2 |
| 8 | 1.4 KnowledgeAgent safeIngest 引导门禁 | 代码改写 | B | AC-B.3 |
| 9 | 1.7 cstnew 链路改造 | shell+daemon | C | AC-C.1 |
| 10 | 1.8 SCHEDULE trigger | 代码新增 | C | AC-C.2 |

---

## AC Group A: 数据层改写（covers: 源项目 1-5）

目标：切断数据污染知识库的写入路径。数据改写入 `~/.studio/data/trends/`。

### AC-A.1: recordTrend 改写 data/

**触发条件**：`knowledgeService.recordTrend(entry)` 被调用
**预期行为**：
- 写入 `~/.studio/data/trends/YYYY-MM-DD.md`（Markdown 格式，含 frontmatter）
- 不写入 knowledge/（不调用 ingestEntry）
- 目录不存在时自动创建

**边界情况**：
- 同日多次调用 → 追加到同一文件（按 metric 分节）
- entry.content 为空 → 跳过写入，记日志

**不做**：不删除 recordTrend 函数签名（保持调用方兼容）

### AC-A.2: recordAnalystAccuracy 改写 data/

**触发条件**：`knowledgeService.recordAnalystAccuracy(data)` 被调用
**预期行为**：
- 写入 `~/.studio/data/trends/YYYY-MM-DD.md`（metric=analyst_accuracy）
- 不写入 knowledge/

**边界情况**：
- 同日多条 accuracy → 追加同文件
- missedFiles/missedDeps 为空数组 → 仍然写入（有 AC 匹配率数据）

### AC-A.3: precipitateRouting 改写 data/

**触发条件**：`monitorAgent.precipitateRouting()` 被调用
**预期行为**：
- 路由统计数据写入 `~/.studio/data/trends/YYYY-MM-DD.md`
- 不调用 `knowledgeService.recordTrend()`

**边界情况**：
- routing.jsonl 不存在 → 静默返回 true
- 数据 <5 条 → 静默返回 true（现有逻辑保留）

### AC-A.4: signal-aggregator 改写 data/

**触发条件**：`signalAggregator.upsertTrend(trend)` 被调用
**预期行为**：
- 写入 `~/.studio/data/trends/YYYY-MM-DD.md`
- 不写入 knowledge/（不调用 sharedIngest.ingestEntry）
- 同 tag 趋势更新同文件

**边界情况**：
- 已有同日期文件 → 追加/更新对应 tag 节
- 新 tag → 追加新节

### AC-A.5: knowledgeBus @deprecated

**触发条件**：读 `knowledge-bus.service.ts`
**预期行为**：文件头部有 `@deprecated` JSDoc 注释，说明随 Pipeline 30 天观察期后删除

**边界情况**：无

---

## AC Group B: 形态门禁（covers: 源项目 6-8）

目标：统一入库门禁，防止非知识形态写入 knowledge/。

### AC-B.1: validateKnowledgeForm() 函数

**触发条件**：知识写入前调用 `validateKnowledgeForm(entry)`
**预期行为**：
- 返回 `{ valid: boolean; form: 'knowledge' | 'data' | 'skill' | 'rule'; reason?: string }`
- 判断逻辑（代码层，不用 LLM）：
  - type ∈ {pitfall, decision, guideline, pattern→guideline, architecture, lesson→pitfall} → valid=true, form='knowledge'
  - type='process' 且 content 含具体数值/百分比/日期 → valid=false, form='data'
  - content 含多步骤流程标记（"Step 1"、"步骤"、 numbered list >3 项）且 >500 字 → valid=false, form='skill'
  - content 是短指令式（"禁止"、"必须"、"不得"）且 <100 字 → valid=false, form='rule'

**边界情况**：
- 无法判断 → 默认 valid=true（宽容策略，不阻断正常写入）
- entry.content 为空 → valid=false, form='data', reason='empty content'

**不做**：不做语义分析（代码层判断，不调 LLM）

### AC-B.2: extraction skill 形态判断

**触发条件**：knowledge-extraction skill 执行 Step 2.5 质量门
**预期行为**：
- 质量门新增"形态判断"检查项
- 引导 Agent 判断候选条目应写入 knowledge/ 还是 data/ 还是 skill
- 非知识形态不写入 knowledge/

### AC-B.3: KnowledgeAgent safeIngest 门禁集成

**触发条件**：`knowledgeAgent.safeIngest()` 被调用（所有 extract* 方法的统一入口）
**预期行为**：
- safeIngest 调用 `validateKnowledgeForm()` 检查形态
- form='data' → 写入 `~/.studio/data/` 而非 knowledge/，记日志
- form='skill' → 跳过写入，记日志建议走 skill-creator
- form='rule' → 跳过写入，记日志建议更新 CLAUDE.md
- form='knowledge' → 正常写入（现有逻辑）

**边界情况**：
- safeIngest 是 private 方法，所有 6 个 extract* 方法都经过它
- extractDecision 走 knowledgeBus（不在本 AC 范围）

**不做**：不改 extractDecision（走 knowledgeBus，Pipeline 已废弃）

---

## AC Group C: cstnew 链路 + SCHEDULE（covers: 源项目 9-10）

目标：session JSONL 作为数据保存，不再直接提取为知识。

### AC-C.1: cstnew 链路改造

**触发条件**：用户执行 `cstnew`
**预期行为**：
- JSONL.bak 移到 `~/.studio/data/sessions/YYYY-MM-DD-HHMMSS.jsonl`（不再由 events-daemon POST extract-text）
- events-daemon `session:archive` 事件：移动文件到 data/sessions/ 而非 POST /api/knowledge/extract-text

**边界情况**：
- data/sessions/ 目录不存在 → 创建
- 文件已存在同名 → 追加时间戳避免覆盖
- events-daemon POST 失败 → 不影响 cstnew 流程（fire-and-forget）

**不做**：不改 cst-emit.sh（只改 events-daemon 的路由逻辑）

### AC-C.2: session→知识 SCHEDULE trigger

**触发条件**：每日 04:17（cron: '17 4 * * *'）
**预期行为**：
- 创建 WorkUnit（type=analysis, scope 指向 data/sessions/ 7 天数据聚合）
- Agent 消费时读 data/sessions/ 最近 7 天文件 → 聚合提取 → 写 knowledge/（过形态门禁）

**边界情况**：
- data/sessions/ 无文件 → 跳过，不创建 WorkUnit（或在 trigger 层面检查）
- Agent 执行失败 → WorkUnit 标 retryable，下次 trigger 不重复创建

**不做**：不实现 Agent 消费逻辑（由 Agent 执行时自行处理，本 AC 只确保 trigger 创建 WorkUnit）

---

## 不做项汇总

- Phase 2（存量迁移）— 源头修复后单独做
- Phase 3/4（索引质量/消费闭环）— 后续 batch
- extractDecision 改造 — 走 knowledgeBus，Pipeline 已废弃
- knowledgeBus 逻辑迁移 — 标注 @deprecated 后自然死亡
