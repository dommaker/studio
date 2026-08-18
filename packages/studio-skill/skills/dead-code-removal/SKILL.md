---
name: dead-code-removal
description: "彻底清理已废弃的代码概念：跨 schema、后端、前端、packages 全链路删除。"
agentTypes: [refactor]
triggers: [死代码, 删除废弃模块, dead code, 清理旧概念, 删除字段, 删除路由, dead code removal, 废弃清理, 全链路清理]
status: published
---

# Dead Code Removal

彻底删除已废弃的代码概念。不是"隐藏入口"，是从 schema 到 UI 的完整清理。

## 为什么需要系统化流程

"删除一个废弃概念"听起来简单，但实际涉及 schema 关系、API 路由、service 调用、前端页面、组件、store、类型、事件、i18n、packages 共享代码、migration 历史等十几个层面。遗漏任何一层都会留下死引用，导致构建失败或运行时错误。

本 skill 提供分层执行框架，按风险从低到高逐层清理，每层验证后再进入下一层。

## 硬门禁：验证废弃前提

<HARD-GATE>
在开始删除前，必须完成以下验证。跳过任何一项都可能导致误删活跃功能。
</HARD-GATE>

1. **架构文档确认**：读架构文档（SDD/spec/memory）确认该概念已被明确替代。不能仅凭"看起来没用"判断。
2. **替代品已上线且活跃**：grep 消费方代码，确认替代方案正在被使用。例如删除 Role 前确认 AgentProfile 已有活跃消费方。
3. **区分同名不同义**：某些名称在不同上下文有不同含义。例如 `roleId` 在 RuntimeInstance 中实际指向 AgentProfile.id（命名误导），不应删除。记录这类情况但不改动。
4. **区分知识飞轮功能**：某些看似废弃的函数（如 `classifyWorkflow`）可能是知识提取管线的关键环节。重命名而非删除（如 `classifyPattern`）。

产出：废弃前提验证表，记录每条验证的结论和证据。

## 全景排查

在验证废弃前提后，执行全代码库搜索，建立完整的待清理清单。

### 搜索维度

| 层 | 搜索范围 | 关键模式 |
|---|---------|---------|
| **Schema** | `prisma/schema.prisma` | model 定义、relation、FK、index |
| **后端 API** | `apps/api/src/modules/` | 路由注册、service 方法、类型定义 |
| **后端入口** | `apps/api/src/route-registry.ts`、`apps/api/src/middleware/` | import 和注册 |
| **后端消费方** | `apps/api/src/modules/*/` | grep model 名、service 名、方法名 |
| **前端页面** | `apps/web/src/pages/` | 页面组件 |
| **前端路由** | `apps/web/src/App.tsx` | lazy import、Route 定义 |
| **前端导航** | `apps/web/src/components/TopNav.tsx`、`Sidebar*.tsx` | nav link |
| **前端组件** | `apps/web/src/components/` | 专属组件（只被废弃功能使用） |
| **前端状态** | `apps/web/src/stores/`、`hooks/` | store 方法、hook 调用 |
| **前端类型** | `apps/web/src/types/` | interface、type 定义 |
| **packages 共享** | `packages/*/src/` | 类型、常量、事件、工具函数 |
| **MCP tools** | `apps/api/src/modules/mcp/` | tool 定义 |
| **CLI** | `apps/api/src/cli/` | 命令分支 |
| **测试** | `tests/`、`**/__tests__/`、`**/*.test.ts` | 测试文件和 mock |
| **文档** | `docs/specs/`、`CONTEXT.md` | 架构文档、模块说明 |

### 分类：专属文件 vs 混合文件

搜索完成后，将每个命中文件分为两类：

- **专属文件**：整个文件只服务于废弃概念。→ 整文件删除。
- **混合文件**：文件中还包含其他活跃功能。→ 逐行清理引用。

这个区分至关重要。专属文件整删风险低，混合文件逐删风险中。分层执行时先处理专属文件。

## 分层执行

按风险从低到高执行。每层完成后验证构建通过，再进入下一层。

| 顺序 | 范围 | 风险 | 关键动作 |
|------|------|------|---------|
| 1 | 专属文件整删 | 低 | 确认无消费方后 `rm` |
| 2 | 路由 + import 清理 | 低 | 删 lazy import、Route、nav link、route-registry 注册 |
| 3 | 前端混合文件 | 中 | 逐文件删引用，验证页面渲染 |
| 4 | 后端混合文件 | 中 | 删 service 调用、API 查询、MCP tool |
| 5 | packages 共享代码 | 中 | 类型/常量/事件清理 |
| 6 | Schema migration | 高 | 删 model + FK 关系，处理历史 migration |

### 每层详细操作

**Layer 1：专属文件整删**

- 对每个专属文件，先 `grep -r "文件名（不含扩展名）" src/` 确认零消费方
- 确认后直接 `rm`
- 包括：专属页面、专属组件、专属 service、专属路由文件、专属测试、专属文档

**Layer 2：路由 + import 清理**

- `App.tsx`：删 lazy import + `<Route>`
- `TopNav.tsx` / `Sidebar*.tsx`：删 nav link
- `route-registry.ts`：删 import + `.use()` 注册
- `middleware/auth.ts`：删 resource type case

**Layer 3：前端混合文件**

- 逐文件处理。每个文件：
  1. 读全文，理解结构
  2. 定位废弃引用（import、props、变量、JSX 块）
  3. 外科手术式删除，不改动其他逻辑
  4. 如果删除导致类型不匹配（如 props 缺失），同步修改调用方

**Layer 4：后端混合文件**

- 逐文件处理。每个文件：
  1. 读全文，理解结构
  2. 定位废弃引用（import、service 调用、Prisma 查询、MCP tool）
  3. 外科手术式删除
  4. 注意：某些字段可能是"命名误导但实际活跃"（如 RuntimeInstance.roleId → AgentProfile），记录但不删

**Layer 5：packages 共享代码**

- `packages/studio-prisma/src/index.ts`：删 JSON 字段截断配置
- `packages/studio-shared/`：删事件枚举值、常量、工具函数
- `packages/studio-agent/`：删类型联合项
- `packages/studio-task/`：删接口字段、事件过滤
- `packages/studio-audit/`：删资源枚举项
- 同步更新对应测试文件

**Layer 6：Schema migration**

这是最高风险的操作，必须放在最后。

1. **先处理 FK 依赖**：如果其他 model 通过 FK 引用待删 model，先决定：
   - 保留字段但删除 relation（字段变为普通 string）
   - 还是连字段一起删除
   - 根据业务意义判断，不盲目删除
2. **删除 model 定义**：从 `schema.prisma` 中删除 `model` 块
3. **删除关联 model**：如果有只服务于待删 model 的关联 model（如 RoleMemoryEntry 只属于 Role），一起删除
4. **检查 migration 历史**：
   - 如果有历史 migration 引用了已删除的表（通过 `grep` 检查 `migration.sql`），这些 migration 会导致 `migrate dev` 失败
   - 方案：删除问题 migration + 用 `prisma db push` 直接同步 schema
   - 这是务实选择：migration 历史不完整时，`db push` 比修复每个 migration 更可靠
5. **验证**：`prisma validate` 确认 schema 合法

## 每阶段验证

每完成一层，执行以下验证：

```bash
# 1. 构建检查（TypeScript 类型）
pnpm -C apps/web run build  # 或 tsc --noEmit
pnpm -C apps/api run build

# 2. 搜索残留
grep -r "废弃关键词" apps/ packages/ --include="*.ts" --include="*.tsx"

# 3. 如果有类型错误，立即修复后再进入下一层
```

不要累积错误。每层清零。

## 常见陷阱（Anti-Pattern）

| 陷阱 | 为什么是陷阱 | 正确做法 |
|------|------------|---------|
| "字段没用了"但 schema 还有 | Schema 字段会生成 Prisma 类型，污染整个代码库 | 必须从 schema 删除 |
| Migration 历史引用已删除表 | `migrate dev` 会尝试执行引用不存在表的 SQL | 删除问题 migration + 用 `db push` |
| 知识飞轮功能被当死代码删 | `classifyWorkflow()` 看似引用旧概念，实际是模式检测管线 | 重命名（`classifyPattern`）而非删除 |
| 字段名误导就删 | `RuntimeInstance.roleId` 名字含 "role" 但实际指向 AgentProfile.id | 记录命名问题但不改动，避免破坏活跃功能 |
| 只删 UI 入口不删路由 | 页面不可见但 API 仍在，成为死端点 | 全链路清理 |
| 只删路由不删 service | Service 方法仍在，可能被其他代码调用 | grep 确认零消费方后删除 service |
| 只删 service 不删 schema | Schema model 仍生成类型，可能误导开发者 | 最后清理 schema |
| 不验证替代品活跃度 | 以为新概念已上线，实际还是空壳 | grep 消费方代码确认活跃度 |
| 批量删除不验证 | 一次删太多文件，构建失败时难以定位 | 分层执行，每层验证 |
| 不区分专属/混合文件 | 误删混合文件中的活跃代码 | 分类后再决定整删还是逐删 |

## 检查清单

完成全部清理后，逐项确认：

- [ ] 架构文档确认概念已废弃
- [ ] 替代品已上线且活跃（grep 消费方）
- [ ] 全景排查覆盖所有层（schema→后端→前端→packages→测试→文档）
- [ ] 区分专属文件和混合文件
- [ ] 按分层顺序执行（低→高风险）
- [ ] 每阶段验证构建通过（`tsc --noEmit` / `build`）
- [ ] 每阶段 grep 确认零残留
- [ ] Schema 先处理 FK 依赖再删 model
- [ ] 检查 migration 历史是否引用已删除表
- [ ] `prisma validate` 验证 schema 合法
- [ ] 最终全代码库 grep 确认零残留
- [ ] 命名误导但活跃的字段已记录但不改动
- [ ] 知识飞轮功能已重命名而非删除

## 产出

执行完成后，输出清理报告：

1. **删除文件清单**：列出所有整删的专属文件
2. **修改文件清单**：列出所有逐行清理的混合文件，说明删了什么
3. **Schema 变更**：列出删除的 model/字段/关系
4. **命名问题记录**：列出发现但未改动的命名误导项
5. **知识飞轮保留**：列出重命名的功能（旧名→新名）
6. **验证证据**：构建通过输出 + grep 零残留输出
