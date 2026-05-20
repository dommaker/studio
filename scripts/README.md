# Scripts 使用指南

## 目录结构

```
scripts/
├── dev/          # 开发环境脚本
│   ├── start.sh      # 启动开发环境（vite + API）
│   ├── stop.sh       # 停止开发环境
│   ├── status.sh     # 状态检查
│   ├── logs.sh       # 查看日志
│   └── validate-env.sh
│
├── prod/         # 生产环境脚本
│   ├── build-prod.sh # 只打包前端
│   ├── deploy.sh     # 打包 + 部署到 nginx
│   ├── start.sh      # 启动生产 API
│   ├── stop.sh       # 停止生产 API
│   └── status.sh     # 状态检查（含域名测试）
│
└── tools/        # 工具脚本
    ├── health-check.sh
    ├── status.sh
    └── *.ts          # 各种检查脚本
```

---

## npm 命令

### 开发环境

```bash
npm run dev:start     # 启动开发环境（API:3001, Web:3000）
npm run dev:stop      # 停止开发环境
npm run dev:status    # 状态检查
npm run dev:logs      # 查看日志
```

### 生产环境

```bash
npm run prod:build    # 打包前端静态文件
npm run prod:deploy   # 打包 + 部署到 /var/www/agent-studio
npm run prod:start    # 启动生产 API（端口 13101）
npm run prod:stop     # 停止生产 API
npm run prod:status   # 状态检查 + 域名测试
```

### 数据库

```bash
npm run db:generate       # 生成 Prisma 客户端
npm run db:migrate        # 运行迁移（开发）
npm run db:migrate:prod   # 运行迁移（生产）
npm run db:studio         # 打开 Prisma Studio
```

### 单独启动（调试用）

```bash
npm run dev:api       # 只启动 API
npm run dev:web       # 只启动前端
npm run build:api     # 只构建 API
npm run build:web     # 只构建前端
```

---

## 环境区分

| 环境 | 端口 | 数据库 | 前端方式 | 命令 |
|------|------|--------|----------|------|
| **开发** | 3001 + 3000 | agent_studio_test | vite dev | `npm run dev:*` |
| **生产** | 13101 | agent_studio_prod | nginx 静态 | `npm run prod:*` |

---

## 快速操作

### 启动开发调试

```bash
npm run dev:start
# → http://localhost:3000
```

### 部署线上更新

```bash
npm run prod:deploy
# → https://dommaker.cn 更新
```

### 重启线上服务

```bash
npm run prod:stop
npm run prod:start
```

---

## 日志位置

```
/tmp/studio-api-dev.log    # 开发 API 日志
/tmp/studio-web-dev.log    # 开发 Web 日志
/tmp/studio-api-prod.log   # 生产 API 日志
/var/log/nginx/error.log   # nginx 错误日志
```

---

*整理时间: 2026-04-26*