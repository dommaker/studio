# 05 — 门控基线建立

Type: task
Status: resolved

## Question

在改动开始前建立门控基线：运行 `pnpm typecheck`、`pnpm test`（必要时 `pnpm lint`），记录当前通过/失败状态与存量失败清单。后续所有提交以"不劣于此基线、且最终全绿"为判定标准。产出基线报告。

## Answer

已解决。报告：`../research/05-gate-baseline.md`。

基线（提交 46a2cf8f，node v22.22.0 / pnpm 11.19.0）：**typecheck 全绿**（exit 0，4 包无新增错误）；**test 全绿**（446 文件 / 4246 用例通过，0 失败）；**lint 损坏不可跑**（packages/studio-capability 缺 eslint 依赖，`pnpm -r` 首包即停——基线视为"lint 不可跑"，后续修复后转为可用门控）。
