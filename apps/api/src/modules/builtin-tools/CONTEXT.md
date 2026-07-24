# builtin-tools

> 此文件描述 apps/api/src/modules/builtin-tools 目录的职责和上下文

## 职责

提供一组内置工具（文件操作、搜索、执行、通信）的元数据定义与 RESTful 路由，供上层服务注册和调用。工具列表静态注册在 `routes.ts` 中，每个工具包含名称、描述、分类、输入 schema 与启用状态。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router`（推测为默认导出） | `routes.ts` | Express 路由器，提供 `GET /builtin-tools` 接口返回内置工具列表。

## 依赖关系

上游：
- `../../utils/logger.js`：日志工具。

下游：
- `apps/api/src/route-registry.ts`：将 `builtin-tools` 路由挂载到应用主路由。

## 注意事项

- 工具分类（category）限定为 `file`、`search`、`execution`、`communication` 四种，新增分类需同步更新类型定义。
- `inputSchema` 遵循 JSON Schema 格式，`required` 字段必须与 properties 一致。
- `enabled` 字段目前硬编码为 `true`，未来可改为从配置中心动态加载。
- 文件操作类工具（`path` 参数）应进行路径安全检查，防止目录遍历，当前代码未实现该检查，需后续补充。
- **鉴权（2026-07-24 收紧）**：/api/v1/builtin-tools 挂载层已收 requireAuth+requireAdmin（PATCH 可启停工具；启停状态仅内存态不持久化）。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ 2026-07-24: 挂载收 requireAuth+requireAdmin
