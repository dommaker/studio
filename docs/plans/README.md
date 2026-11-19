# docs/plans — 演进计划

约定（#696，2026-10-11）：

- **活跃计划**住本目录，必须带 YAML frontmatter `status` 字段（`active` / `done` / `stale`）。
- **历史计划**（完成/废弃）一律移入 `_archive/`，不再以文件名日期猜测状态。
- `_archive/` 内文件不再维护，仅作历史参考；引用时认准文件名，路径漂移不保证。

> 注意：`docs/*` 整体在 .gitignore 忽略清单内（仅 adr/、visual-reports/、specs/ui/style-guide.md 豁免），
> 本目录只有部分文件被 git 跟踪；归档移动对未跟踪文件是纯本地操作。
