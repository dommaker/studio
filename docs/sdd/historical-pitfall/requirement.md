---
id: "hmqdkg096sqrg9z"
slug: "historical-pitfall"
title: "Historical Knowledge: pitfall"
status: "done"
tier: "fast"
version: 1
requirementVersion: 1
designVersion: 0
taskVersion: 0
tags: ["pitfall", "historical", "entries:14"]
createdAt: "2026-06-14T09:12:30.282Z"
updatedAt: "2026-06-14T09:12:30.282Z"
---

# Historical Knowledge: pitfall

Auto-generated from 14 knowledge entries.
Source: `~/.studio/knowledge/`

## Summary

This document aggregates historical pitfall knowledge entries
extracted from the knowledge store. Each entry is preserved as a subsection
for reference and future SDD evolution.

## Entries

- [[Discovery] No Authorization header sent on any API request](#discovery-no-authorization-header-sent-on-any-api-) (PIT-015)
- [[Discovery] PUBLIC_API /auth/register — false positive in auto-discovery](#discovery-public-api-auth-register-false-positive-) (PIT-013)
- [[Exec] executor: # JWT Auth + Token Refresh + OAuth2.0 — 剩余缺口闭合 (Interceptor + Fragment Security)](#exec-executor-jwt-auth-token-refresh-oauth2-0-inte) (PIT-012)
- [>-](#doc-1781428350282) (PIT-003)
- [>-](#doc-1781428350282) (PIT-004)
- [>-](#doc-1781428350282) (PIT-005)
- [>-](#doc-1781428350282) (PIT-006)
- [>-](#doc-1781428350282) (PIT-010)
- [|-](#doc-1781428350282) (PIT-009)
- [|-](#doc-1781428350282) (PIT-011)
- [|-](#doc-1781428350282) (PIT-014)
- [API not responding](#api-not-responding) (PIT-008)
- [events-daemon 与 API 端口不匹配导致 session:archive 事件处理失败](#events-daemon-api-session-archive) (PIT-002)
- [Integration卡住：harness符号链接指向不存在路径](#integration-harness) (PIT-007)

## [Discovery] No Authorization header sent on any API request

- **ID**: `PIT-015`
- **Source**: `pitfall-PIT-015.md`
- **Created**: 2026-06-09T08:55:59.158Z

api/index.ts has no request interceptor. authStore.getAuthHeader() exists but is never wired to axios. All 47+ API consumers send requests without auth tokens. Only guest sessions work because optionalAuth handles missing tokens gracefully.
File: apps/web/src/api/index.ts

## [Discovery] PUBLIC_API /auth/register — false positive in auto-discovery

- **ID**: `PIT-013`
- **Source**: `pitfall-PIT-013.md`
- **Created**: 2026-06-09T09:37:44.083Z

Auto-discovery reported /auth/register missing from PUBLIC_API, but it is already present at line 80. No action needed.
File: apps/api/src/app.ts

## [Exec] executor: # JWT Auth + Token Refresh + OAuth2.0 — 剩余缺口闭合 (Interceptor + Fragment Security)

- **ID**: `PIT-012`
- **Source**: `pitfall-PIT-012.md`
- **Created**: 2026-06-09T10:36:39.696Z

Agent: executor
Success: false
Duration: 114959ms
Diff (68 chars): Max sessions (5) exhausted. Last error: Command exited with code 1:

## >-

- **ID**: `PIT-003`
- **Source**: `pitfall-PIT-003.md`
- **Created**: 2026-06-12T01:39:07.447Z

⚠️ parseFrontmatter 正则中 \w+ 不匹配连字符——但 SKILL.md 的 key 都是单词（name/trigger/tier），无连字符 key，安全

## >-

- **ID**: `PIT-004`
- **Source**: `pitfall-PIT-004.md`
- **Created**: 2026-06-12T01:39:07.568Z

⚠️ skillLoaderService.loadSkill 内部调 prisma.studioEvent.create（L252），测试中 prisma mock 必须覆盖此调用否则报错

## >-

- **ID**: `PIT-005`
- **Source**: `pitfall-PIT-005.md`
- **Created**: 2026-06-12T01:39:07.689Z

⚠️ role-skill-binding.test.ts L81-83 mock skillLoaderService 用的是 vi.fn()，不 mock loadSkillFromDisk——测试只验证 loadSkill 被调用，不验证磁盘读取

## >-

- **ID**: `PIT-006`
- **Source**: `pitfall-PIT-006.md`
- **Created**: 2026-06-12T01:39:07.924Z

⚠️ 现有 SKILL.md 无 triggers.intent 字段——intent-router 模块创建后暂无数据可匹配，需后续补充 SKILL.md 内容

## >-

- **ID**: `PIT-010`
- **Source**: `pitfall-PIT-010.md`
- **Created**: 2026-06-09T15:23:22.355Z

Goal: cmq6qvna1001apuv9qmjuanrt
Error: Max sessions (5) exhausted. Last error: ENOENT: no such file or directory, open '/root/worktrees/cmq6qvnas001epuv9zr89ik9n/.agent.log'
Tier: standard
Strategy: normal

## |-

- **ID**: `PIT-009`
- **Source**: `pitfall-PIT-009.md`
- **Created**: 2026-06-12T03:01:24.980Z

Agent: executor
Success: false
Duration: 165690ms
Diff (45 chars): Max sessions (5) exhausted without completion

## |-

- **ID**: `PIT-011`
- **Source**: `pitfall-PIT-011.md`
- **Created**: 2026-06-09T16:41:41.194Z

Agent: executor
Success: false
Duration: 533603ms
Diff (134 chars): Max sessions (5) exhausted. Last error: ENOENT: no such file or directory, open '/root/worktrees/cmq6uyy2c00gvpuv97u23jupx/.agent.log'

## |-

- **ID**: `PIT-014`
- **Source**: `pitfall-PIT-014.md`
- **Created**: 2026-06-09T04:12:49.808Z

Agent: executor
Success: false
Duration: 54162ms
Diff (68 chars): Max sessions (5) exhausted. Last error: Command exited with code 1:

## API not responding

- **ID**: `PIT-008`
- **Source**: `pitfall-PIT-008.md`
- **Created**: 2026-06-12T02:54:29.144Z

API on port 13101 is not responding. Time: 2026-06-12T02:54:29.013Z

## events-daemon 与 API 端口不匹配导致 session:archive 事件处理失败

- **ID**: `PIT-002`
- **Source**: `pitfall-PIT-002.md`
- **Created**: 2026-05-28T17:05:13.330Z

根因：events-daemon 默认使用 3001 端口连接 API，但实际 API 运行在 13101 端口，导致 session:archive 事件无法被正确接收和处理。
责任归属：开发流程缺乏端口一致性校验机制，且 events-daemon 启动配置未随 API 端口变更而同步更新。
预防措施：1) 在 events-daemon 启动脚本中强制指定 API_PORT=13101 环境变量；2) 在 CI/CD 流程中增加端口连通性测试；3) 将 API 端口配置集中管理（如环境变量或配置文件），避免硬编码默认值。

## Integration卡住：harness符号链接指向不存在路径

- **ID**: `PIT-007`
- **Source**: `pitfall-PIT-007.md`
- **Created**: 2026-06-13T03:37:58.031Z

根因：worktree中node_modules/@dommaker/harness是符号链接，指向../../../harness，但worktree环境中该路径不存在，导致73个测试文件加载失败。责任归属：Integration阶段未做依赖预检。预防措施：Integration开始前验证关键符号链接可达，失败时自动修复为绝对路径；或使用ln -s绝对路径创建链接。
