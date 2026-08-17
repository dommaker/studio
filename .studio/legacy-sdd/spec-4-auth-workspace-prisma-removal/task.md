---
status: done
version: "1.0"
---

# Task: Auth 双模式 + Workspace 迁移 + 移除 Prisma

## 执行顺序 (5 Phases)

```
Phase 1 [safe] → Phase 2 [breaking] → Phase 3 [breaking] → Phase 4 [destructive] → Phase 5 [safe]
```

### Phase 1: Auth 双模式 [safe]

纯增量, 不改变现有登录行为。可全部并行。

| # | Task | AC | 测试文件 | 预估 |
|---|------|----|---------|------|
| P1.1 | middleware 加 STUDIO_AUTH 判断 | AC-A1 | `middleware/__tests__/auth.test.ts` | 2 files |
| P1.2 | 新增 `GET /api/auth/status` | AC-A2 | `auth/__tests__/routes.test.ts` | 2 files |
| P1.3 | 前端适配 auth/status | AC-A3 | 前端 auth store 测试 + 登录页组件测试 | 2-3 files |

**里程碑**: `STUDIO_AUTH=none` 本地免登录可用, `curl localhost/api/auth/status` 返回正确 mode

---

### Phase 2: User + Session 迁移 [breaking]

Auth service 从 Prisma 切到 FileStore。按 user → session → refreshToken 顺序 (同文件内改动)。

| # | Task | AC | 测试文件 | 预估 |
|---|------|----|---------|------|
| P2.1 | User CRUD 切到 `users.json` | AC-B1 | `auth/__tests__/service.test.ts` | 2 files |
| P2.2 | Session CRUD 切到 `sessions.jsonl` | AC-B2 | 同上 | 1 file (同文件) |
| P2.3 | middleware Session 路径对齐目标 | AC-B2 | `middleware/__tests__/auth.test.ts` | 1 file |
| P2.4 | RefreshToken 合并到 Session | AC-B3 | `auth/__tests__/service.test.ts` | 1 file (同文件) |
| P2.5 | Schema 删除 User/Session/RefreshToken | AC-B4 | — | 1 file |
| P2.6 | 删除 `import { prisma }` 从 auth/service.ts | AC-B5 | tsc 验证 | 1 file |
| P2.7 | `auth/__tests__/service.test.ts` 重写 | AC-B5 | — | 1 file |
| P2.8 | `middleware/__tests__/auth.test.ts` 更新 | AC-B5 | — | 1 file |

**串行约束**: P2.2 依赖 P2.1 (同文件 `service.ts`), P2.4 依赖 P2.2 (session 格式确定), P2.3 依赖 P2.2 (目标路径确定), P2.5 依赖 P2.1+P2.2+P2.4

**里程碑**: `auth/service.ts` 无 Prisma import, schema 剩 10 models

---

### Phase 3: Workspace 迁移 [breaking]

Workspace 模块全量切 FileStore。可部分并行。

| # | Task | AC | 测试文件 | 预估 |
|---|------|----|---------|------|
| P3.1 | `workspace.routes.ts` prisma → FileStore | AC-C1 | `__tests__/workspace.test.ts` | 2 files |
| P3.2 | `token.routes.ts` 路径对齐 workspaces/{id}.json | AC-C1 | `__tests__/token.routes.test.ts` (重写: 旧测试 mock prisma, 源已迁 FileStore) | 2 files |
| P3.3 | `local-workspace.ts` 路径对齐目标 | AC-C1 | — | 1 file |
| P3.4 | `daemon-routes.ts` task+event → FileStore | AC-C2, C3 | `__tests__/daemon-routes.test.ts` | 2 files |
| P3.5 | `task-routes.ts` → FileStore | AC-C2 | `__tests__/task-routes.test.ts` | 2 files |
| P3.6 | `ws-gateway.ts` 内存 map + flush | AC-C4 | `__tests__/ws-gateway.test.ts` | 2 files |
| P3.7 | `gc-service.ts` → FileStore | AC-C6 | `__tests__/gc-service.test.ts` | 2 files |
| P3.8 | Schema 删除 6 个 Workspace model | AC-C1~C3 | — | 1 file |
| P3.9 | 迁移脚本: DB → files + workspace.json 合并 | AC-C5, D1 | — | 1 file (新增) |
| P3.10 | `worktree-resolver.ts` 切 FileStore | AC-C1 | — | 1 file |

**可并行**: P3.1 ‖ P3.2 ‖ P3.3 ‖ P3.4 ‖ P3.5 ‖ P3.6 (6 个独立文件)
**串行**: P3.7 依赖 P3.4 (tasks.jsonl 格式确定), P3.8 依赖 P3.1~P3.7, P3.9 依赖 P3.1~P3.8

**里程碑**: Workspace 模块 0 prisma 引用, schema 剩 0 models

---

### Phase 4: Prisma 移除 [destructive]

删除 studio-prisma 包及所有残留引用。**不可逆, 需确认 Phase 2+3 完成且测试全通过。**

| # | Task | AC | 验证 | 预估 |
|---|------|----|------|------|
| P4.1 | 删除 `packages/studio-prisma/` | AC-D2 | `ls packages/studio-prisma` 不存在 | 1 delete |
| P4.2 | 删除 `apps/api/src/core/database.ts` | AC-D2 | 文件不存在 | 1 delete |
| P4.3 | `index.ts` 移除 DATABASE_URL + connectDatabase | AC-D2, D4 | tsc + grep | 1 file |
| P4.4 | `studio-cli.ts` 移除 prisma 命令 | AC-D2 | grep prisma | 1 file |
| P4.5 | 7 个包 package.json 删 `@dommaker/studio-prisma` 依赖 | AC-D2 | grep | 7 files |
| P4.6 | `.env` / `.env.example` 删 DATABASE_URL | AC-D2 | grep | 2 files |
| P4.7 | 全量验证: grep + tsc + vitest | AC-D3 | 零 prisma 引用 | CI |
| P4.8 | README 更新安装步骤 | AC-D4 | — | 1 file |

**串行**: P4.1 → P4.2~P4.6 (并行) → P4.7 → P4.8

**破坏性确认清单** (P4.1 执行前):
- [ ] Phase 2 全部 AC 通过 (auth service 无 prisma)
- [ ] Phase 3 全部 AC 通过 (workspace 无 prisma)
- [ ] `grep -r "prisma\|@prisma" apps/ packages/ --include="*.ts" --include="*.tsx"` 仅剩 `core/database.ts` + `studio-prisma/` 自身
- [ ] `npx vitest run` 全量通过
- [ ] DB 备份已创建

**里程碑**: `grep -r prisma` 零结果, 全量 test 通过

---

### Phase 5: 线上迁移 [safe]

| # | Task | AC | 验证 |
|---|------|----|------|
| P5.1 | dommaker.cn 执行迁移脚本 | AC-E1 | 登录/Channel/SDD/Agent/知识库 |
| P5.2 | 行数校验 + 删除 DB | AC-E1 | DB 行数 = 文件记录数 |

---

## 契约测试规划

### auth/service.test.ts (重写)

```
MOCK: FileStore (readJson/writeJson/appendJsonl/readJsonl)

AC-B1: User → users.json
  ✓ register() 写入 users.json + 返回 user
  ✓ login() 从 users.json 查 email + 校验密码 (bcrypt/PBKDF2)
  ✓ login() users.json 不存在 → 返回错误
  ✓ login() 密码不匹配 → 401
  ✓ login() 空密码 → 401
  ✓ login() email 不存在 → 401

AC-B2: Session → sessions.jsonl
  ✓ createGuestSession() append 到 sessions.jsonl
  ✓ login() 创建 session → append sessions.jsonl
  ✓ logout() 更新 session.expiresAt → 重写 (JSONL 位置不变, 全量重写)
  ✓ getCurrentUser() 查询 sessions.jsonl
  ✓ cleanupExpiredSessions() 扫描过期 + 移除行
  ✓ 并发登录: 两次 login → 创建 2 个 session

AC-B3: RefreshToken in Session
  ✓ login() 生成 refreshToken → 写入 session 记录
  ✓ exchangeRefreshToken() 验证旧 → 创建新 session + 新 refreshToken
  ✓ revokeRefreshToken() 清空 session.refreshToken

边界:
  ✓ users.json 不存在 → 空数组
  ✓ sessions.jsonl 不存在 → 空文件
  ✓ sessions.jsonl 有效行 + 损坏行 → 忽略损坏行
  ✓ 大量 session (>100) → 过期清理只删过期的
```

### auth/routes.test.ts (扩展)

```
AC-A2: /api/auth/status
  ✓ STUDIO_AUTH=none → { mode: "none", user: { id: "local", name: "Local User", role: "Admin" } }
  ✓ STUDIO_AUTH=on, 有 session → { mode: "on", user: {...} }
  ✓ STUDIO_AUTH=on, 无 session → { mode: "on", user: null }
```

### middleware auth.test.ts (扩展)

```
AC-A1: STUDIO_AUTH
  ✓ STUDIO_AUTH=none: optionalAuth → req.user = local, next()
  ✓ STUDIO_AUTH=none: requireAuth → next()
  ✓ STUDIO_AUTH=on: optionalAuth 有 token → 走 session 校验
  ✓ STUDIO_AUTH=on: optionalAuth 无 token → next() (不报错)
  ✓ STUDIO_AUTH=on: requireAuth 无 token → 401

AC-B2: Session 路径迁移
  ✓ requireAuth 读 sessions.jsonl 而非 per-file JSON
```

### workspace/*.test.ts (重写)

```
MOCK: FileStore (readJson/writeJson/appendJsonl/readJsonl)

AC-C1: Workspace CRUD
  ✗ 旧: prisma.workspace.upsert → 新: fileStore.writeJson workspace/{id}.json
  ✗ 旧: prisma.workspace.findMany → 新: fileStore.readDir + readJson
  ✗ 旧: prisma.workspace.delete → 新: fs.unlink

AC-C2/C3: Task/Event
  ✗ 旧: prisma.workspaceTask.findFirst → 新: fileStore.readJsonl tasks.jsonl + 内存 filter
  ✗ 旧: prisma.workspaceTask.updateMany → 新: claim 读全部行 → 写回 (含变更行)

AC-C4: 内存状态
  ✓ 启动时扫描 workspaces/ 目录重建状态
  ✓ 心跳更新同时写文件和内存
  ✓ 崩溃后重启 → 从文件恢复

AC-C5: workspace.json 合并
  ✓ workspace.json 数据合并到 workspaces/{id}.json, name+workspaceRoot 去重
  ✓ 合并后删除 workspace.json

AC-C6: GC
  ✓ 扫描 tasks.jsonl 找 24h+ old tasks → 删除行 + 删除关联 events
  ✓ 找 72h+ orphan running tasks → 改为 error
```

---

## 里程碑

| Milestone | AC 覆盖 | 验证方式 |
|-----------|---------|---------|
| M1: Auth 双模式 | A1, A2, A3 | `/api/auth/status` 返回 + 本地免登录启动 |
| M2: Auth 迁移 | B1~B5 | `auth/service.ts` 无 prisma import |
| M3: Workspace 迁移 | C1~C7 | `workspace/` 无 prisma import, schema=0 |
| M4: Prisma 移除 | D1~D4 | grep prisma=0, tsc+test 全通过 |
| M5: 线上完成 | E1 | dommaker.cn 正常服务 |

---

## Implementation Readiness

implementationReady: false

| # | 条件 | 满足 | 证据 |
|---|------|------|------|
| 1 | design.md 精确 file:line 引用 | ❌ | 文件级映射, 缺具体行号 (Phase 2+3 文件内部改动点需实现时精确定位) |
| 2 | 非平凡变更有 before/after 代码块 | ❌ | middleware/auth.ts 已有当前代码可直接改; auth/service.ts 需全覆盖重写, before/after 未逐函数列出 |
| 3 | 消费方覆盖 (谁 import 受影响文件) | ✅ | design.md 代码依赖图已覆盖; 探索报告已枚举所有 import 关系 |
| 4 | 测试断言具体 | ✅ | 契约测试规划中每项有具体 assert 描述 |
| 5 | 接口定义完整 (签名+参数+返回值) | ⚠️ | 本地类型定义完整; FileStore 操作接口已列出但签名未含所有参数细节 |

**缺口**:
- 条件1: 需在实现前对 `auth/service.ts` (37处 prisma 调用) 逐函数确认改造点
- 条件2: `auth/service.ts` 改动着面广 (全量重写核心 CRUD), 实现时需逐函数改造+逐测试验证
- 条件5: GC 服务的过期扫描算法伪代码缺失

**建议**: 实现时以 Phase 为单位, 每 Phase 完成后检查 tsc + vitest, Phase 2/3 内部小步迭代 (逐函数改造式迁移), Phase 4 前执行 P4.0 确认清单。
