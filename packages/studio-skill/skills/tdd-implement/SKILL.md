---
name: tdd-implement
description: "按工单 AC 以 TDD 实现代码：先写 FAIL 测试（RED），再实现让测试通过（GREEN），Phase 提交。"
agentTypes: [implement, feature, bug, refactor]
triggers: [实现, TDD, 编码, 按工单实现, FAIL 测试, RED GREEN, tdd implement, 功能实现, 让测试通过, 增量类型检查, feature implementation]
status: published
---

# 按工单实现（RED + GREEN）

读工单（端到端行为 + AC），写测试，写实现，让测试通过。

---

## 集成

上游：**to-tickets** 产出的子工单，或直接指派的 implement 工单。
输入：工单（What to build + AC + 可能的原型片段/决策记录）。
产出：实现代码 + 通过的测试 + Phase commit 序列（实现 commit 引用先行测试 commit sha）。

---

## 硬门禁

<HARD-GATE>
必须先写 FAIL 测试（RED），确认测试失败后，才能写实现代码（GREEN）。禁止先写实现再补测试。每一行实现代码都必须有对应的 FAIL 测试要求其存在。

**纯删除任务例外**：当工单 AC 的所有改动都是"删除"（删 model、删 case、删 import、删函数、删端点、整文件删除）且无可行为变化的 RED 测试时，跳过 RED 阶段，直接进入 GREEN。GREEN 验证用：
1. `grep -r "<已删除符号>" --include="*.ts" --include="*.tsx"` 零残留（排除 migration 历史、node_modules）
2. `npx tsc --noEmit` 无新类型错误（预存在错误可接受但需确认非本次引入）
3. 现有测试不回归（运行相关测试文件，预存在 FAIL 可接受但需确认非本次引入）

纯删除任务识别标准：该工单所有 AC 的改动类型都是删除，无"新增"/"修改"。如果有任何"修改"改动（如"改调用"、"改参数"），不算纯删除任务，走正常 RED 流程。

AC 是契约。不得偏离工单 AC 实现；AC 有误或有歧义 → 停下报告，不自作主张改需求。

不得添加任何当前 FAIL 测试未要求的功能、函数或代码路径。如果发现自己在写"以防万一"的代码，停下并删除。
</HARD-GATE>

---

## 反模式：常见借口

| 借口 | 反驳 |
|------|------|
| "先写实现再补测试也一样" | 测试-after = "这个函数做了什么？" 测试-first = "这个函数应该做什么？" 方向相反。 |
| "我先加这个以防万一" | "以防万一"的代码 = 未测试的代码 = 未来的 bug。YAGNI。 |
| "以后可能用到" | 以后 = 永远不。需要时再写，现在只写测试要求的。 |
| "AC 有误，我改一下需求" | 停下报告。AC 是契约，实现者无权修改。 |
| "这个函数应该更通用" | 通用 = 复杂。测试要具体，实现也具体。抽象等重构时做。 |
| "并行太复杂，串行更安全" | 依赖分析 5 秒，串行执行 5 分钟。先分析再决定。 |
| "全量类型检查更快" | 大项目全量 tsc 可能要 30 秒。增量检查只看改过的文件。 |
| "等全部做完再提交" | 5 个 Phase 做完出问题 → 全部白费。每 Phase 提交 = 最多丢一个 Phase。HARD-GATE 阻断。 |
| "先做下一 Phase 回头补提交" | commit 是实现步骤的一部分，不是事后操作。Phase N 未 commit → Phase N+1 不开始。 |

**危险信号**：
- 先写实现再写测试
- 实现后回头改测试让它过
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
- 有工单号 → feat/<工单号>-<关键词>（如 feat/123-skill-batch）
- 无工单号 → feat/<任务关键词>（短横线连接，如 feat/fix-auth-bug）
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

读取工单全文（What to build + 验收 AC + 关联上下文）：

```
- 提取每条 AC：触发条件、预期行为、边界、不做项
- 工单附原型片段/决策记录 → 以其为准（那是已固化的决策，不是参考）
- 为每条 AC 创建 task 跟踪（TaskCreate）
```

**探索是实现的一部分**：没有上下文地图工件，实现者自行读代码定位。探索收敛后开工；发现与工单描述明显不符的现状 → 停下报告，不静默改需求。

```
TaskCreate(subject="AC1: ...", description="RED: 写 FAIL 测试 | GREEN: 实现 ...")

# RED 阶段：写完 FAIL 测试后更新
TaskUpdate(taskId="AC1", status="in_progress")  # RED ✅

# GREEN 阶段：实现后更新
TaskUpdate(taskId="AC1", status="completed")     # GREEN ✅
```

### ② RED：写 FAIL 测试

**先看现有测试结构**：读测试目录，确认测试文件命名约定、放哪里、怎么组织。

**纯删除任务识别**：如果该工单所有 AC 的改动类型都是"删除"（无"新增"/"修改"），标记为纯删除任务。

- 纯删除任务 -> 跳过 RED，直接进入 GREEN。GREEN 验证用 grep + tsc + 现有测试不回归（见 HARD-GATE 纯删除任务例外）
- 非纯删除任务 -> 按下方流程写 FAIL 测试

按工单 AC 为每条 AC 写 FAIL 测试：

```
对每个 AC：
  创建/修改测试文件（遵循现有测试结构）
  按 AC 写 it() 块（正向 + 边界 + 异常）
  运行测试 → 确认 FAIL
  TaskUpdate(taskId="AC-x", status="in_progress")  # RED ✅
```

**验证**：`pnpm test` 有 failures，且 failures 对应刚写的测试。

### ③ 依赖分析

对本次涉及的文件做依赖分析：

- 提取每个文件的 imports/调用关系
- 哪些文件独立（无相互依赖）→ 可并行实现
- 哪些文件有依赖 → 按依赖层序串行

### ④ GREEN：并行/串行实现

```
独立文件 → parallel-execution 并行实现
  对每个独立文件：
    按 AC 实现 → 让对应测试通过

有依赖文件 → 按依赖层序串行
  先实现底层模块 → 再实现上层模块
```

每个文件的实现步骤：
1. 最小实现 → 让对应 FAIL 测试通过
2. 不加多余功能
3. TaskUpdate(taskId="AC-x", status="completed")  # GREEN ✅

**Phase 间提交（HARD-GATE）**：把工单分成若干 Phase（通常按 AC 组）。每完成一个 Phase 产生**两个 commit**——先测试后实现，实现 commit 引用测试 commit sha（TDD 引用链，机器可验）：

<HARD-GATE>
Phase N 完成后，必须执行以下步骤才能进入 Phase N+1：

1. 运行该 Phase 涉及的测试 → 确认 PASS
2. 增量类型检查（只检查本 Phase 修改的文件）：
   npx tsc --noEmit <本 Phase 修改的文件路径>
3. 测试 commit：`git add <测试文件> && git commit -m "test(scope): Phase N — AC-x 先行测试"`（RED 阶段写完测试即可先提；最迟在实现 commit 之前）
4. 实现 commit：`git add <实现文件> && git commit -m "feat(scope): Phase N — AC-x 完成 (tests: <测试commit-sha>)"`

实现 commit message 的 `tests: <sha>` 引用必须指向**更早的、含本 Phase 测试文件**的 commit。不 commit = 不进下一 Phase。无例外。
</HARD-GATE>

禁止等所有 Phase 做完再统一提交。每 Phase 提交 = 可回滚 + 可审查 + 进度可见。一次 Phase 失败最多丢一个 Phase 的工作。

**destructive 操作确认**：进入下一 Phase 前，检查工单的风险标注。如果下一 Phase 含 `[destructive]` 操作（删表/删文件/改 schema）→ 列出破坏性操作清单 → **等待用户显式确认**后才能进入。破坏性风险由位1 需求/设计阶段识别并标注在工单上，tdd-implement 做最后一道兜底确认——不替代前置曝光，只确认用户已知情。

### ⑤ 全量验证

```
pnpm test → 确认全部 PASS + 无回归
```

如果有 FAIL：
- 是实现问题 → 修复实现（不改测试）
- 是 AC/测试规格问题 → 停下报告

### ⑥ 增量类型检查（最终）

```
只检查本次修改的文件：
  npx tsc --noEmit <所有本次修改的文件路径>
```

不跑全量 `tsc --noEmit`（大项目太慢）。Phase 间已检查过的文件可跳过。

---

## 并行实现规则

调用 parallel-execution Skill 执行并行实现：

```
输入：③ 的依赖分析结果
规则：
  - 同层独立文件 → 并行 agent
  - 不同层文件 → 按层序串行
  - 有文件冲突的 → 不并行
产出：所有文件实现完成，测试 PASS
```

---

## 约束

| 允许 | 禁止 |
|------|------|
| 在工单 AC 范围内新增代码 | 为让测试过而改测试断言 |
| 按 AC 和现有代码约定实现 | 改 AC 范围外的文件 |
| 按依赖分析并行实现 | 跳过依赖分析直接串行 |
| AC 有误时停下报告 | 自作主张改需求 |

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
| 6 | 测试先行 | 无"为让测试过而改断言"的改动 | 撤回并修复实现 |
| 7 | 并行执行 | 独立文件已并行实现（如有） | 补充并行执行 |
| 8 | AC 覆盖 | 每条 AC 有对应实现 + 通过测试 | 补充缺失覆盖 |
| 9 | Phase 间提交 | 每个 Phase 有测试+实现两个 commit，实现 commit 含 `tests: <sha>` 引用（HARD-GATE） | 停下，补提交后才能进下一 Phase |
| 10 | destructive 确认 | `[destructive]` 操作已显式确认后再执行 | 停下，提示用户确认破坏性操作 |
| 11 | 纯删除任务验证 | 纯删除任务有 grep 零残留 + tsc 无新错误 + 现有测试不回归 | 补充验证 |
| 12 | 工作区干净 | `git status --short` 无输出（无未提交变更） | 停下，确认无遗漏文件后提交 |

全部通过后进入终端状态。

---

## 终端状态

<HARD-GATE>
Phase 间的 commit 已在 ④ 中完成。全部 Phase 完成 + 全量测试 PASS + 类型检查通过后，才能输出完成总结。禁止在测试未全绿、类型检查未过、提交未齐时输出"完成总结"或"全部完成"。
</HARD-GATE>

输出完成总结前，确认以下状态：

1. `git status --short` 无输出（工作区干净，所有变更已提交）
2. `git log --oneline` 确认每个 Phase 有测试+实现两个 commit，实现 commit 带 `tests: <sha>` 引用

状态不对 → 先补齐提交，再总结。
