# 需求
> ⚡ **简单改动** — Analyst 已验证。直接执行，不探索。
> 步骤：读目标文件 → 按实现指南改 → tsc → npm test → .progress.json

## 任务
## Task
WorkUnit: test-normal-1
Type: task
Scope: 用户注册功能，邮箱验证，密码加密，单元测试

## 你负责的验收标准
（从任务描述中推断）

## 行为约束
- 完成前必须运行 npm test + type check + lint
- 禁止模糊声明完成
- 每完成一个步骤后立即更新 .progress.json
- 全部 AC 测试通过后才设置 .progress.json allComplete: true
- **Phase 3: 禁止创建新的 .test.ts / .spec.ts 文件**（测试由 Analyst + Reviewer 提供，你只实现代码让测试通过）
- 将测试证据写入 .progress.json.testResults: { passed, total, failed: 0, command: "npm test", evidence: "<测试输出>" }
- 将设计决策写入 .progress.json.designNotes: { decisions: ["选X不选Y因为Z"], failedAttempts: ["试过A遇到B问题"], uncertainties: ["C部分需要特别关注"], constraintsDiscovered: ["实现中发现AC未覆盖的限制D"] }
- designNotes 只记录对 Review 有意义的决策信息，不写琐碎细节