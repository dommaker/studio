---
status: done
version: "1.0"
---

# Phase 4 消费闭环 — 设计

## 文件映射

| AC | 文件 | 改动类型 |
|----|------|---------|
| AC-1 | `apps/api/src/modules/agents/agent-loop.ts` | 修改 execute() |
| AC-2 | `apps/api/src/modules/agents/default-triggers.ts` | 新增 trigger |
| AC-3 | `apps/api/src/modules/agents/default-triggers.ts` | 新增 trigger |
| AC-4 | `apps/api/src/modules/knowledge/knowledge-skill-evolver.ts` | 删除 |
| AC-4 | `apps/api/src/modules/knowledge/__tests__/knowledge-skill-evolver.test.ts` | 删除 |

## 代码依赖图

```
AC-1:
  agent-loop.ts execute()
    → analyzeKnowledgeSearchFromLog() → KnowledgeSearchAnalysis.searchCalls
    → 新增: extractKnowledgeEntryIds(searchCalls) → string[]
    → 新增: knowledgeService.recordConsumption(entryIds, workUnit.id)

AC-2/3:
  default-triggers.ts
    → registry.registerTrigger() (已有模式)

AC-4:
  knowledge-skill-evolver.ts → 删除
  knowledge-skill-evolver.test.ts → 删除
  无 import 依赖（已 grep 确认）
```

## 接口定义

### AC-1: extractKnowledgeEntryIds

```typescript
// agent-loop.ts 内新增 private 方法
private extractKnowledgeEntryIds(analysis: KnowledgeSearchAnalysis): string[] {
  const ids: string[] = [];
  for (const call of analysis.searchCalls) {
    if (!call.detail) continue;
    // 从 detail 中提取文件路径
    // Read detail: 文件路径如 "/root/.studio/knowledge/decision-DEC-001.md"
    // Bash detail: grep 命令含文件路径
    // Glob detail: 匹配模式如 "*.md" in knowledge dir
    const match = call.detail.match(/\.studio\/knowledge\/([^/\s]+\.md)/);
    if (match) {
      const filename = match[1];
      // 排除 _index.md
      if (filename !== '_index.md') {
        ids.push(filename.replace(/\.md$/, ''));
      }
    }
  }
  return [...new Set(ids)]; // 去重
}
```

### AC-1: execute() 修改

```typescript
// 在 execute() 中 analyzeKnowledgeSearchFromLog 调用后新增：
if (analysis.searched) {
  const entryIds = this.extractKnowledgeEntryIds(analysis);
  if (entryIds.length > 0) {
    try {
      const { knowledgeService } = await import('../knowledge/knowledge-service.js');
      knowledgeService.recordConsumption(entryIds, `workUnit:${workUnit.id}`);
    } catch (err) {
      logger.debug(`[AgentLoop] Failed to record knowledge consumption: ${err}`);
    }
  }
}
```

### AC-2: zero-consumption-audit trigger

```typescript
registry.registerTrigger({
  id: 'zero-consumption-audit',
  name: 'Daily zero-consumption knowledge audit',
  condition: { type: 'SCHEDULE', cron: '17 5 * * *' },
  action: {
    type: 'CREATE',
    target: 'WorkUnit',
    payload: {
      type: 'analysis',
      scope: 'Scan ~/.studio/knowledge/ for entries with empty referencedBy. Output audit report to ~/.studio/data/knowledge-consumption-audit.md with entry list, creation dates, and recommendations (keep/archive).',
    },
  },
  enabled: true,
  scope: 'system',
});
```

### AC-3: knowledge-synthesis trigger

```typescript
registry.registerTrigger({
  id: 'knowledge-synthesis',
  name: 'Weekly knowledge synthesis and Skill proposal',
  condition: { type: 'SCHEDULE', cron: '23 10 * * 1' },
  action: {
    type: 'CREATE',
    target: 'WorkUnit',
    payload: {
      type: 'analysis',
      scope: 'Execute knowledge-synthesis-skill: scan recent knowledge entries for semantic patterns. If 3+ entries share a underlying pattern, propose a new Skill via skill-creator.',
    },
  },
  enabled: true,
  scope: 'system',
});
```

## 约束

- AC-1 的 recordConsumption 调用必须 non-blocking（try/catch，失败只记 debug log）
- AC-2/3 的 trigger 注册模式与现有 trigger 一致
- AC-4 删除前必须 grep 确认无 import
