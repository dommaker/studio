# 需求
## 任务
## 你的任务

## 验收标准
1. 为 exchangeRefreshToken 编写并发安全测试：模拟两个并发请求使用同一 refresh token，验证仅第一个成功、第二个返回 null（revokedAt 已设置）
2. 验证 refresh token rotation 非事务包裹场景下的幂等性：重复撤销同一 token 不抛异常
3. 验证前端 axios interceptor 并发 401 队列：isRefreshing flag + failedQueue 排队 → token 刷新后批量重试

## 预期改动文件
- apps/api/src/modules/auth/service.ts
- apps/web/src/api/index.ts

## 已完成的相关工作
以下并行步骤已先完成，参考其输出可避免重复劳动或冲突：

### ac-route-coverage

### ac-middleware-ext-coverage

### ac-rate-limit-tests

### ac-oauth-exchange


## 验证
声明完成前必须：
1. 运行测试确认所有测试通过（含你新增的测试）。命令见"环境"章节。
2. 运行类型检查（npx tsc --noEmit）确认无类型错误
3. 将测试证据写入 .progress.json 的 testResults 字段
完成后在 .progress.json notes 中记录关键设计决策

## 🔴 数据库隔离红线
你只创建 migration 文件（packages/studio-prisma/prisma/migrations/），不执行它。
禁止运行：prisma migrate dev、prisma db push、prisma migrate reset、sqlite3 写入。
Migration 应用由 server 在 integration merge 后统一执行。
DATABASE_URL 已被清空，任何 Prisma 写操作都会失败。

## 你负责的验收标准
1. 为 exchangeRefreshToken 编写并发安全测试：模拟两个并发请求使用同一 refresh token，验证仅第一个成功、第二个返回 null（revokedAt 已设置）
2. 验证 refresh token rotation 非事务包裹场景下的幂等性：重复撤销同一 token 不抛异常
3. 验证前端 axios interceptor 并发 401 队列：isRefreshing flag + failedQueue 排队 → token 刷新后批量重试

## 预期改动文件
- apps/api/src/modules/auth/service.ts
- apps/web/src/api/index.ts

## 行为约束
- 完成前必须运行 npm test + type check + lint
- 禁止模糊声明完成
- 每完成一个步骤后立即更新 .progress.json
- 全部 AC 测试通过后才设置 .progress.json allComplete: true
- **Phase 3: 禁止创建新的 .test.ts / .spec.ts 文件**（测试由 Analyst + Reviewer 提供，你只实现代码让测试通过）
- 将测试证据写入 .progress.json.testResults: { passed, total, failed: 0, command: "npm test", evidence: "<测试输出>" }
- 将设计决策写入 .progress.json.designNotes: { decisions: ["选X不选Y因为Z"], failedAttempts: ["试过A遇到B问题"], uncertainties: ["C部分需要特别关注"], constraintsDiscovered: ["实现中发现AC未覆盖的限制D"] }
- designNotes 只记录对 Review 有意义的决策信息，不写琐碎细节