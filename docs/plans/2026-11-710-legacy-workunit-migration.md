# #710 迁移存量 WU 和历史完成证据

## 目标与边界

- 启动时对 active、等待人输入和 in_review 的旧 WU 幂等补出兼容 Assignment；只迁移仍缺 typed 记录的快照。
- Mandate 仅从可证明的系统派生来源与既有仓库归属生成；旧频道/API 数据没有认证主体时不得猜测 Operator，转 blocked 等 Operator 重新授权。
- 历史 done 代码 WU 缺 receipt 时先标 `legacy-unverified`；只有真实 Git 祖先/merge commit 与目标验证均成立，才补 `legacy: true` receipt 和对应 L1 证据。
- 未合并、验证不成立或 Git 状态无法判定时保留原 WU 的 done/completedAt 和历史，创建一个带 `legacyRepairOf` 的修复 WU；重复启动不重复建单。
- 不新增数据目录、不改写事件历史、不自动合并旧分支，也不让未验证标记绕过 PMO 严格交付证据。

## 已确认测试接缝

1. `migrateLegacyWorkUnits()` + 真实 `FileStore` 旧快照：Assignment/Mandate 派生、重新授权降级和幂等。
2. 临时真实 Git 仓库 + WorkUnitService 公开读模型：外部已合并、未合并、无法判定三种历史 done fixture；验证端口只替代命令执行结果，不替代 Git 事实。
3. `summarizeEvidence()`：已核实 legacy receipt 可进入既有严格口径；`legacy-unverified` 原单及修复单不会自动交付。
4. `startCoreServices()`：迁移先于 merge recovery 和 AgentLoop，单项失败仍按软启动纪律处理。

## 实施步骤

1. 先写迁移 RED：三种在途状态的 Assignment 映射、可靠/不可靠 Mandate、重复运行不新增记录。
2. 新增 `legacy-migration.ts` 语义命令，经 `WorkUnitMetadataRepository` 锁内补 typed 字段；状态交回沿用 WorkUnitService 统一迁移尾部。
3. 写真实 Git RED：外部合并且验证通过才补带标记 receipt；未合并/未知/验证失败创建一次修复 WU，原完成事实不变。
4. 扩展 `WorkUnitMergeReceipt.legacy` 与旧证据元数据类型；严格证据继续只接受完整且验证通过的 receipt。
5. 将迁移接入 `startCoreServices()`，更新 workunit/bootstrap CONTEXT 和启动顺序测试。
6. 跑单文件、受影响测试、`vitest run --changed origin/master` 与 typecheck；执行双轴 code-review，提交当前 master 并回写 #710。不 push、不 ship。

## 非目标

- 不从展示名、authorType、消息 metadata 或 `createdBy=mention` 推断认证用户。
- 不为历史完成伪造 merge commit、验证通过、L2/L3 或新的完成时间。
- 不重构现有 merge Effect、PMO 交付或 UI。
