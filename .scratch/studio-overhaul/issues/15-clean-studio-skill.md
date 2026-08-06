# 15 — studio-skill 清理

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

清理 packages/studio-skill：删除零引用的 matchIntent、definitions/ 空 stub、package.json 两个死依赖。证据 research/04。验收：grep 零残留，typecheck+test 全绿，独立 commit。

## Answer

已解决，commit `21fb3e16`（7 files, +2/−111）。删 intent-router.ts（matchIntent）+ 7 测试 + definitions/ 空 stub + index 再导出 + 死依赖 @dommaker/harness、@dommaker/studio-shared；lockfile/CONTEXT 同步。复扫零活引用。typecheck exit 0，test 4153 passed / 0 failed。

（备注：本工单曾因 subagent 配额 403 中断一次，04:15 cron 续跑后以 primary 模型重试完成。）
