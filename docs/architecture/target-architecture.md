# 目标架构：前后端分离 + 契约驱动

> 本文是 studio 代码结构的目标架构正本（怎么分层、边界在哪、硬规则是什么）。
> 来源：docs/plans/2026-09-arch-refactor.md（2026-09-30 批准）。
> 数据区布局契约见 data-directory-contract.md；价值分层宪法见 docs/vision-2026.md——本文管代码结构，不管这两层。

## 分层总览

```
apps/web（React 19 + zustand）
    │  import 类型（编译期保证），禁手抄 API 响应类型
    ▼
packages/studio-contract  ← 契约唯一正本（zod schema）
    │  ├─ 推 TS 类型 → 前后端共用
    │  ├─ 后端 defineRoute 做运行时校验
    │  └─ OpenAPI 文档是它的派生物，不是正本
    ▼
apps/api（Express 5）
    bootstrap/      启动编排（按域一个文件，index.ts 只做装配）
    core/http.ts    defineRoute：契约校验 → handler → 统一 envelope → 统一错误映射
    core/store.ts   FileStore 唯一获取口
    modules/<域>/   每域三段式：index.ts（公共出口）/ routes.ts（HTTP 翻译）/ service.ts（业务）
```

## 契约（R1/R2：同一事实只写一份）

- 请求/响应/错误/分页的 schema 全部住在 `packages/studio-contract`，按域一个文件。
- 统一响应壳：成功 `{ data }`（分页 `{ data, pagination }`），失败 `{ error: { code, message } }`。禁止第三种形状。
- 后端路由一律走 `core/http.ts` 的 `defineRoute(schema, handler)`：入参 zod 校验、响应 envelope、错误码映射（消灭手写 `if (!x) return 400` 和 `msg.includes('not found')` 嗅探）。
- 前端 `api/*.ts` 的返回类型一律 `import type` 自 contract，禁止本地重新声明同形 interface。

## 模块边界（R3）

- 跨模块只允许 import 对方模块根 `index.ts` 导出的公共面；深路径 import 由 lint 拦截。
- routes.ts 只做 HTTP 翻译（校验 → service → envelope），业务逻辑在 service 层。
- 循环依赖以 lint 规则显形，新增环即 CI 红。

## 存储边界（R4）

- `new FileStore()` 只允许出现在 `core/store.ts`；消费方经注入获取，禁止模块级单例。
- 模块不得绕过 FileStore 直接用 fs 读写数据区；数据区新子树先过 data-directory-contract.md 的变更纪律。

## 鉴权

- 鉴权姿态只在 route-registry 声明（auth/admin/localhost 三档），路由文件内不再自行挂 `requireAuth()`。

## 性能预算

- 目标值与基线见 `docs/architecture/performance-baseline.md`；ship 前对比，回归 > 20% 需说明。
