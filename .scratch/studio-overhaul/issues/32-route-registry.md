# 32 — route-registry 显式化（D3）

Type: task
Status: open
Labels: enhancement, ready-for-agent
Blocked by: 18, 19, 20

## Question

apps/api/src/route-registry.ts 两处顺序敏感依赖：改为显式注册顺序 + 注释固化 + 启动断言（顺序错误时启动即报错）。不重写装配机制。证据 research/01。验收：typecheck+test 全绿，独立 commit。
