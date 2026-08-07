# 41 — lint 修复（I）

Type: task
Status: resolved
Labels: enhancement, ready-for-agent

## Question

修复 `pnpm lint` 不可跑问题（基线：packages/studio-capability 缺 eslint 依赖致 `pnpm -r` 首包即停；apps/web 无 flat config 致脚本失效）：对齐仓内既有 eslint 版本与配置形态，取最小修复路径；存量告警数量基线化记录，不要求清零。若某子包修复成本明显不成比例，记录后移除其 lint 脚本。验收：`pnpm lint` 全仓可跑通（exit 0 或仅存量告警），结果写入工单 Answer，独立 commit。

## 追加范围（自工单 10 移交）

- bin/tsc-gate.js / tsc-gate.sh 包清单中的历史残留 studio-prisma（包已不存在），顺手清理。

## 追加范围（自工单 23 移交）

- apps/api package.json 的 node-fetch 声明无引用（studio-task 错位引用残留），顺手卸载并更新 lockfile。

## Answer

- 诊断：根 `.eslintrc.cjs`（legacy，规则全 warn 级）+ 根脚本 `ESLINT_USE_FLAT_CONFIG=false` 是旧 eslint 8 时代设计；现仓 eslint 为 9.39（仅 apps/web 声明），legacy 模式在 v9 已废弃、v10 移除。断点有二：packages/studio-capability 等 3 个包有 lint 脚本但无 eslint 依赖（`eslint: not found`，`pnpm -r` 首包即停）；apps/web 无 flat config。
- 修复（flat 迁移）：新增根 `eslint.config.mjs`（等价迁移旧 .eslintrc.cjs，js/tseslint recommended + 全 warn 规则），新增 `apps/web/eslint.config.js`（react-hooks/react-refresh，v7 compiler 规则统一降级 warn）；根 devDeps 增加 eslint/@eslint/js/typescript-eslint/globals；删除 `.eslintrc.cjs`；根 lint 脚本去掉 `ESLINT_USE_FLAT_CONFIG=false`。
- 基线（exit 0）：apps/web 236 告警；packages/studio-agent 25 告警；packages/studio-spec 14 告警；packages/studio-capability 0。合计 275 告警 / 0 错误，不要求清零。
- 顺手 A：bin/tsc-gate.js:16、bin/tsc-gate.sh:40 的 studio-prisma 残留已清理。
- 顺手 B：apps/api 卸载 node-fetch（全仓无代码引用），lockfile 已更新。
- 门控：`pnpm typecheck` exit 0；`pnpm lint` exit 0；`pnpm test` 3987 passed / 0 failed。

## Answer

已解决，3 个 commit：`5c0c099d`（eslint 8 legacy → 9 flat 迁移：新增根 eslint.config.mjs + apps/web flat config，删 .eslintrc.cjs，lint 全仓可跑，基线 0 错误/275 告警）、`f3da407d`（tsc-gate 清单 studio-prisma 残留清理）、`1f76da65`（卸载 node-fetch）。typecheck exit 0，lint exit 0，test 3987 passed / 0 failed。
