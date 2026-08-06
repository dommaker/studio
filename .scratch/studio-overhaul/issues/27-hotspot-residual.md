# 27 — 热点残余优化（A3）

Type: task
Status: resolved
Labels: enhancement, ready-for-agent
Blocked by: 26

## Question

FileStore 缓存落地后的残余热点（证据 research/01）：AgentLoop.observe() 去掉 index.json 同轮双读（agent-loop.ts:474-529）；wu-messenger 消息查询加频道内预过滤，不再每条消息跨频道全扫描（wu-messenger.ts:40）。行为不变。验收：typecheck+test 全绿，独立 commit。

## Answer

已解决，commit `86e14598`。① observe() index.json 每轮只读一次，myActive 由同批快照本地派生（逐行对齐 list 分页/排序/过滤语义；snapshotToData 导出复用）；三轮扫描经评估分属不同数据域且缓存落地后残余成本为 stat+克隆，不合并。② wu-messenger findAnchorMessage 先频道内查询，仅历史换频道边界回退全扫描。行为不变论证与回退口径完整。typecheck exit 0，test 复跑 3944 passed / 0 failed（首轮 knowledge-bus-sync flake 单跑即过，与本改动无关）。
