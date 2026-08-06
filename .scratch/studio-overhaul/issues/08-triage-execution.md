# 08 — triage 拆解执行工单

Type: task
Status: resolved
Blocked by: 07

## Question

基于 07 的 spec，用 triage 技能把重构方案拆解为细小执行工单（单文件/单关注点粒度，1-3 commit/工单），写入 issues/ 并标注依赖关系。此后主循环逐工单执行：每处细小优化独立 commit，工单结束跑门控并更新 Status。全部执行工单闭环后追加最终巡检工单（improve-codebase-architecture，重点查孤立死代码与无用导入）。

## Answer

已解决。执行工单 09-43 已拆出（issues/09-*.md 至 43-*.md，共 35 张，均 ready-for-agent）：

- 删除批次 09-23（B1 整包×2、B2 packages×7、B3 api×3、B4 web×2、B5 依赖）
- bug 修复 24-25（C1-C5）
- 性能 26-27（FileStore 缓存 + 热点残余）
- 后端结构 28-32（三个大文件拆分 + agents/ 重组 + route-registry）
- 前端结构 33-35（五个大页面/组件拆分）
- 交互修复 36-38（ui 通用件 + 确认/跳转 + 裸 fetch + 反馈/loading/防抖）
- 收尾 39-42（i18n 移除、样式冲突、lint 修复、重复收敛）
- 43 最终巡检（Blocked by 09-42 全部）

依赖边已按真实先后关系标注（删除先行、缓存先于热点残余、拆分先于重组、i18n 最后）。自此进入逐工单串行执行阶段。
