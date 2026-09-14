# Channel 记录读写收口 channel.service（#532）

来源：studio#532（2026-09-14 架构评审 channel 性能方向候选 5）。

## 目标

频道记录读写收进 `channel.service.ts`（与 channel-message.service 同款 seam）：

- 404 判定单点：`getOrThrow(id)` 抛 `ChannelError(404)`，路由经统一 wrapper 映射
- 写路径内部失效缓存：6 个写端点不再手写 `clearCache`；失效键用常量 `/api/v1/channels`（= route-registry 挂载点，与现状 `req.baseUrl` 一致）
- helper 搬家：`createAgentWithFileStore`（→ 私有）、`updateChannelMembers`（→ `updateMembers`）、`validateDefaultWorkspaceId`（→ service 模块导出）

## 对外零变化

请求/响应形状、状态码、错误文案全部保持：

| 端点 | 现状关键点 | 收口后 |
|------|-----------|--------|
| GET `/` | listChannels excludeArchived | `service.listVisibleChannels()` |
| POST `/` | 409 duplicate / 201 | `service.create()`，重名抛 `ChannelError(409)` |
| GET `/:id` 等 6 读端点 | `Channel not found` 404 | `service.getOrThrow()` + wrapper 404 |
| DELETE `/:id` | rnd 兜底 + rebind + `{deleted, fallbackChannelId}` | `service.deleteWithFallback()`（内部持 WorkUnitService） |
| PUT archive/restore | rename；restore 非归档 400 `Channel is not archived` | `service.archive()/restore()`，state 错抛 `ChannelError(400)` |
| PATCH `/:id` | routing 合并 + 404 catch | `service.update()`（内部合并 routing） |
| PATCH `/:id/members` | 404 文案 `Channel <id> not found` + warning | `service.updateMembers()` 保留该文案；warning 仍在路由组装 |
| chore-pmo | 404 文案 `Channel not found: <id>`；ensure 失败 500 | `getOrThrow(id, 自定义文案)`；500 分支留路由 |

## 错误模型

单类 `ChannelError extends Error { status }`（400/404/409）。路由层 `handle()` wrapper：`ChannelError → res.status(e.status).json({success:false, error:e.message})`，其余 `next(e)`（现状 Express 4 下 async throw 本就悬挂，wrapper 顺带修正进 errorHandler）。

## 步骤

1. RED：`__tests__/channel.service.test.ts`——写→clearCache 被调（vi.mock api-cache）、not-found 语义
2. GREEN：`channel.service.ts`（ChannelService + channelService 单例 + setFileStore 测试口）
3. routes 瘦身：全部端点过 `handle()`，删 helper/样板
4. `channel-members.test.ts` / `workspace-binding.test.ts` import 改指 channel.service.js
5. channels CONTEXT.md 同步（核心导出表 + apiCache 注意事项条目）
6. 验证：channels 全部测试文件 + `vitest run --changed origin/master` + typecheck

## 不做

- 消息链路（channel-message.service / message-routing）不动
- apiCache 策略/TTL 不动
- 其他模块同类收口不做
