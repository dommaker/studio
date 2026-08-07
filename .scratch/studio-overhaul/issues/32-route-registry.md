# 32 — route-registry 显式化（D3）

Type: task
Status: resolved
Labels: enhancement, ready-for-agent
Blocked by: 18, 19, 20

## Question

apps/api/src/route-registry.ts 两处顺序敏感依赖：改为显式注册顺序 + 注释固化 + 启动断言（顺序错误时启动即报错）。不重写装配机制。证据 research/01。验收：typecheck+test 全绿，独立 commit。

## Answer

已解决，commit `b54d109c`。两处顺序敏感点：① /api/v1/agents 双挂载（tokenUsageRoutes 须先于 legacy agentRoutes）；② /api/v1/skills/demotion-proposals 须先于 /api/v1/skills（GET /:id 不 next() 会吞掉）。固化：注释说明 + buildRouteTable 尾部 assertRouteOrder 启动断言 fail-fast；新增 4 条断言测试。typecheck exit 0，test 3957 passed / 0 failed。
