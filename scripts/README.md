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
└── tools/        # 工具脚本
    ├── health-check.sh
    ├── status.sh
    └── *.ts          # 各种检查脚本
```

> 生产环境的部署/启停脚本维护在私有运维仓，不随本仓发布。
> 生产 API 由 systemd `studio-api.service` 统一管理（`Restart=always`），
> 禁止用 pm2 / nohup 等方式另起进程（多监管者会互相抢端口）。

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
npm start                            # 直接以前台方式启动 API（等价 npx tsx apps/api/src/index.ts）
systemctl restart studio-api.service # 线上重启（部署自动化由私有运维仓负责）
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

| 环境 | 端口 | 前端方式 | 命令 |
|------|------|----------|------|
| **开发** | 3001 + 3000 | vite dev | `npm run dev:*` |
| **生产** | 13101 | nginx 静态 | systemd 管理，部署脚本在私有运维仓 |

---

## 快速操作

### 启动开发调试

```bash
npm run dev:start
# → http://localhost:3000
```

### 重启线上服务

```bash
systemctl restart studio-api.service
```

---

## 日志位置

```
/tmp/studio-api-dev.log        # 开发 API 日志
/tmp/studio-web-dev.log        # 开发 Web 日志
journalctl -u studio-api.service   # 生产 API 日志（systemd journal）
/var/log/nginx/error.log       # nginx 错误日志
```

---

*整理时间: 2026-04-26（2026-07-24 更新：生产脚本移出本仓，生产进程 systemd 统一管理）*
