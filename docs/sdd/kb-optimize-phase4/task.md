---
status: done
version: "1.0"
---

# Phase 4 消费闭环 — 任务

## 契约测试规划

### AC-1: 消费追踪管线修复

**测试文件**: `studio/apps/api/src/modules/agents/agent-loop.test.ts`

| 测试用例 | 类型 | 预期 |
|---------|------|------|
| extractKnowledgeEntryIds 从 Read 调用提取文件名 | 功能 | 返回 ['decision-DEC-001'] |
| extractKnowledgeEntryIds 从 Bash grep 调用提取文件名 | 功能 | 返回 ['pattern-xxx'] |
| extractKnowledgeEntryIds 排除 _index.md | 边界 | 不返回 '_index' |
| extractKnowledgeEntryIds 去重 | 边界 | 相同文件多次访问只返回一次 |
| execute() 检测到知识搜索后调用 recordConsumption | 集成 | knowledgeService.recordConsumption 被调用 |
| execute() 未检测到知识搜索不调 recordConsumption | 边界 | recordConsumption 不被调用 |
| recordConsumption 抛异常不阻断 WorkUnit | 异常 | WorkUnit 仍标记成功 |

### AC-2: 零消费审查 trigger

**测试文件**: `studio/apps/api/src/modules/agents/default-triggers.test.ts`

| 测试用例 | 类型 | 预期 |
|---------|------|------|
| trigger 注册成功 | 功能 | registerTrigger 被调用 |
| trigger cron 为 '17 5 * * *' | 功能 | cron 配置正确 |
| trigger action 为 CREATE | 功能 | action.type='CREATE' |

### AC-3: knowledge-synthesis trigger

**测试文件**: `studio/apps/api/src/modules/agents/default-triggers.test.ts`

| 测试用例 | 类型 | 预期 |
|---------|------|------|
| trigger 注册成功 | 功能 | registerTrigger 被调用 |
| trigger cron 为 '23 10 * * 1' | 功能 | cron 配置正确 |
| trigger scope 包含 knowledge-synthesis-skill | 功能 | payload.scope 含关键词 |

### AC-4: 废弃 knowledge-skill-evolver

**测试方式**: grep 验证

验证方式:
- `grep -r "knowledge-skill-evolver" studio/apps/` 无结果（除 git 历史）
- 文件不存在

---

## 执行顺序

### Phase 1: 删除死代码（AC-4）

```
Step 1: AC-4 — 删除 knowledge-skill-evolver.ts + 测试
         文件: knowledge-skill-evolver.ts, knowledge-skill-evolver.test.ts
         测试: grep 验证
         依赖: 无
```

### Phase 2: 消费追踪修复（AC-1）

```
Step 2: AC-1 — agent-loop.ts 增强
         文件: agent-loop.ts, agent-loop.test.ts
         测试: agent-loop.test.ts
         依赖: 无（与 Step 1 可并行）
```

### Phase 3: SCHEDULE triggers（AC-2 + AC-3）

```
Step 3: AC-2 + AC-3 — default-triggers.ts 新增 2 个 trigger
         文件: default-triggers.ts, default-triggers.test.ts
         测试: default-triggers.test.ts
         依赖: 无（与 Step 1/2 可并行）
```

---

## 里程碑

| 里程碑 | 完成标准 | 对应 AC |
|--------|---------|---------|
| M1: 死代码清除 | evolver 文件删除，grep 无引用 | AC-4 |
| M2: 消费追踪上线 | execute() 检测到搜索后调 recordConsumption | AC-1 |
| M3: 定时任务就绪 | 2 个新 trigger 注册，测试通过 | AC-2, AC-3 |

---

## 风险评估

| 风险 | 影响 | 缓解 |
|------|------|------|
| extractKnowledgeEntryIds 解析失败 | 消费数据不完整 | 宽容策略：解析失败跳过，不阻断 |
| recordConsumption 并发写入冲突 | referencedBy 数据损坏 | lifecycle 已有去重/cap 逻辑 |
| 新 trigger 与现有 trigger 冲突 | 重复创建 WorkUnit | trigger ID 唯一，registry 去重 |
