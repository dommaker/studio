# 23 — 冗余依赖清理

Type: task
Status: open
Labels: enhancement, ready-for-agent

## Question

卸载确定无引用依赖：multer + @types/multer、undici、zod（4 个包中未使用者逐一核对）、@types/react-router-dom；疑似类型 stub 4 项复核后一并处理（ioredis 已由工单 10 卸载）。卸载后 pnpm install 更新 lockfile。证据 research/03。验收：全仓 grep 无 import，typecheck+test 全绿，独立 commit。
