# 39 — i18n 层移除（G）

Type: task
Status: resolved
Labels: enhancement, ready-for-agent
Blocked by: 33, 34, 35, 36, 37, 38

## Question

移除形同虚设的 i18n 层（locale 仅 19 key vs 171 处 t() 调用，87 文件硬编码中文）：t() 调用以其中文 defaultValue 替换；无 defaultValue 的少数从 locale 文件取值内联（含插值形态逐一人工核对）；删除 locale 文件、i18n 初始化与 react-i18next 依赖。分批 codemod（每批 ≤30 文件），每批 typecheck。验收：grep 无 t(/useTranslation/react-i18next 残留，typecheck+test 全绿，每批独立 commit。

## Answer

已解决，4 个 commit（`c799bf1a`/`b96d7a7d`/`d9b4afb5`/`f6ca8a6b`）。实际 t() 调用 54 处（带 defaultValue 47、无 defaultValue 7 从 zh-CN 取值、插值 1 处人工核对改模板字符串）；LanguageSettings 整体删除（单语言无意义）；src/i18n/、LanguageSwitcher、main.tsx 引入、i18next×2+react-i18next 依赖与 vite manualChunks 分包规则全清。最终 grep 零残留（源码/package.json/lockfile）。typecheck 每票前 exit 0，test 3984 passed / 0 failed。
