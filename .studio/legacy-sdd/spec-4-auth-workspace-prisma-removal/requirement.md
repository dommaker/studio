---
status: done
version: "1.0"
spec: docs/specs/db-removal/spec-4-auth-workspace-prisma-removal.md
---

# Requirement: Auth 双模式 + Workspace 迁移 + 移除 Prisma

## AC Group A: Auth 双模式 (covers: AC-1a, AC-1b, AC-1c)

### AC-A1: STUDIO_AUTH 环境变量开关
- **触发**: API 启动时读取 `process.env.STUDIO_AUTH`
- **`STUDIO_AUTH=none`** (默认): middleware 注入 `req.user = { id: 'local', role: 'Admin', name: 'Local User' }`, 跳过后端认证
- **`STUDIO_AUTH=on`**: 走完整 Session 校验 (不改变现有行为)
- **边界**: 未设置时默认 `none`; 非法值按 `none` 处理
- **不做**: 支持 `none`/`on` 以外的值
- **涉及文件**: `apps/api/src/middleware/auth.ts`

### AC-A2: /api/auth/status 端点
- **`GET /api/auth/status`** 返回 `{ mode: "none" | "on", user: { id, name, role } | null }`
- **`none`** 模式固定返回 `{ mode: "none", user: { id: "local", name: "Local User", role: "Admin" } }`
- **`on`** 模式返回 `{ mode: "on", user: req.user }` (未登录 user=null)
- **测试**: `GET /api/auth/status` 在两种模式下返回正确 mode+user
- **涉及文件**: `apps/api/src/modules/auth/routes.ts`, `__tests__/routes.test.ts`

### AC-A3: 前端登录页适配
- 前端启动时请求 `GET /api/auth/status`
- `mode=none` → 隐藏登录页, 跳过认证流程
- `mode=on` → 显示登录页, 行为不变
- **涉及文件**: 前端登录页组件, auth store/router guard

---

## AC Group B: User + Session 迁移 (covers: AC-2a, AC-2b, AC-2c, AC-3a, AC-3b, AC-3c, AC-3d)

### AC-B1: User → users.json
- `~/.studio/users.json` 存储 `[{ id, email, passwordHash, name, role, createdAt, updatedAt }]`
- `auth/service.ts` 所有 User CRUD 改为 FileStore 读写 `users.json`
- `STUDIO_AUTH=none` 时 `users.json` 可不存在, 使用内置 local 用户
- 替换 `import { User } from "@prisma/client"` 为本地类型
- 移除 `import { prisma }` (User 相关部分)
- **涉及文件**: `apps/api/src/modules/auth/service.ts`

### AC-B2: Session → sessions.jsonl
- `~/.studio/sessions.jsonl` 存储 session (JSONL, 每行一条)
- 格式: `{"id","userId","token","guestId","ipAddress","userAgent","expiresAt","createdAt","refreshToken"}`
- `auth/service.ts` Session CRUD 改为 FileStore JSONL
- `middleware/auth.ts` Session 读取路径从 per-file JSON → `sessions.jsonl`
- `STUDIO_AUTH=none` 时 sessions.jsonl 可不存在
- 过期清理: 启动时加载到内存 map, 每分钟扫描过期并写盘
- **涉及文件**: `apps/api/src/modules/auth/service.ts`, `apps/api/src/middleware/auth.ts`

### AC-B3: RefreshToken 合并到 Session
- RefreshToken 作为 session 记录的 `refreshToken` 字段, 不再独立存储
- `auth/service.ts` refresh 逻辑改为读 `sessions.jsonl` 的 `refreshToken` 字段
- **涉及文件**: `apps/api/src/modules/auth/service.ts`

### AC-B4: Schema 删除 User/Session/RefreshToken
- `schema.prisma` 删除 `model User`, `model Session`, `model RefreshToken`
- `npx tsc --noEmit` 无相关类型错误
- **涉及文件**: `packages/studio-prisma/prisma/schema.prisma`

### AC-B5: Auth 迁移测试
- User CRUD (`STUDIO_AUTH=on`), 密码验证, local 用户降级 (`STUDIO_AUTH=none`)
- Session: 登录创建, token 校验, 过期拒绝, 登出清理
- RefreshToken: refresh 轮转, token 吊销
- 边界: `users.json`/`sessions.jsonl` 不存在/空/损坏, 过期清理不误删
- **涉及文件**: `apps/api/src/modules/auth/__tests__/service.test.ts`

---

## AC Group C: Workspace 迁移 (covers: AC-4a~4g)

### AC-C1: Workspace 配置 → workspaces/{id}.json
- `~/.studio/workspaces/{id}.json` 存储 Workspace + Token + Runtime + Repo 合并配置
- 合并 Token/Runtime/Repo 为嵌套 JSON (不再分散在独立表/目录)
- `workspace.routes.ts` 改用 FileStore
- `token.routes.ts` 读写路径对齐 `workspaces/{id}.json` 的 `tokens` 数组
- `local-workspace.ts` 读写路径对齐目标结构
- Schema 删除 `model Workspace`, `model WorkspaceToken`, `model WorkspaceRuntime`, `model WorkspaceRepo`
- **涉及文件**: `workspace.routes.ts`, `token.routes.ts`, `local-workspace.ts`, `packages/studio-agent/src/services/worktree-resolver.ts`

### AC-C2: WorkspaceTask → tasks.jsonl
- `~/.studio/workspaces/{id}/tasks.jsonl` JSONL 格式
- `daemon-routes.ts` task claim/update/query → FileStore JSONL
- `task-routes.ts` 改为 FileStore (当前仍用 Prisma)
- Schema 删除 `model WorkspaceTask`
- **涉及文件**: `daemon-routes.ts`, `task-routes.ts`

### AC-C3: WorkspaceEvent → events.jsonl
- `~/.studio/workspaces/{id}/events.jsonl` JSONL 格式
- `daemon-routes.ts` event create → FileStore JSONL
- Schema 删除 `model WorkspaceEvent`
- **涉及文件**: `daemon-routes.ts`

### AC-C4: 实时状态内存 + flush-on-write
- 状态 (status/currentTask/lastHeartbeat) 加载到内存 map
- 每次变更同步写文件, 无内存-only 窗口
- 崩溃恢复: 启动时扫描 `workspaces/` 目录重建内存状态
- `ws-gateway.ts` 心跳更新改为内存 + flush
- **涉及文件**: `ws-gateway.ts`

### AC-C5: workspace.json 合并
- 检查 `~/.studio/workspace.json` 已有数据
- 迁移脚本: 合并到 `~/.studio/workspaces/{id}.json`, 去重键=name+workspaceRoot
- 合并后删除 `workspace.json`
- **涉及文件**: `scripts/migrate-spec4-to-files.ts`, `local-workspace.ts`

### AC-C6: GC 服务迁移
- `gc-service.ts` 从 Prisma 改为 FileStore
- 过期 task 扫描: 遍历 `workspaces/{id}/tasks.jsonl`
- 过期 event 同步清理
- **涉及文件**: `gc-service.ts`

### AC-C7: Workspace 迁移测试
- Workspace CRUD, Token 创建/验证/撤销, 心跳更新
- Task claim/update/query, Event 写入
- 边界: 并发 claim (flock), 崩溃恢复, 空目录, JSONL 损坏行
- **涉及文件**: `__tests__/workspace.test.ts`, `__tests__/daemon-routes.test.ts`, `__tests__/task-routes.test.ts`, `__tests__/gc-service.test.ts`

---

## AC Group D: Prisma 移除 (covers: AC-5, AC-6a, AC-6b, AC-7)

### AC-D1: 数据迁移脚本
- `scripts/migrate-spec4-to-files.ts`: DB → files 全量导出
- 支持 `--dry-run`, 输出迁移记录数 vs DB 行数对比
- **涉及文件**: `scripts/migrate-spec4-to-files.ts` (新增)

### AC-D2: Prisma 包与依赖删除
- 删除 `packages/studio-prisma/` 整个目录
- 根 `package.json` 删除 `@prisma/client`, `prisma` 依赖
- 删除 `apps/api/src/core/database.ts`
- `.env` / `.env.example` 删除 `DATABASE_URL`
- `index.ts` 删除 `prisma migrate deploy` 调用, 删除 `connectDatabase()`
- `studio-cli.ts` 删除 `prisma db` 命令 (push/migrate/status)
- 7 个 workspace 包: 删除 `"@dommaker/studio-prisma": "workspace:*"` 依赖声明
- **涉及文件**: 见 design.md 完整文件映射

### AC-D3: Prisma 引用零残留验证
- `grep -r "prisma\|Prisma\|@prisma" apps/ packages/ --include="*.ts" --include="*.tsx"` 零结果 (排除 node_modules)
- `npx tsc --noEmit` 无类型错误
- 全量 `npx vitest run` 通过
- **涉及文件**: 全仓库 CI 检查

### AC-D4: 启动流程简化
- API 启动不再需要 `DATABASE_URL`
- 首次启动自动创建 `~/.studio/` 目录结构
- 零配置启动: `STUDIO_AUTH=none npx tsx apps/api/src/index.ts`
- README 更新
- **涉及文件**: `apps/api/src/index.ts`, `README.md`

---

## AC Group E: 线上迁移 (covers: AC-8)

### AC-E1: dommaker.cn 迁移
- 按 spec 顺序执行迁移脚本, 每个 spec 验证后继续
- 验证: 登录/登出/Channel/SDD/Agent/知识库 功能正常
- DB 备份 + 行数校验后删除 DB 文件
- **涉及文件**: 无代码变更 (运维操作)
