# AGENTS.md

> 本文件由 `harness sync-docs --agents` 自动生成，请勿手改。`<!-- PRESERVE:名称 -->` 与 `<!-- /PRESERVE:名称 -->` 之间的内容在重新生成时原样保留。内容漂移时重新运行该命令更新。

## 项目简介

**@dommaker/studio** — Agent Studio - Multi-Agent Collaboration Platform

## 目录结构

| 目录 | 说明 |
|------|------|
| `.github/` | CI/CD 配置 |
| `.harness/` | harness 配置与运行时状态 |
| `apps/` | monorepo 应用：api、web |
| `bin/` | 可执行入口/脚本 |
| `docs/` | 项目文档 |
| `node-compile-cache/` | — |
| `packages/` | monorepo 共享包：studio-agent、studio-audit、studio-capability、studio-monitor、studio-notification、studio-shared、studio-skill、studio-spec、studio-task |
| `scripts/` | 工具脚本 |
| `tests/` | 测试 |

## 常用命令

```bash
pnpm dev  # 启动开发环境
pnpm build  # 构建
pnpm test  # 运行测试
pnpm test:e2e  # 端到端测试
pnpm typecheck  # 类型检查
pnpm lint  # 代码检查
pnpm start  # 启动生产服务
```

## 约束与治理

- 治理配置：`.harness/config.yml`（preset: standard）
- 约束清单：`CLAUDE.md` Governance Rules 块（Iron Laws 11 条、Guidelines 25 条）

## 知识入口

- `.harness/knowledge/`：项目知识库（865 条），用 `harness knowledge` 查询
- 各源码目录的 `CONTEXT.md` 是权威模块文档（现有 48 个），改动代码时同步更新
