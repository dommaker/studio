# apps/api/src/modules/library

### 职责

阅览室（#155 T5）：跨项目 `.studio/` 文档面的聚合只读层。缺省遍历全部有 `gitRepo` 的 PMO 项目，读各仓 `.studio/` 下的 `specs/`、`research/`、`CONTEXT.md` + 仓根 `docs/adr/`（ADR 例外：2026-08-21 落点模型裁决，原 `.studio/adr/` 废止，#305 适配；`?project=` 收窄单项目）；`legacy-sdd/<slug>/` 三层遗产 SDD 文档打 `legacy: true` 标记只读展示。无写路径——文档随各仓演进，变更历史 = git 历史。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `libraryRoutes` | `library.routes.ts` | Express 路由，注册 `/api/v1/library` 下的 GET 列表（query: project/search）、GET /:id 详情端点（只读，无 PUT/POST/DELETE） |
| `listLibraryDocs` | `library.service.ts` | 跨仓聚合文档列表（`{ projectId?, search? }`），返回 `LibraryListItem[]`（id = `projectId:relPath`，projectId 为 PMO 项目真值） |
| `getLibraryDoc` | `library.service.ts` | 按 `projectId:relPath` 取详情；防路径穿越（resolve 后必须落在对应文档面根内：`.studio/` 根或仓根 `docs/adr/`）；legacy 文档带 requirement/design/task 三段 |

### 依赖关系

上游：
- `@dommaker/studio-shared`（`FileStore`（读穿 seam）、`logger`、`listLegacySddDocs`、`readLegacySddDoc`）
- `@dommaker/studio-shared/studio-dir`（`legacySddDir`）
- `apps/api/src/modules/pmo/project.service.ts`（PMO 项目清单，只取 `gitRepo` 非空）
- `express`（Router）

下游：
- `apps/api/src/route-registry.ts`（引入 `libraryRoutes` 并挂载至 `/api/v1/library` 路径）

### 注意事项

- 只读层：无任何写端点；文档变更走各仓 git，不走 API
- **#321 读路径已收进 FileStore 读穿 seam**：markdown 读走 `FileStore.readDocWithMtime`、目录列举走 `FileStore.readdir`（均为 mtime 校验的读穿缓存，ADR 2026-08-24-cache-seam-decision-rules 决策树第 1 问）；命中仅 stat 不重读内容，外部进程写入经 mtime 变化触发重读。模块内不得再引入裸 `fs` 读文档内容；对外部项目仓零写入（不落 `_index.md` 等索引文件）
- benchmark（2026-08-25，dev 规模 P×D ≈ 2×114）：温缓存 list 无 search ≈ 7-10ms，温 search ≈ 13ms，远 < 100ms 阈值 → 聚合 memo 层判定 YAGNI；上量后复查流程挂 #334
- title 兜底链：frontmatter title → 首个 H1 → 文件名；updatedAt 兜底链：frontmatter updatedAt → 文件 mtime
- 单仓读失败（目录不存在/权限）不炸整体，跳过并 `logger.warn`
- 前端 id 整段 `encodeURIComponent` 传入（含 `:` 与 `/`），路由侧 decode 后按首个冒号切分 projectId/relPath
- adr 面 relPath = `docs/adr/<name>.md`（相对仓根），其余面相对 `.studio/`；KIND_DIRS 的 `root` 字段区分两类基座
