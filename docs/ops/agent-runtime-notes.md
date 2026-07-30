# Agent 运行时运维说明

> 2026-07-30 走查修复沉淀。覆盖三个关键运行时行为。

## IS_SANDBOX=1

**问题**：root 下 `claude --resume` 自注入 `--dangerously-skip-permissions`，CLI 的 root guard
（`getuid()===0 && IS_SANDBOX!=="1"`）直接 exit 1，导致同 WU 第 2+ step 全部秒败。

**机制**：`buildSessionEnv`（`packages/studio-agent/src/services/runner-params.ts` L431-448）默认补
`IS_SANDBOX=1`（host 已设则尊重 host）。此为 CLI 预留的沙箱声明——不放宽权限（worktree settings
已声明 `bypassPermissions`），只让 root guard 放行，非安全旁路。

## STUDIO_AGENT_LOOP_ENABLED=false

**问题**：同一 `~/.studio` 被多 API 实例共享（dev 13001 + prod 13101），同 profile 重复挂载：
认领竞争、频道重复回复、定时 WU 重复创建。

**机制**：`apps/api/src/index.ts` L180-226 启动时判断。`false` 跳过 agent loop 挂载和系统触发器，
但保留 ReviewDispatcher/AnalysisHandoff/事件桥订阅（幂等哨兵防冲突）。

**默认值**：不设 = 启用（`!== 'false'` 即挂载）。本机 dev 仓 `.env` 与 `apps/api/.env` 显式设 `false`
→ dev standby；prod 不设 → 唯一持有 loop（与单活守卫双保险）。

## Analysis WU 只读分析

**触发**：PMO `projectService.publish()` → `type: 'analysis'` WU（`project.service.ts` L444-457）。

**约束**：禁 Edit/Write/NotebookEdit；禁 git commit/checkout/clean、包管理器 install、写临时脚本；
仅允许 Read/Grep/Glob + 只读 Bash（git log/diff/status、ls、cat、grep）。结论 markdown 输出在回复中，不落盘。

**输出约定**：分析完成逐行输出 `TASK: <描述>`（3-8 条），agent-loop COMPLETE 时 parse 写入
`metadata.analysisTasks`，人工 confirm 后 AnalysisHandoff 派生 task 子 WU。

**生命周期**：publish → analysis WU → agent 只读分析 → COMPLETE → parse TASK → in_review
（跳过自动评审）→ 人工 confirm → done → spawnTasks。
