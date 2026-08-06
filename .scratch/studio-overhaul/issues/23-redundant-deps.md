# 23 — 冗余依赖清理

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

卸载确定无引用依赖：multer + @types/multer、undici、zod（4 个包中未使用者逐一核对）、@types/react-router-dom；疑似类型 stub 4 项复核后一并处理（ioredis 已由工单 10 卸载）。卸载后 pnpm install 更新 lockfile。证据 research/03。验收：全仓 grep 无 import，typecheck+test 全绿，独立 commit。

## Answer

已解决，commit `e17502fd`。卸载：multer+@types/multer、undici、zod×3 包、@types/react-router-dom、@types/express-rate-limit、@types/pino（后三者实装版本自带类型）。保留：@types/compression、@types/js-yaml（实装版本未自带类型，证据报告此处有误）。typecheck exit 0，test 3933 passed / 0 failed。

遗留：apps/api 的 node-fetch 声明实为无引用（studio-task 错位引用残留）→ 移交工单 41 顺手卸载。
