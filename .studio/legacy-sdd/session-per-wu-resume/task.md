---
id: "sdd-1786420000000-session94-task"
slug: "session-per-wu-resume"
title: "会话号 per-WU 化与续用降级 — 任务"
status: "done"
version: 1
createdAt: "2026-08-11T03:30:00.000Z"
updatedAt: "2026-08-11T03:30:00.000Z"
---

## 任务分解（TDD：每步先 RED 后 GREEN）

### T1 session-resume 纯函数模块
- RED：新建 `agents/loop/__tests__/session-resume.test.ts`：
  - `claudeCwdSlug('/root/.claude') === '-root--claude'`；`claudeCwdSlug('/root/projects/studio') === '-root-projects-studio'`
  - `claudeSessionFileExists`：tmpdir HOME 造文件 → true；缺文件 → false
  - `shouldResumeSession`：无 sessionId → false；kimi + sessionId → true（无文件也 true）；claude + cwd null → true；claude + cwd + 文件在 → true；claude + cwd + 文件缺 → false
- GREEN：`loop/session-resume.ts` 实现。
- 验证：`pnpm test:api -- session-resume`（命令以 package.json 实际 script 为准）

### T2 agent-loop 续用判定 per-WU 化
- RED：重写 `agent-loop-session-resume.test.ts`：
  1. 无 metadata.sessionId → 新建（新 UUID、无 sessionResume、lastSessionResumed=false）
  2. metadata.sessionId + 会话文件在 → 续用（sessionResume=true、sessionResumes=1、lastSessionResumed=true）
  3. metadata.sessionId 有但文件缺 → 新建分支（sessionCount 1→2、lastSessionResumed=false）
  4. 并行互踩回归：WU-A/WU-B 各有 sessionId（文件都在），同 loop 交替 agentStep → 各自 sessionResume=true 续用自己的号
  5. 重启场景：loop.instance=null（或新实例 sessionId=null）+ metadata.sessionId + 文件在 → 续用
  6. kimi：metadata.sessionId 在（无文件）→ 续用（sessionId + sessionResume）
  7. instance 槽位不再写入：新建后 `fileStore.getState(instanceId).sessionId` 仍为初始值
  - （HOME stubEnv 到 tmpdir 造会话文件；executeLightweight/workspace 解析沿用既有 mock）
- GREEN：agent-loop.ts 按 design §2 改造（判定后移、删 instance 槽位写、lastSessionResumed 落盘）。
- 验证：本测试文件全绿 + typecheck。

### T3 续用失败降级
- RED（同测试文件）：
  8. 续用步 success:false + error 'No conversation found with session ID xxx' → 自动第二次 execute：无 sessionResume、claude 传新 UUID；第二次成功 → action 正常、metadataUpdates.sessionId=新、sessionCount+1、lastSessionResumed=false
  9. 续用步 success:false + error 'CLI boom'（非续用错误）→ 不重试，action=failed
  10. 降级重试仍失败 → action=failed，sessionId/sessionCount 增量被 reset（不落新会话簿记）
- GREEN：agent-loop success===false 分支降级逻辑。
- 验证：本测试文件全绿。

### T4 事件与 metadata 标记
- RED：`execution-step-events.test.ts` 补 case：args.sessionResumed=true/false → payload 透传；缺省 → payload 无该键。
- GREEN：execution-step-events.ts + workunit.types.ts + wu-metadata.ts（clearSessionBookkeeping 13 字段）。
- 验证：execution-step-events 测试全绿；grep 确认 review-dispatcher 路径 clearSessionBookkeeping 覆盖 lastSessionResumed。

### T5 废除复活清零
- RED：改 `block-reason.test.ts:109-130` 等断言：复活后 sessionCount 保留（不清零）；检查 waiting-input.test.ts 相关断言同步改。
- GREEN：waiting-input.ts 删 `sessionCount: 0`；agent-loop B5 文案更新。
- 验证：workunit 测试全绿。

### T6 收口
- `pnpm typecheck`（或等价）+ api 全量测试 + 仓级全量测试一次。
- 更新 `agents/CONTEXT.md`（会话簿记段：per-WU 化、session-resume.ts、instance 槽位废弃）与 `workunit/CONTEXT.md`（复活不再清零 sessionCount）。
- SDD status → done；逐条 AC 对照验证清单。
- code-review（两阶段）→ commit。
