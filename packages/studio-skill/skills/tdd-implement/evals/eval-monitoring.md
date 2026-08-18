# tdd-implement Eval 监控清单

## eval 场景

isSimpleChange 总行数检查（2 文件，纯函数，TDD 流程）

## 监控项

### 1. Skill Discovery
- [ ] tdd-implement 被正确触发（不是 tdd-red/tdd-green）
- [ ] 触发原因是"按 SDD 实现代码"

### 2. HARD-GATE 遵守
- [ ] 先写 FAIL 测试，再写实现（没有先实现后补测试）
- [ ] 没有修改测试文件（只新增测试用例）
- [ ] 没有添加测试未要求的功能

### 3. Task 跟踪
- [ ] 读取 SDD 后，每个 AC 有对应的 TaskCreate 调用
- [ ] RED 阶段：写完 FAIL 测试后，TaskUpdate(status="in_progress")
- [ ] GREEN 阶段：实现后，TaskUpdate(status="completed")
- [ ] 最终状态：所有 AC 的 task 都是 completed

### 4. TDD 纪律
- [ ] RED：写了 FAIL 测试
- [ ] RED：确认测试 FAIL（pnpm test 有 failures）
- [ ] GREEN：写了最小实现
- [ ] GREEN：确认测试 PASS（pnpm test 0 failures）

### 5. 并行执行
- [ ] 本场景 2 文件有依赖（测试依赖实现），应串行
- [ ] 如果误触发并行 → 记录问题

### 6. 增量类型检查
- [ ] 只检查修改的文件（不是全量 tsc --noEmit）
- [ ] 类型检查通过

### 7. 自检
- [ ] 7 项自检全部执行
- [ ] Terminal State → invoke code-review

## 判断标准

| 等级 | 条件 |
|---|---|
| PASS | 监控项全部通过 |
| WARN | 部分监控项未通过但不影响核心功能 |
| FAIL | HARD-GATE 被违反或 TDD 纪律未遵守 |
