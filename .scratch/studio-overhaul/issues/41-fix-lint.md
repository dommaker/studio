# 41 — lint 修复（I）

Type: task
Status: open
Labels: enhancement, ready-for-agent

## Question

修复 `pnpm lint` 不可跑问题（基线：packages/studio-capability 缺 eslint 依赖致 `pnpm -r` 首包即停；apps/web 无 flat config 致脚本失效）：对齐仓内既有 eslint 版本与配置形态，取最小修复路径；存量告警数量基线化记录，不要求清零。若某子包修复成本明显不成比例，记录后移除其 lint 脚本。验收：`pnpm lint` 全仓可跑通（exit 0 或仅存量告警），结果写入工单 Answer，独立 commit。

## 追加范围（自工单 10 移交）

- bin/tsc-gate.js / tsc-gate.sh 包清单中的历史残留 studio-prisma（包已不存在），顺手清理。

## 追加范围（自工单 23 移交）

- apps/api package.json 的 node-fetch 声明无引用（studio-task 错位引用残留），顺手卸载并更新 lockfile。
