---
status: done
version: "1.0"
---

# Design: Auth 双模式 + Workspace 迁移 + 移除 Prisma

## 文件映射总表

### Phase 1: Auth 双模式 (AC-A1, AC-A2, AC-A3)

| AC | 文件 | 改动 | 当前状态 |
|----|------|------|---------|
| A1 | `apps/api/src/middleware/auth.ts` | 在 `optionalAuth()` 和 `requireAuth()` 头部加 `STUDIO_AUTH` 判断; none 模式注入 local user | 已用 FileStore, 缺 env 开关 |
| A2 | `apps/api/src/modules/auth/routes.ts` | 新增 `GET /api/auth/status` | 已有 guest/login/logout/me/refresh 路由 |
| A2 | `apps/api/src/modules/auth/__tests__/routes.test.ts` | 新增 2 个 test: none 模式 + on 模式 | 已有 routes.test.ts |
| A3 | 前端登录页 | 启动时读 `/api/auth/status`, none 模式隐藏登录 | 待确认路径 |

### Phase 2: User + Session 迁移 (AC-B1~B5)

| AC | 文件 | 改动 | 当前状态 |
|----|------|------|---------|
| B1 | `apps/api/src/modules/auth/service.ts` | User CRUD: prisma → FileStore (`users.json` 整文件读写) | ~12 prisma.user 调用 |
| B2 | `apps/api/src/modules/auth/service.ts` | Session CRUD: prisma → FileStore JSONL (`sessions.jsonl`) | ~10 prisma.session 调用 |
| B2 | `apps/api/src/middleware/auth.ts` | Session 读取路径: `~/.studio/data/sessions/{id}.json` → `~/.studio/sessions.jsonl`; 移除 per-file JSON 路径 | 当前用 per-file JSON |
| B3 | `apps/api/src/modules/auth/service.ts` | RefreshToken 合并到 Session; `generateRefreshToken`/`exchangeRefreshToken`/`revokeRefreshToken` 改为读 `sessions.jsonl` | ~8 prisma.refreshToken 调用 |
| B4 | `packages/studio-prisma/prisma/schema.prisma` | 删除 `model User`, `model Session`, `model RefreshToken` | 13→10 models |
| B5 | `apps/api/src/modules/auth/__tests__/service.test.ts` | 重写: mock prisma → mock FileStore | 当前 mock prisma |

### Phase 3: Workspace 迁移 (AC-C1~C7)

| AC | 文件 | 改动 | 当前状态 |
|----|------|------|---------|
| C1 | `apps/api/src/modules/workspaces/workspace.routes.ts` | prisma.workspace/workspaceRuntime/workspaceRepo → FileStore | 11 prisma 调用 |
| C1 | `apps/api/src/modules/workspaces/token.routes.ts` | 路径对齐 `workspaces/{id}.json` 的 `tokens` 字段 (当前读独立 workspace-tokens dir) | 已用 FileStore, 需路径调整 |
| C1 | `apps/api/src/modules/workspaces/local-workspace.ts` | 读写路径对齐目标结构 | 已用 FileStore, 需路径调整 |
| C1 | `packages/studio-agent/src/services/worktree-resolver.ts` | workspace 查询 → FileStore (读 `workspaces/{id}.json`) | 当前评论提及 prisma.workspace, 需确认实际调用 |
| C2 | `apps/api/src/modules/workspaces/daemon-routes.ts` | prisma.workspaceTask → FileStore JSONL (`tasks.jsonl`) | 14 prisma 调用 (task + event) |
| C2 | `apps/api/src/modules/workspaces/task-routes.ts` | prisma.workspaceTask/workspaceEvent → FileStore JSONL | 8 prisma 调用 |
| C3 | `apps/api/src/modules/workspaces/daemon-routes.ts` | prisma.workspaceEvent → FileStore JSONL (`events.jsonl`) | 同上 (AC-C2) |
| C4 | `apps/api/src/modules/workspaces/ws-gateway.ts` | 状态更新: 写 `workspaces/{id}.json` + 更新内存 map | 已用 FileStore, 需确认 memory map |
| C5 | `scripts/migrate-spec4-to-files.ts` | workspace.json 合并逻辑 | 新增 |
| C5 | `apps/api/src/modules/workspaces/local-workspace.ts` | 不再写入 `~/.studio/workspace.json` | 已用 FileStore |
| C6 | `apps/api/src/modules/workspaces/gc-service.ts` | prisma → FileStore (遍历 `tasks.jsonl`) | 6 prisma 调用 |
| C7 | `__tests__/workspace.test.ts` 等 4 文件 | 重写: prisma → FileStore mock | 当前用真实 prisma |

**Schema deletions (Phase 3):**
- `model Workspace` + `model WorkspaceToken` + `model WorkspaceRuntime` + `model WorkspaceRepo` (C1)
- `model WorkspaceTask` (C2)
- `model WorkspaceEvent` (C3)

### Phase 4: Prisma 移除 (AC-D1~D4)

| AC | 文件 | 改动 | 当前状态 |
|----|------|------|---------|
| D1 | `scripts/migrate-spec4-to-files.ts` | 新增: DB→files 迁移 (User/Session/Workspace 系列) | 不存在 |
| D2 | `packages/studio-prisma/` | 整个目录删除 | 存在 |
| D2 | `package.json` (root) | 删除 `@prisma/client`/`prisma` deps (实际在 studio-prisma 包中) | 不在根 package.json |
| D2 | `packages/studio-prisma/package.json` | 整个包删除 | 存在 |
| D2 | `apps/api/src/core/database.ts` | 整个文件删除 | 存在 |
| D2 | `.env` / `.env.example` | 删除 `DATABASE_URL` | 存在 |
| D2 | `apps/api/src/index.ts` | 删除 `loadConfig()` DATABASE_URL 逻辑 + `connectDatabase()` 调用 | 第43/63/78行 |
| D2 | `apps/api/src/cli/studio-cli.ts` | 删除 `prisma db push/migrate/status` 命令; 删除首次启动 prisma db push | 第143-156行, 720-754行 |
| D2 | `packages/studio-monitor/package.json` | 删除 `"@dommaker/studio-prisma": "workspace:*"` | 存在 |
| D2 | `packages/studio-capability/package.json` | 同上 | 存在 |
| D2 | `packages/studio-agent/package.json` | 同上 | 存在 |
| D2 | `packages/studio-spec/package.json` | 同上 | 存在 |
| D2 | `packages/studio-audit/package.json` | 同上 | 存在 |
| D2 | `packages/studio-notification/package.json` | 同上 | 存在 |
| D2 | `packages/studio-task/package.json` | 同上 | 存在 |
| D3 | 全仓库 | grep + tsc + test 三重验证 | — |
| D4 | `apps/api/src/index.ts` | 简化启动: 首次启动 `ensureDir ~/.studio/` | 当前: DATABASE_URL + autoMigrate + connectDatabase |
| D4 | `README.md` | 更新安装步骤 | 当前含 DB 前置 |

---

## 接口定义

### 本地类型 (替代 Prisma model 类型)

```typescript
// apps/api/src/modules/auth/service.ts — 替换 import { User, Session, RefreshToken } from "@prisma/client"

export interface UserData {
  id: string;
  email: string;
  passwordHash: string | null;
  name: string | null;
  avatar: string | null;
  role: string;
  emailVerified: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionData {
  id: string;
  userId: string | null;
  token: string;
  guestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: string;
  createdAt: string;
  refreshToken: string | null; // ← 合并 RefreshToken
}
```

### FileStore 操作接口

```typescript
// users.json — 整文件 JSON 数组读写
async function readUsers(): Promise<UserData[]>
async function writeUsers(users: UserData[]): Promise<void>
async function findUserByEmail(email: string): Promise<UserData | null>
async function findUserById(id: string): Promise<UserData | null>

// sessions.jsonl — JSONL 追加+内存索引
async function appendSession(session: SessionData): Promise<void>
async function findSessionById(id: string): Promise<SessionData | null>
async function findSessionByToken(token: string): Promise<SessionData | null>
async function updateSession(id: string, patch: Partial<SessionData>): Promise<void>  // 重写全量
async function deleteSession(id: string): Promise<void>
async function findSessionsByUserId(userId: string): Promise<SessionData[]>
async function cleanupExpiredSessions(): Promise<number>

// workspaces/{id}.json — 整文件 JSON 读写
async function readWorkspace(id: string): Promise<WorkspaceData | null>
async function writeWorkspace(id: string, ws: WorkspaceData): Promise<void>
async function listWorkspaces(): Promise<WorkspaceData[]>
async function deleteWorkspace(id: string): Promise<void>

// workspaces/{id}/tasks.jsonl — JSONL 读写
async function appendTask(workspaceId: string, task: TaskData): Promise<void>
async function findPendingTask(workspaceId: string, runtimeId?: string): Promise<TaskData | null>
async function claimTask(taskId: string, claimToken: string): Promise<boolean>
async function updateTask(taskId: string, patch: Partial<TaskData>): Promise<void>
async function findTasksByStatus(workspaceId: string, status: string): Promise<TaskData[]>

// workspaces/{id}/events.jsonl — JSONL 追加
async function appendEvent(workspaceId: string, event: EventData): Promise<void>
async function appendEvents(workspaceId: string, events: EventData[]): Promise<void>
async function findEventsByTask(workspaceId: string, taskId: string): Promise<EventData[]>
```

### /api/auth/status 响应

```typescript
// GET /api/auth/status
// Response:
{
  mode: "none" | "on";
  user: { id: string; name: string; role: string } | null;
}
```

---

## 代码依赖图 (DAG)

```
Phase 1 (Auth 双模式) — 纯增量, 无依赖
  ├── middleware/auth.ts (A1) ← 独立
  ├── auth/routes.ts (A2) ← 独立, 并行
  └── 前端 (A3) ← 独立, 并行

Phase 2 (User+Session) — 依赖 Phase 1
  ├── auth/service.ts (B1, B2, B3) ← 改动同一文件, 串行
  │     ├── B1 (User → users.json)
  │     ├── B2 (Session → sessions.jsonl)
  │     └── B3 (RefreshToken 合并) ← 依赖 B2 (session 格式确定)
  ├── middleware/auth.ts (B2-session-path) ← 依赖 B2 (目标路径确定)
  ├── schema.prisma (B4) ← 依赖 B1+B2+B3 (代码不再引用)
  └── auth/__tests__/service.test.ts (B5) ← 依赖 B1+B2+B3

Phase 3 (Workspace) — 依赖 Phase 2 (FileStore 模式已验证), 内部可部分并行
  ├── workspace.routes.ts (C1) ← 独立
  ├── local-workspace.ts (C1) ← 独立, 并行
  ├── token.routes.ts (C1) ← 独立, 并行
  ├── worktree-resolver.ts (C1) ← 独立, 并行
  ├── daemon-routes.ts (C2, C3) ← 独立, 并行
  ├── task-routes.ts (C2) ← 独立, 并行
  ├── ws-gateway.ts (C4) ← 独立, 并行
  ├── gc-service.ts (C6) ← 依赖 C2 (tasks.jsonl 格式确定)
  ├── migrate-spec4 script (C5) ← 依赖 C1+C2 (目标格式确定)
  └── schema.prisma (C1+C2+C3 deletions) ← 依赖 C1+C2+C3 代码迁移

Phase 4 (Prisma 移除) — 依赖 Phase 2+3
  ├── migrate-spec4 script (D1) ← 依赖 C5 (workspace 格式)
  ├── studio-prisma/ + database.ts 删除 (D2) ← 依赖 B4+C1+C2+C3 (schema 已空)
  ├── index.ts 简化 (D2+D4) ← 依赖 D2 (database.ts 删除)
  ├── studio-cli.ts (D2) ← 依赖 D2
  ├── 7 包 package.json (D2) ← 依赖 D2 (包不存在)
  ├── .env (D2) ← 依赖 D2+D4
  └── D3 (全量验证) ← 依赖 D1+D2

Phase 5 (线上) — 依赖 Phase 1~4 全部完成
  └── dommaker.cn (E1)
```

---

## 存储路径统一

### Auth 存储最终结构

```
~/.studio/
  users.json                     # [{ UserData }]  — 单文件数组
  sessions.jsonl                 # 每行 SessionData — JSONL 追加+重写
```

### Workspace 存储最终结构

```
~/.studio/workspaces/
  {id}.json                      # WorkspaceData (含 tokens/runtimes/repos 嵌套)
  {id}/tasks.jsonl               # TaskData JSONL
  {id}/events.jsonl              # EventData JSONL
```

### middleware/auth.ts 当前路径 → 目标路径

| 数据 | 当前 | 目标 |
|------|------|------|
| User | `~/.studio/data/users/{id}.json` | `~/.studio/users.json` 内查询 |
| Session | `~/.studio/data/sessions/{id}.json` | `~/.studio/sessions.jsonl` 内查询 |
| Workspace | `~/.studio/data/workspaces/{id}.json` | `~/.studio/workspaces/{id}.json` |
| Token | `~/.studio/data/workspace-tokens/{hash}.json` | `workspaces/{id}.json` 的 `tokens[]` |

---

## 模块边界约束

- `auth/service.ts`: 仅操作 `users.json` + `sessions.jsonl`, 不直接访问 workspace 存储
- `middleware/auth.ts`: 读 `sessions.jsonl` + `users.json` (none 模式固定 local 用户), 读 `workspaces/{id}.json` (workspaceAuth)
- Workspace 路由: 读/写 `workspaces/{id}.json` + `tasks.jsonl` + `events.jsonl`
- ws-gateway.ts: 写 `workspaces/{id}.json` (心跳/状态), 内存 map 读多写少
- 迁移脚本: 只读 DB → 只写文件, 不做双写
