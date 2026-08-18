---
name: migration-execution-skill
description: "执行大规模、跨文件的代码库增量迁移（Round 分解 → 转换 → 验证 → 级联修复）。"
agentTypes: [refactor, implement]
triggers: [大规模迁移, 增量迁移, codebase migration, 数据库替换, API 升级, mock 框架切换, 异步改造, 基础设施迁移, 级联修复]
status: published
---

## 核心原则

增量迁移。每轮有界，验证通过再进下一轮。不一次性改所有文件。

---

## 硬门禁

<HARD-GATE>
Round 分解完成前不得开始第一轮修改。

验证阶段用 `grep` 确认旧模式清零（不凭"我记得"）。每轮必须通过类型检查才能进入下一轮。

剩余项必须显式记录在列表中。模糊的"还有一些没改"=没完成。
</HARD-GATE>

---

## 执行流程

### Phase 1: Scope Mapping
识别迁移范围:
- `grep -r "旧模式" src/` 统计所有引用，列出受影响文件
- 按依赖关系分组: 核心工具 → 中间层 → 表层消费者
- 标记不可迁移的例外（第三方依赖、外部 API）

### Phase 2: Round Decomposition
拆为多轮，每轮有:
- **文件列表**: 明确哪些文件归属本轮
- **转换配方**: 一条可重复的规则（如 `prisma.model.findMany` → `store.readJsonl<Type>()`）
- **验证标准**: 类型检查通过 + 关键测试通过
- **不依赖未被迁移的下游**: 依赖链从底层往上层走

### Phase 3: Per-Round Execution
对每轮执行:
1. 按配方转换文件
2. `npx tsc --noEmit` 类型检查
3. 修复本轮的级联类型错误（不修下一轮的）
4. `pnpm test -- --changed` 跑受影响测试
5. 标记本轮完成

### Phase 4: Cascade Repair
每轮完成后可能在下游产生断裂:
- 类型错误: 编译器自动捕获
- 运行时错误: 测试捕获
- 只修本轮造成的断裂，不提前修后续轮次

### Phase 5: Closure Audit
- `grep -r "旧模式" src/` 确认清零
- 验证所有依赖方已适配新接口
- 更新知识库（如有 lessons learned）

## 反模式

- ❌ 一次性改所有文件 → 无法定位哪轮引入 bug
- ❌ 不追踪剩余 → 不知道何时完成，遗漏文件
- ❌ 跳过类型检查直接跑测试 → 类型错误混在测试失败中增加诊断成本
- ❌ 在一轮中同时改底层 + 修上游 → 问题定位困难
- ❌ 剩余项模糊描述（"一些""大部分"）→ 必须逐文件列出

## 自检

迁移完成后逐项检查:
- [ ] grep 旧模式: 清零
- [ ] 类型检查: `npx tsc --noEmit` 通过
- [ ] 测试: `pnpm test` 全部通过
- [ ] 剩余清单: 已关闭或已转移
- [ ] 知识库: 已记录迁移过程中的 lessons learned

---

## 四条目汇聚证据

本 Skill 从以下 4 条知识条目中提取共同模式:

| 条目 | 迁移类型 | 规模 | Round 数 |
|------|---------|------|---------|
| CLUSTER-DB-REMOVAL | Prisma→FileStore | 30+ 文件, 59+ 调用 | 4 |
| CLUSTER-SPEC4 | Mock+async 迁移 | 15+ 文件 | 3 |
| CLUSTER-TEST-INFRA | 类型+测试适配 | 27 测试, 8 文件 | 2 |
| CLUSTER-CI | pnpm/vitest 配置 | 22 次迭代 | 5 组 |

共同模式: 每次迁移都经历了 scope mapping → round decomposition → 执行 → 验证 → cascade repair → closure audit 的完整循环。
