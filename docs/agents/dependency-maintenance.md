# 依赖更新与公告 triage

## 固定节奏

- Dependabot 每周检查 npm workspace 与 GitHub Actions；更新 PR 必须保留 lockfile、完整 SHA pin 和既有安全门。
- CI 与 Release 使用 `corepack enable` 读取根 `packageManager`，安装一律 `pnpm install --frozen-lockfile`。禁止在 workflow 全局安装浮动版本工具。
- 合并依赖更新前运行相关测试、typecheck/build，以及官方公告源的 `pnpm audit --prod --audit-level high --registry=https://registry.npmjs.org`。

## 可达性 triage

1. 先用 `pnpm why <package> --recursive` 确认直接依赖、传递链和生产/开发归属；不能用公告数量代替风险判断。
2. 生产 high/critical 默认阻断。优先升级到包含修复的最小兼容版本，再运行实际消费面的回归测试；跨 major 必须先列破坏性变更并写迁移回归。
3. 按真实运行面判断：Node HTTP adapter、浏览器代码、本地构建工具和运行时输入解析不能互相套用结论。浏览器使用 Axios 不等于 Node adapter 公告在浏览器 critical；Tailwind/Postcss 等纯构建依赖归 `devDependencies`。
4. 若公告仍存在，合并说明必须记录包与版本、GHSA/CVE、依赖路径、不可达或仅 dev 的证据、残余风险和后续条件。没有这类证据不得标记为已解决。
5. 不用永久 override 掩盖可升级公告。确需临时 pin 时写明上游约束和移除条件，并在下一次周更复查。

## SEC-08 残余公告

官方 registry 的 `pnpm audit --prod` 已无公告；完整 `pnpm audit` 仍有一项 **dev-only high**，不得据此宣称全依赖树清零：

- `zod@3.25.76` / GHSA-mrhx-c7xc-m3w5，路径仅为 `apps/web > eslint-plugin-react-hooks > zod`（及同链 `zod-validation-error`）。它属于本地 lint 开发依赖，不进入生产依赖树；根、API 与 contract 的运行时 Zod 均为 `4.6.7`。不对该传递依赖强制跨 major override，避免为消公告破坏 lint；由每周 Dependabot 跟踪上游兼容更新。
