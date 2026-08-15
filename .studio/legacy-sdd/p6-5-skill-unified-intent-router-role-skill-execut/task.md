---
id: "sdd-1782727295429-rhfe1e"
goalId: "cmqa9daiy004dez3d7ldp5qbx"
slug: "p6-5-skill-unified-intent-router-role-skill-execut"
title: "P6.5 Skill 统一：intent-router + Role→Skill 绑定接入 executor"
status: "done"
version: 8
taskVersion: 8
parentId: "sdd-1782462832104-19jqa8"
changeType: "L2"
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["P6.5", "skill-unified", "intent-router", "role-skill-binding", "executor"]
createdAt: "2026-06-12T01:39:06.906Z"
updatedAt: "2026-06-29T10:01:35.429Z"
---

# P6.5 Skill 统一：intent-router + Role→Skill 绑定接入 executor

创建 intent-router 意图路由模块，将 Role→Skill 绑定（boundSkills）接入 scheduler-dispatch executor 流程

<!-- TASK_TIER {"tier":"fast","reason":"用户要求单 acGroup；两个子任务（intent-router 纯函数 + dispatch 接入）互不依赖，可单 session 完成"} -->

## Contract Tests

### packages/studio-skill/src/__tests__/intent-router.test.ts
```typescript
import { describe, it, expect } from 'vitest';
import { matchIntent } from '../intent-router.js';
import type { SkillDefinition } from '../types.js';

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    description: 'A test skill',
    trigger: 'always',
    agentTypes: ['executor'],
    tier: 'standard',
    prompt: 'test prompt',
    ...overrides,
  };
}

describe('matchIntent', () => {
  it('returns skills whose intent keywords match the message', () => {
    const skills = [
      makeSkill({ id: 'tdd', triggers: { intent: ['test', 'tdd', 'refactor'] } }),
      makeSkill({ id: 'deploy', triggers: { intent: ['deploy', 'release'] } }),
    ];
    const result = matchIntent('write a test for this function', skills);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('tdd');
  });

  it('returns empty array when no keywords match', () => {
    const skills = [
      makeSkill({ id: 'tdd', triggers: { intent: ['test', 'tdd'] } }),
    ];
    const result = matchIntent('deploy the application', skills);
    expect(result).toHaveLength(0);
  });

  it('skips skills without triggers.intent', () => {
    const skills = [
      makeSkill({ id: 'no-intent' }),
      makeSkill({ id: 'has-intent', triggers: { intent: ['test'] } }),
    ];
    const result = matchIntent('write a test', skills);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('has-intent');
  });

  it('matches case-insensitively', () => {
    const skills = [
      makeSkill({ id: 'tdd', triggers: { intent: ['Test', 'TDD'] } }),
    ];
    const result = matchIntent('write a TEST', skills);
    expect(result).toHaveLength(1);
  });

  it('returns empty array for empty message', () => {
    const skills = [
      makeSkill({ id: 'tdd', triggers: { intent: ['test'] } }),
    ];
    const result = matchIntent('', skills);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty skills list', () => {
    const result = matchIntent('test', []);
    expect(result).toHaveLength(0);
  });
});

```