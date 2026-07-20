# shared

> 此文件描述 apps/api/src/modules/shared 目录的职责和上下文

## 职责

apps/api 各模块共享的纯函数工具，不承载业务状态。

## 核心导出

- `failure-classifier.ts` — Failure classifier（B1-007）：对错误消息做模式匹配，归类错误标签

## 依赖关系

- 上游：无（纯代码）
- 下游：apps/api 内各模块（triage、agents 等错误处理路径）

## 注意事项

- 只放跨模块共享的纯逻辑；带状态的 service 应归属具体业务模块
