# 27 — 热点残余优化（A3）

Type: task
Status: open
Labels: enhancement, ready-for-agent
Blocked by: 26

## Question

FileStore 缓存落地后的残余热点（证据 research/01）：AgentLoop.observe() 去掉 index.json 同轮双读（agent-loop.ts:474-529）；wu-messenger 消息查询加频道内预过滤，不再每条消息跨频道全扫描（wu-messenger.ts:40）。行为不变。验收：typecheck+test 全绿，独立 commit。
