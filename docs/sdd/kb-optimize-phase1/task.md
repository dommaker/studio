---
status: done
version: "1.0"
---

# Phase 1 知识库源头修复 — 任务

## 契约测试规划

### AC-A.1: recordTrend → data/

**测试文件**: `studio/apps/api/src/modules/knowledge/knowledge-service.test.ts`

| 测试用例 | 类型 | 预期 |
|---------|------|------|
| recordTrend 写入 data/trends/ 而非 knowledge/ | 功能 | 文件存在于 data/trends/YYYY-MM-DD.md |
| recordTrend 同日多次调用追加同文件 | 功能 | 文件内容含多个 section |
| recordTrend 不调用 ingestEntry | 行为 | ingest.ingestEntry mock 未被调用 |
| recordTrend data/ 目录不存在时自动创建 | 边界 | mkdirSync 被调用 |
| recordTrend content 为空时跳过 | 边界 | 文件不创建，日志记录 |

### AC-A.2: recordAnalystAccuracy → data/

**测试文件**: `studio/apps/api/src/modules/knowledge/knowledge-service.test.ts`

| 测试用例 | 类型 | 预期 |
|---------|------|------|
| recordAnalystAccuracy 写入 data/trends/ | 功能 | 文件存在 |
| recordAnalystAccuracy 不调用 ingestEntry | 行为 | ingest.ingestEntry mock 未被调用 |
| 同日多条 accuracy 追加同文件 | 功能 | 文件内容含多条记录 |

### AC-A.3: precipitateRouting → data/

**测试文件**: `studio/apps/api/src/modules/agents/monitor-agent.service.test.ts`

| 测试用例 | 类型 | 预期 |
|---------|------|------|
| precipitateRouting 写 data/trends/ | 功能 | 文件存在 |
| precipitateRouting 不调 knowledgeService.recordTrend | 行为 | recordTrend mock 未被调用 |
| routing.jsonl 不存在 → 返回 true | 边界 | 静默成功 |
| 数据 <5 条 → 返回 true | 边界 | 静默成功 |

### AC-A.4: signal-aggregator → data/

**测试文件**: `studio/apps/api/src/modules/knowledge/signal-aggregator.test.ts`

| 测试用例 | 类型 | 预期 |
|---------|------|------|
| upsertTrend 写 data/trends/ | 功能 | 文件存在 |
| upsertTrend 不调 sharedIngest.ingestEntry | 行为 | ingestEntry mock 未被调用 |
| 同 tag 更新已有 section | 功能 | 文件内容更新而非追加重复 |

### AC-A.5: knowledgeBus @deprecated

**测试文件**: 无（纯注释，不需要测试）

验证方式: `grep "@deprecated" knowledge-bus.service.ts` 有结果

### AC-B.1: validateKnowledgeForm()

**测试文件**: `studio/apps/api/src/modules/knowledge/knowledge-service.test.ts`

| 测试用例 | 类型 | 预期 |
|---------|------|------|
| type=guideline → valid=true, form='knowledge' | 功能 | 知识形态通过 |
| type=pitfall → valid=true, form='knowledge' | 功能 | 知识形态通过 |
| type=process + 含百分比 → valid=false, form='data' | 功能 | 数据形态拒绝 |
| tags=['trend'] → valid=false, form='data' | 功能 | 数据 tag 拒绝 |
| 多步骤流程 + >500字 → valid=false, form='skill' | 功能 | Skill 形态拒绝 |
| "禁止..." + <100字 → valid=false, form='rule' | 功能 | 规则形态拒绝 |
| content 为空 → valid=false, form='data' | 边界 | 空内容拒绝 |
| content <20字 → valid=false, form='data' | 边界 | 太短拒绝 |
| 无法判断的混合内容 → valid=true | 边界 | 宽容策略 |

### AC-B.2: extraction skill 形态判断

**测试方式**: Skill 文档审查（非代码测试）

验证方式:
- `grep "形态判断" ~/.studio/skills/knowledge-extraction/SKILL.md` 有结果
- 质量门 Step 2.5 含形态判断检查项

### AC-B.3: safeIngest 门禁集成

**测试文件**: `studio/apps/api/src/modules/agents/knowledge-agent.service.test.ts`

| 测试用例 | 类型 | 预期 |
|---------|------|------|
| safeIngest 知识形态 → 正常写入 | 功能 | 现有行为不变 |
| safeIngest 数据形态 → 写 data/ 不写 knowledge/ | 功能 | 数据重定向 |
| safeIngest skill 形态 → 跳过，记日志 | 功能 | 不写入 |
| safeIngest rule 形态 → 跳过，记日志 | 功能 | 不写入 |

### AC-C.1: cstnew 链路改造

**测试方式**: 集成测试（手动验证）

验证方式:
1. 执行 `cstnew` → `ls ~/.studio/data/sessions/` 有 JSONL 文件
2. `grep "extract-text" ~/transport/events-daemon.js` 无结果（已移除 POST）

### AC-C.2: SCHEDULE trigger

**测试文件**: `studio/apps/api/src/modules/agents/default-triggers.test.ts`（若存在）

| 测试用例 | 类型 | 预期 |
|---------|------|------|
| trigger 注册成功 | 功能 | registerTrigger 被调用 |
| trigger cron 为 '17 4 * * *' | 功能 | cron 配置正确 |
| trigger action 为 CREATE | 功能 | action.type='CREATE' |

---

## 执行顺序

### Phase 1: 数据层切断（AC-A.5 + AC-A.1~A.4）

```
Step 1: AC-A.5 — knowledgeBus @deprecated 注释
         文件: knowledge-bus.service.ts
         测试: grep 验证
         依赖: 无

Step 2: AC-A.1 + AC-A.2 — recordTrend/recordAnalystAccuracy 改写
         文件: knowledge-service.ts
         测试: knowledge-service.test.ts
         依赖: Step 1（确认不影响 singleton）
         可并行: AC-A.1 和 AC-A.2 同一文件，串行写

Step 3: AC-A.3 — precipitateRouting 改写
         文件: monitor-agent.service.ts
         测试: monitor-agent.service.test.ts
         依赖: 无（与 Step 2 可并行）

Step 4: AC-A.4 — signal-aggregator 改写
         文件: signal-aggregator.ts
         测试: signal-aggregator.test.ts
         依赖: 无（与 Step 2/3 可并行）
```

### Phase 2: 形态门禁（AC-B.1 + AC-B.3 + AC-B.2）

```
Step 5: AC-B.1 — validateKnowledgeForm() 函数
         文件: knowledge-service.ts
         测试: knowledge-service.test.ts
         依赖: 无

Step 6: AC-B.3 — safeIngest 集成门禁
         文件: knowledge-agent.service.ts
         测试: knowledge-agent.service.test.ts
         依赖: Step 5（需要 validateKnowledgeForm 存在）

Step 7: AC-B.2 — extraction skill 文档更新
         文件: ~/.studio/skills/knowledge-extraction/SKILL.md
         测试: grep 验证
         依赖: Step 5（需要了解门禁逻辑）
```

### Phase 3: cstnew + SCHEDULE（AC-C.1 + AC-C.2）

```
Step 8: AC-C.1a — cstnew 函数改写
         文件: ~/.zshrc
         测试: 手动验证
         依赖: 无

Step 9: AC-C.1b — events-daemon 改写
         文件: ~/transport/events-daemon.js
         测试: 手动验证
         依赖: Step 8（逻辑一致）

Step 10: AC-C.2 — SCHEDULE trigger 注册
          文件: default-triggers.ts
          测试: default-triggers.test.ts
          依赖: 无
```

---

## 里程碑

| 里程碑 | 完成标准 | 对应 AC |
|--------|---------|---------|
| M1: 数据切断 | recordTrend/Accuracy/Routing/Signal 全部写 data/，knowledgeBus @deprecated | AC-A.1~A.5 |
| M2: 门禁上线 | validateKnowledgeForm() 存在且 safeIngest 集成 | AC-B.1, AC-B.3 |
| M3: Skill 引导 | extraction skill 质量门含形态判断 | AC-B.2 |
| M4: 链路改造 | cstnew 写 data/sessions/，SCHEDULE trigger 注册 | AC-C.1, AC-C.2 |

---

## 风险评估

| 风险 | 影响 | 缓解 |
|------|------|------|
| writeTrendData 并发写入冲突 | 文件内容损坏 | MonitorAgent 单线程 + fs.writeFileSync 原子性足够 |
| safeIngest 门禁误拒正常知识 | 知识丢失 | 宽容策略（无法判断→通过）+ 日志可追溯 |
| events-daemon 改写影响 KE-003 行为蒸馏 | 行为数据丢失 | 保留 extract-behavior POST（如有） |
| cstnew 不再发 session:archive 事件 | 下游依赖断裂 | grep 确认无其他消费方 |
