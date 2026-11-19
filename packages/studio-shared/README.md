# @dommaker/studio-shared

跨 apps/packages 的共享层：FileStore（文件存储）、eventBus（事件总线）、provider 注册表（agent CLI 定义与 spawn 模板）、共享类型与工具。

## 入口

- `@dommaker/studio-shared`：通用入口（前端可引，无 fs/path/yaml 依赖）
- `@dommaker/studio-shared/web`：前端专用入口（纯逻辑/类型）
- `@dommaker/studio-shared/node`：Node-only 能力（loadConfigEnv 等运行时配置）

模块细节见 `CONTEXT.md` 与 `src/CONTEXT.md`。

## 开发

```bash
# 运行测试
pnpm test

# 构建
pnpm build
```
