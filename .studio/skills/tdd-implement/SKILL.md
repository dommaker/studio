---
name: tdd-implement
description: "读取 SDD 按 TDD 实现代码：先写 FAIL 测试（RED），再实现让测试通过（GREEN）。"
agentTypes: [implement, feature, bug, refactor]
triggers: [TDD, 按 SDD 实现, FAIL 测试, RED GREEN, tdd implement, 功能实现, 让测试通过, 增量类型检查, feature implementation]
status: published
---

# 按 SDD 实现（RED + GREEN）

读 SDD，写测试，写实现，让测试通过。一次探索，测试+实现一起搞定。

---

## 集成

上游：**sdd-review-skill**（PASS 的 SDD）或 **task-planner**（轻量 PLAN）。
输入：SDD 三层文档 或 轻量 PLAN（AC 列表 + 文件映射 + 测试规划）。
产出：实现代码 + 通过的测试。
下游：**code-review**（审查实现质量）。

---

## 硬门禁

<HARD-GATE>
必须先写 FAIL 测试（RED），确认测试失败后，才能写实现代码（GREEN）。禁止先写实现再补测试。每一行实现代码都必须有对应的 FAIL 测试要求其存在。

**纯删除任务例外**：当 AC 的所有改动都是"删除"（删 model、删 case、删 import、删函数、删端点、整文件删除）且无可行为变化的 RED 测试时，跳过 RED 阶段，直接进入 GREEN。GREEN 验证用：
1. `grep -r "<已删除符号>" --include="*.ts" --include="*.tsx"` 零残留（排除 migration 历史、node_modules）
2. `npx tsc --noEmit` 无新类型错误（预存在错误可接受但需确认非本次引入）
3. 现有测试不回归（运行相关测试文件，预存在 FAIL 可接受但需确认非本次引入）

纯删除任务识别标准：design.md 文件映射表中该 AC 的所有改动类型都是"删除 model"/"删除代码"/"整文件删除"/"删除 import"/"删除端点"/"删除 export"。无"新增"/"修改"改动。如果有任何"修改"改动（如"改调用"、"改参数"），不算纯删除任务，走正常 RED 流程。

不得修改 SDD 中定义的契约测试规格。如果测试规格有误，停下报告——测试是契约，你是实现者。

不得添加任何当前 FAIL 测试未要求的功能、函数或代码路径。如果发现自己在写"以防万一"的代码，停下并删除。
</HARD-GATE>

---

## 反模式：常见借口

| 借口 | 反驳 |
|------|------|
| "先写实现再补测试也一样" | 测试-after = "这个函数做了什么？" 测试-first = "这个函数应该做什么？" 方向相反。 |
| "我先加这个以防万一" | "以防万一"的代码 = 未测试的代码 = 未来的 bug。YAGNI。 |
| "以后可能用到" | 以后 = 永远不。需要时再写，现在只写测试要求的。 |
| "测试规格有误，我改一下" | 停下报告。测试是契约，实现者无权修改。 |
| "这个函数应该更通用" | 通用 = 复杂。测试要具体，实现也具体。抽象等重构时做。 |
| "并行太复杂，串行更安全" | 依赖分析 5 秒，串行执行 5 分钟。先分析再决定。 |
| "全量类型检查更快" | 大项目全量 tsc 可能要 30 秒。增量检查只看改过的文件。 |
| "等全部做完再提交" | 5 个 Phase 做完出问题 → 全部白费。每 Phase 提交 = 最多丢一个 Phase。HARD-GATE 阻断。 |
| "先做下一 Phase 回头补提交" | commit 是实现步骤的一部分，不是事后操作。Phase N 未 commit → Phase N+1 不开始。 |

**危险信号**：
- 先写实现再写测试
- 修改了测试文件
- 添加了测试未要求的功能
- 跳过依赖分析直接串行实现
- 全量 tsc 而不是增量检查

---

## 执行流程

### ⓪ 分支准备（HARD-GATE）

**禁止在 master/main 上直接实现。** 所有实现工作必须在 feature 分支上进行。

```
1. 检查当前分支：git branch --show-current
2. 如果是 master 或 main → 创建 feature 分支
3. 如果已在 feature 分支 → 跳过

分支命名规则：
- 有 SDD → feat/<SDD-slug>（如 feat/spec-2b-data-migration）
- 轻量 PLAN → feat/<任务关键词>（短横线连接，如 feat/fix-auth-bug）
- 不确定 → feat/<YYYYMMDD>-<随机4字符>
```

```
# 创建并切换分支
git checkout -b feat/<slug>
```

<HARD-GATE>
实现任何代码之前，必须确认当前不在 master/main 上。如果在 → 先创建分支。不创建分支 = 不开始实现。
</HARD-GATE>

后续所有 git commit 都在此分支上进行。studio-ship 直接从此分支推送 + 创建 PR，无需额外操作。

### ① 读取输入 + 建 task 跟踪

读取输入，自动适配格式：

```
完整 SDD（requirement.md + design.md + task.md）:
    → 读 AC 定义、文件映射、依赖 DAG、测试规划、执行顺序
    → 创建 task 跟踪（TaskCreate）

轻量 PLAN（AC 列表 + 文件映射 + 测试规划）:
    → 直接用 PLAN 内容，无依赖 DAG 默认串行
    → task 跟踪可选
```

```
# 读取 SDD 后，为每个 AC 创建 task
TaskCreate(subject="AC1: isSimpleChange totalLines > 20 → false", description="RED: 写 FAIL 测试 | GREEN: 实现 totalLines 检查")
TaskCreate(subject="AC2: 保留现有行为", description="RED: 测试现有行为不变 | GREEN: 不需额外实现")
TaskCreate(subject="AC3: 边界值测试", description="RED: <=20 通过, >20 失败, 边界 20 | GREEN: 随 AC1 一起实现")

# RED 阶段：写完 FAIL 测试后更新
TaskUpdate(taskId="AC1", status="in_progress")  # RED ✅

# GREEN 阶段：实现后更新
TaskUpdate(taskId="AC1", status="completed")     # GREEN ✅
```

### ② RED：写 FAIL 测试

**先看现有测试结构**：读测试目录，确认测试文件命名约定、放哪里、怎么组织。

**纯删除任务识别**：检查 design.md 文件映射表，如果该 AC 的所有改动类型都是"删除"（无"新增"/"修改"），标记为纯删除任务。

- 纯删除任务 -> 跳过 RED，直接进入 GREEN。GREEN 验证用 grep + tsc + 现有测试不回归（见 HARD-GATE 纯删除任务例外）
- 非纯删除任务 -> 按下方流程写 FAIL 测试

按 task.md 的契约测试规划，为每个 AC 写 FAIL 测试：

```
对每个 AC Group：
  创建/修改测试文件（遵循现有测试结构）
  按 AC 写 it() 块（正向 + 边界 + 异常）
  运行测试 → 确认 FAIL
  TaskUpdate(taskId="AC-x", status="in_progress")  # RED ✅
```

**验证**：`pnpm test` 有 failures，且 failures 对应刚写的测试。

### ③ 依赖分析

从 design.md 的代码依赖 DAG 中提取：
- 哪些文件独立（无相互依赖）→ 可并行实现
- 哪些文件有依赖 → 按 DAG 层序串行

### ④ GREEN：并行/串行实现

**读取就绪度判定**：从 task.md 的 `## Implementation Readiness` 节读取 `implementationReady` 值。
- `true` -> 实现路径明确，调用 parallel-execution 时指定轻量模型层级
- `false` -> 使用 CLI 默认模型设置

```
独立文件 → parallel-execution 并行实现
  对每个独立文件：
    读接口定义 → 按签名实现 → 让对应测试通过

有依赖文件 → 按 DAG 层序串行
  先实现底层模块 → 再实现上层模块
```

每个文件的实现步骤：
1. 读 design.md 中的接口定义（函数签名、参数、返回值）
2. 最小实现 → 让对应 FAIL 测试通过
3. 不加多余功能
4. TaskUpdate(taskId="AC-x", status="completed")  # GREEN ✅

**Phase 间提交（HARD-GATE）**：task.md 的 Execution Order 通常分为多个 Phase。每完成一个 Phase：

<HARD-GATE>
Phase N 完成后，必须执行以下步骤才能进入 Phase N+1：

1. 运行该 Phase 涉及的测试 → 确认 PASS
2. 增量类型检查（只检查本 Phase 修改的文件）：
   npx tsc --noEmit <本 Phase 修改的文件路径>
3. git add <本 Phase 的文件> && git commit -m "feat(scope): Phase N — AC-x 完成"

不 commit = 不进下一 Phase。无例外。
</HARD-GATE>

禁止等所有 Phase 做完再统一提交。每 Phase 一个 commit = 可回滚 + 可审查 + 进度可见。一次 Phase 失败最多丢一个 Phase 的工作。

**destructive Phase 确认**：进入 Phase N+1 前，检查 task.md 的风险标注。如果 Phase N+1 标记 `[destructive]`（删表/删文件/改 schema）→ 列出破坏性操作清单 → **等待用户显式确认**后才能进入。破坏性风险由 design-analyst 在决策阶段识别，task-planner 在 task.md 中标注，tdd-implement 做最后一道兜底确认——不替代前置曝光，只确认用户已知情。

### ⑤ 全量验证

```
pnpm test → 确认全部 PASS + 无回归
```

如果有 FAIL：
- 是实现问题 → 修复实现（不改测试）
- 是测试规格问题 → 停下报告

### ⑥ 增量类型检查（最终）

```
只检查本次修改的文件：
  npx tsc --noEmit <所有本次修改的文件路径>
```

不跑全量 `tsc --noEmit`（大项目太慢）。Phase 间已检查过的文件可跳过。

### ⑦ 更新 SDD status

全量验证 + 类型检查通过后，更新 SDD 三层文档的 frontmatter status 为 `done`：

```
docs/sdd/<slug>/{requirement,design,task}.md
  frontmatter.status: "done"
```

原因：SDD 是 Agent 搜索的文档源。status 不准 = 噪音。tdd-implement 是实现发生的环节，由实现者更新 status 最可靠——不依赖后续 code-review 是否执行。

如果没有 SDD（bug fix / 简单改动走了快捷路径），跳过此步。

---

## 并行实现规则

调用 parallel-execution Skill 执行并行实现：

```
输入：design.md 的依赖 DAG
规则：
  - 同层独立文件 → 并行 agent
  - 不同层文件 → 按层序串行
  - 有文件冲突的 → 不并行
  - implementationReady=true → 传递轻量模型层级给 parallel-execution
  - implementationReady=false → 使用 CLI 默认模型设置（不传递轻量模型层级）
产出：所有文件实现完成，测试 PASS
```

---

## 约束

| 允许 | 禁止 |
|------|------|
| 在 AC 文件范围内新增代码 | 改测试文件 |
| 按 design.md 接口定义实现 | 改 AC 范围外的文件 |
| 按依赖 DAG 并行实现 | 跳过依赖分析直接串行 |
| 测试规格有误时停下报告 | 自行修改契约测试 |

---

## 自检

自检修复最多 3 轮。超过 3 轮仍未全部通过 → 停下报告，不继续循环。不 invoke 下游。

| # | 检查项 | 通过标准 | 不通过动作 |
|---|--------|---------|-----------|
| 1 | 分支检查 | `git branch --show-current` 不是 master/main | 退回 ⓪，创建分支后重新开始 |
| 2 | 测试全部 PASS | `pnpm test` 0 failures | 修复实现（不改测试） |
| 3 | 无回归 | 相关模块测试不挂 | 排查影响面 |
| 4 | 增量类型检查 | 修改文件 tsc 无错误 | 修复类型问题 |
| 5 | 范围边界 | 未改 AC 范围外文件 | 撤回越界改动 |
| 6 | 测试文件未修改 | `git diff <测试文件>` 为空 | 撤回对测试文件的改动 |
| 7 | 并行执行 | 独立文件已并行实现（如有） | 补充并行执行 |
| 8 | AC 覆盖 | 每条 AC 有对应实现 + 通过测试 | 补充缺失覆盖 |
| 9 | Phase 间提交 | 每个 Phase 完成后有独立 commit（HARD-GATE） | 停下，补提交后才能进下一 Phase |
| 10 | destructive 确认 | `[destructive]` Phase 已显式确认后再执行 | 停下，提示用户确认破坏性操作 |
| 11 | SDD status 更新 | SDD frontmatter status = `done`（无 SDD 则跳过） | 补更新 status |
| 12 | 纯删除任务验证 | 纯删除任务有 grep 零残留 + tsc 无新错误 + 现有测试不回归 | 补充验证 |
| 13 | 工作区干净 | `git status --short` 无输出（无未提交变更） | 停下，确认无遗漏文件后提交 |
| 14 | 下游路由 | 全部 Phase 完成后 invoke code-review（禁止输出总结后直接结束） | 停下，invoke code-review |

全部通过后进入终端状态。

---

## 终端状态

<HARD-GATE>
Phase 间的 commit 已在 ④ 中完成。全部 Phase 完成 + 全量测试 PASS + 类型检查通过后，**必须 invoke code-review**。禁止在 invoke code-review 之前输出"完成总结"或"全部完成"。

跳过此步 = 绕过了草台班子最后的质量门。code-review 是硬门禁，不是可选项。
</HARD-GATE>

自检 #13 通过后，确认以下状态再 invoke code-review：

1. `git status --short` 无输出（工作区干净，所有变更已提交）
2. `git log --oneline -N`（N=Phase 数）确认每个 Phase 有独立 commit
3. 确认后 **invoke code-review**（不得在此步骤之前输出含"完成/结果/总结"的关闭语）

状态不对 → 先补齐提交，再 invoke。
