# 配置说明

## 配置优先级

| 层级 | 来源 | 说明 |
|:--:|------|------|
| 1 | 代码默认值 | `src/` 中的硬编码默认值 |
| 2 | `.env` 文件 | 项目根、`apps/api/` 下的 `.env` |
| 3 | `.env.production` | 生产环境覆盖 |
| 4 | 系统环境变量 | Shell 中 `export` 的设置，优先级最高 |

高编号覆盖低编号。

---

## 环境变量 (.env)

### 文件位置

| 文件 | 作用域 | 说明 |
|------|:--:|------|
| `.env.example` | 模板 | 不含真实值的示例，可提交到 git |
| `.env` | 开发 | 本地开发配置，gitignore 保护 |
| `.env.production.example` | 模板 | 生产示例 |
| `.env.production` | 部署 | 服务器配置，gitignore 保护 |
| `.env.test` | 测试 | vitest 测试专用 |

### 关键字段

| 字段 | 类型 | 必需 | 说明 |
|------|------|:--:|------|
| `PORT` | `number` | ✅ | API 端口，默认 3001 |
| `NODE_ENV` | `string` | - | `development` / `production` |
| `DATABASE_URL` | `string` | ✅ | SQLite 路径，格式 `file:/path/to/data.db` |
| `JWT_SECRET` | `string` | ✅ | JWT 签名密钥，≥32 字符 |
| `ENCRYPTION_KEY` | `string` | ✅ | LLM 配置加密密钥 |
| `EVENTS_DIR` | `string` | - | 事件 trace 目录，默认 `~/events` |
| `PROJECT_ROOT` | `string` | - | 项目根目录路径 |
| `STUDIO_COMPANY_ID` | `string` | - | CLI 默认 companyId |
| `EXECUTION_MODE` | `string` | - | `queue` / `direct` |
| `DEFAULT_EXECUTION_TIMEOUT` | `number` | - | 默认执行超时（秒），默认 600 |
| `MAX_EXECUTION_TIMEOUT` | `number` | - | 最大执行超时（秒），默认 3600 |

### LLM 配置

LLM 密钥通过加密存储在数据库中（`/api/v1/settings/llm`），也支持环境变量 fallback：

| 字段 | 类型 | 说明 |
|------|------|------|
| `DEEPSEEK_API_KEY` | `string` | DeepSeek API 密钥 |
| `ANTHROPIC_API_KEY` | `string` | Anthropic API 密钥 |

配置模板见 `.env.example`。

---

## Harness (.harness/)

| 文件 | 说明 |
|------|------|
| `.harness/config.yml` | 主配置（预设 `standard`/`strict`/`relaxed`，治理级别） |
| `.harness/checkpoints.yml` | 检查点定义 |
| `.harness/custom-constraints.yml` | 项目专属约束 |

```yaml
# .harness/config.yml
preset: standard
enabled: true
governance: standard
coverage_threshold: 85
```

Agent 执行时，`.harness/` 配置自动传播到 worktree。

---

## Agent 执行

### Worktree 隔离

Agent 在独立的 git worktree 中执行：

| 配置项 | 说明 |
|--------|------|
| `baseBranch` | worktree 基分支，默认 `main` |
| `sessionTimeoutMinutes` | Session 超时，自动清理 worktree |
| `maxRetries` | 审查最大轮数，默认 3 |

### Daemon

| 配置 | 位置 | 说明 |
|------|------|------|
| Session 注册 | `apps/api/src/daemon/studio-daemon.ts` | Analyst + Reviewer 常驻 |
| Session 管理 | `apps/api/src/daemon/session-manager.ts` | 10 秒轮询，状态追踪 |
| 项目注册 | `~/.studio/projects.json` | `studio project add` 注册 |

---

## MCP Server

| 配置 | 说明 |
|------|------|
| Tool Registry | 工具注册 + 限流 (100次/分钟/工具) + 风险等级 |
| Permissions | `MCPPermission` 表，default-deny，角色×工具矩阵 |
| Whitelist | `toolWhitelist` 限制暴露的工具 |

权限配置通过 API 管理：`studio mcp tools` / `studio mcp health`。

---

## CLI

CLI 通过环境变量配置，无需独立文件：

```bash
export STUDIO_COMPANY_ID=default
export PORT=3001
```

```bash
studio up                            # 启动服务
studio status                        # 健康检查
studio goal list                     # 查询 Goal
studio knowledge search "关键词"      # 搜索知识库
```

完整命令列表见 `studio --help` 或 [README.md](../README.md)。

---

## Nginx + Tunnel

| 文件 | 说明 |
|------|------|
| `/etc/nginx/sites-enabled/agent-studio` | 反向代理 + SSE 配置 |
| Cloudflared tunnel | Discord Interactions Endpoint |

详见 [环境搭建文档](environment-setup.md)。

---

## .architect 架构约束

| 文件 | 说明 |
|------|------|
| `.architect/rules.yml` | 架构规则 |
| `.architect/review-rules.yml` | 审查规则 |

---

## 配置模板

所有 `.example` 文件可直接复制使用：

```bash
cp .env.example .env
cp .env.production.example .env.production
vim .env
```
