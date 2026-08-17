# legacy-sdd — SDD 三层文档遗产归档（只读）

2026-08-15 起（T5 决议，#155）：旧 SDD 体系（`docs/sdd/<slug>/{requirement,design,task}.md`）退役，44 个 slug 原样迁入本目录并 git 入库，不做格式转换。

- 本目录**只读**，不新增、不扩展；变更历史 = git 历史。
- 现役 spec 落点 = 业务仓 `.studio/specs/`（`specsDir(repoRoot)`，见 `@dommaker/studio-shared/studio-dir`）。
- 浏览入口 = library 阅览室（`/api/v1/library`，legacy 标记只读展示）。
- 代码读取走 `@dommaker/studio-shared` 的 `sdd-legacy.ts`（显式 baseDir，无 env fallback）。
