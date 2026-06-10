# 需求
> ⚡ **简单改动** — Analyst 已验证。直接执行，不探索。
> 步骤：读目标文件 → 按实现指南改 → tsc → npm test → .progress.json

## 任务
## TDD 工作流

1. 读 AC → 写失败的测试
2. 运行测试确认失败
3. 最小实现让测试通过
4. 重构优化
5. 对所有 AC 重复
6. 运行 npm test + type check + lint
7. 更新 .progress.json（设置 allComplete: true 当且仅当所有 AC 满足）

完成后在 .progress.json 中记录：
- 做出的关键设计决策
- 需要跨步骤协调的事项

声明完成前必须：
1. 运行 npm test 确认所有测试通过（含你新增的测试）
2. 运行 npm run typecheck（或 tsc --noEmit）确认无类型错误
3. 将测试证据写入 .progress.json 的 testResults 字段
完成后在 .progress.json notes 中记录关键设计决策



## 验收标准
1. 在 /root/projects/studio/test-sse3.txt 创建文件，内容为 'SSE Test 3'（无边界情况，纯文件写入）

## 实现指南
直接用 Write 工具创建文件，内容为 'SSE Test 3'。无函数、无导入、无测试需求。

## 参考模式
- 参考 test-sse.txt 和 test-sse2.txt 的创建方式

## 预期改动文件
- test-sse3.txt


## 你负责的验收标准
1. 在 /root/projects/studio/test-sse3.txt 创建文件，内容为 'SSE Test 3'（无边界情况，纯文件写入）

## 架构上下文（Analyst 已探索并验证）

**下面的信息已经过 Analyst 代码探索验证。直接使用，不需要自己重新读文件。** 只在出现矛盾时才验证。

### 调用链
N/A

*以上信息验证于 commit 4775b14*

## 实现指南
直接用 Write 工具创建文件，内容为 'SSE Test 3'。无函数、无导入、无测试需求。

## 参考模式
- 参考 test-sse.txt 和 test-sse2.txt 的创建方式

## 预期改动文件
- test-sse3.txt

## 行为约束
- 完成前必须运行 npm test + type check + lint
- 禁止模糊声明完成
- 每完成一个步骤后立即更新 .progress.json
- 全部 AC 测试通过后才设置 .progress.json allComplete: true
- **Phase 3: 禁止创建新的 .test.ts / .spec.ts 文件**（测试由 Analyst + Reviewer 提供，你只实现代码让测试通过）
- 将测试证据写入 .progress.json.testResults: { passed, total, failed: 0, command: "npm test", evidence: "<测试输出>" }
- 将设计决策写入 .progress.json.designNotes: { decisions: ["选X不选Y因为Z"], failedAttempts: ["试过A遇到B问题"], uncertainties: ["C部分需要特别关注"], constraintsDiscovered: ["实现中发现AC未覆盖的限制D"] }
- designNotes 只记录对 Review 有意义的决策信息，不写琐碎细节