---
slug: knowledge-context-boundary
title: 知识上下文边界 — 注入模型 + 质量控制 + Skill 路径修复
status: draft
createdAt: 2026-07-13
---

## 实现步骤

### Step 1: injectContext 返回类型变更 + 消费端适配

**依赖**：无

**改动**：
- `knowledge-service.ts`：injectContext 返回 `Promise<{ prompt: string; injectedIds: string[] }>`
- `review-agent.service.ts` L85/L501：`.prompt` 属性访问
- `knowledge-service.routes.ts` L210：`.prompt` 属性访问

**接口变更**：

```typescript
// knowledge-service.ts
interface InjectContextResult {
  prompt: string;
  injectedIds: string[];   // 被注入的知识条目 ID 列表
}

async injectContext(taskScope: string): Promise<InjectContextResult>
```

**完成标准**：
- [ ] 类型定义新增 `InjectContextResult`
- [ ] injectContext 编译通过
- [ ] 3 处调用方全部适配 `.prompt`
- [ ] 类型检查无错误

---

### Step 2: 消费端质量门

**依赖**：Step 1

**改动**（均在 `knowledge-service.ts` `query.queryEntries` 查询和结果处理）：

1. 查询条件加 `status: 'published'`
2. 结果过滤：`entry.sourceReference` 非空
3. 结果过滤：`entry.status !== 'stale'`

**完成标准**：
- [ ] 注入的知识条目只包含 published 状态
- [ ] 无 sourceReference 的条目不注入
- [ ] stale 条目不注入
- [ ] injectContext 返回的 `injectedIds` 只包含实际注入的条目 ID

---

### Step 3: 生产端质量门

**依赖**：无（与 Step 1/2 独立，但注入逻辑在 extractFromExecution）

**改动**（均在 `knowledge-service.ts` `extractFromExecution`）：

1. 入口检查 `result.success`：失败时 `status='need_review'` 写入
2. 写入参数增加 `sourceExecutionId` 字段
3. 写入前查询已有同主题 published 条目——存在则合并而非新增

**完成标准**：
- [ ] 执行失败时知识条目标记 `need_review`
- [ ] 知识条目可回溯到源 execution
- [ ] 同主题知识不重复创建（合并逻辑）

---

### Step 4: GAP-8 Skill 路径修复

**依赖**：无

**改动**：

1. `extractUserBehavior`：写入路径改为 `~/.studio/skills/<name>/SKILL.md`

```typescript
// 当前
const SKILLS_DIR = path.join(os.homedir(), '.studio', 'knowledge', 'skills');
// 修复后
const SKILLS_DIR = path.join(os.homedir(), '.studio', 'skills');
```

2. `skillLoader`：确认能发现 `~/.studio/skills/<name>/SKILL.md`（当前路径不变，验证兼容性）

3. 数据迁移：`~/.studio/knowledge/skills/` → `~/.studio/skills/`

**完成标准**：
- [ ] extractUserBehavior 写入路径改为 `~/.studio/skills/<name>/SKILL.md`
- [ ] skillLoader 能加载新路径下写入的 SKILL.md
- [ ] 旧路径下已有 skills 迁移到 `~/.studio/skills/`（迁移后旧路径可删除）
- [ ] 类型检查无错误

---

### Step 5: buildAgentContext 删除

**依赖**：Step 1（确认无调用方依赖知识注入功能）

**改动**：
- 删除 `agent-context.ts` 中的 `buildAgentContext()` 函数
- 保留 `agent-context.ts` 中其他可能存在的工具函数
- grep 全局确认零引用

**完成标准**：
- [ ] `buildAgentContext` 函数定义已删除
- [ ] `grep -r "buildAgentContext"` 零结果
- [ ] 类型检查无错误

---

### Step 6: Rules 治理文档更新

**依赖**：无

**改动**：
- 治理文档新增 rule 定义（AC-4.1）
- 新增退出机制文档（AC-4.2）
- 实现时对现有 rule 执行初始"删除测试"（AC-4.3）

**完成标准**：
- [ ] 治理文档包含"违反后果"测试流程
- [ ] 治理文档包含四种退出条件
- [ ] 初始审查执行记录

## 关键接口定义汇总

| 接口 | 变更类型 | 当前 | 变更后 |
|------|---------|------|--------|
| `injectContext(taskScope)` | 返回类型 | `Promise<string>` | `Promise<{prompt: string; injectedIds: string[]}>` |
| `extractFromExecution(result)` | 质量门 | 仅检查 diff 非空 | + success flag 检查 + sourceExecutionId + 去重 |
| `SKILLS_DIR` 常量 | 路径 | `~/.studio/knowledge/skills` | `~/.studio/skills` |
| `buildAgentContext()` | 删除 | 壳抽象函数 | 删除 |

## 依赖图

```
Step 1 (返回类型变更) ─┬─→ Step 2 (消费端质量门)
                       │
                       └─→ Step 5 (buildAgentContext 删除，确认零调用)

Step 3 (生产端质量门) ─── 独立

Step 4 (GAP-8 路径) ───── 独立

Step 6 (Rules 治理) ───── 独立
```
