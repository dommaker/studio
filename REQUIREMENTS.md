# 需求
> ⚡ **简单改动** — Analyst 已验证。直接执行，不探索。
> 步骤：读目标文件 → 按实现指南改 → tsc → npm test → .progress.json

## 任务
## 你的任务

## 验收标准
1. 为 verifyPassword PBKDF2 旧格式兼容路径编写测试：验证 legacy PBKDF2 salt:hash 格式识别 → 验证通过 → needsRehash=true
2. 验证 login 流程中 needsRehash 触发静默升级：旧格式密码登录成功后自动更新为 bcrypt 哈希
3. 验证旧格式哈希迁移后新登录使用 bcrypt 路径（不再走 PBKDF2）

## 预期改动文件
- apps/api/src/modules/auth/service.ts

## 已完成的相关工作
以下并行步骤已先完成，参考其输出可避免重复劳动或冲突：

### ac-route-coverage

### ac-middleware-ext-coverage

### ac-rate-limit-tests

### ac-oauth-exchange

### ac-refresh-concurrency

### ac-frontend-coverage


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
1. 为 verifyPassword PBKDF2 旧格式兼容路径编写测试：验证 legacy PBKDF2 salt:hash 格式识别 → 验证通过 → needsRehash=true
2. 验证 login 流程中 needsRehash 触发静默升级：旧格式密码登录成功后自动更新为 bcrypt 哈希
3. 验证旧格式哈希迁移后新登录使用 bcrypt 路径（不再走 PBKDF2）

## 预期改动文件
- apps/api/src/modules/auth/service.ts

## 行为约束
- 完成前必须运行 npm test + type check + lint
- 禁止模糊声明完成
- 每完成一个步骤后立即更新 .progress.json
- 全部 AC 测试通过后才设置 .progress.json allComplete: true
- **Phase 3: 禁止创建新的 .test.ts / .spec.ts 文件**（测试由 Analyst + Reviewer 提供，你只实现代码让测试通过）
- 将测试证据写入 .progress.json.testResults: { passed, total, failed: 0, command: "npm test", evidence: "<测试输出>" }
- 将设计决策写入 .progress.json.designNotes: { decisions: ["选X不选Y因为Z"], failedAttempts: ["试过A遇到B问题"], uncertainties: ["C部分需要特别关注"], constraintsDiscovered: ["实现中发现AC未覆盖的限制D"] }
- designNotes 只记录对 Review 有意义的决策信息，不写琐碎细节