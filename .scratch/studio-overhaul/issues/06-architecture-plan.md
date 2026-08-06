# 06 — 模块架构规划

Type: task
Status: resolved
Blocked by: 01, 02, 03, 04, 05

## Question

基于 01-05 的调研结论，用 codebase-design 技能做模块架构规划：确定后端臃肿逻辑的重构切分方案、超大文件的拆分边界、前端 UI 交互流程重构方向、性能瓶颈处置方案、候选废弃功能的取舍。产出架构规划文档。

## Answer

已解决。架构规划：`../plan/architecture.md`。

决策：执行顺序定为 **B 删除 → C bug → A 性能 → D 后端结构 → E 前端结构 → F 交互 → G i18n 移除 → H/I/J 收尾 → 巡检**。核心判断：①FileStore 加读穿缓存为接口不变的实现深化，是性能主杠杆；②死代码删除先行以缩小重构面（整包下线 monitor/task + packages 六刀 + api 三刀 + web 两刀 + 依赖清理）；③i18n 判定为单 adapter 假 seam，移除；④ui/ 补通用 Modal/ConfirmDialog/Button 因 F2/F3 有真实消费方而成立；⑤样式只做冲突消除不做全面统一。
