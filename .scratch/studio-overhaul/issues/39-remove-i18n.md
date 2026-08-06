# 39 — i18n 层移除（G）

Type: task
Status: open
Labels: enhancement, ready-for-agent
Blocked by: 33, 34, 35, 36, 37, 38

## Question

移除形同虚设的 i18n 层（locale 仅 19 key vs 171 处 t() 调用，87 文件硬编码中文）：t() 调用以其中文 defaultValue 替换；无 defaultValue 的少数从 locale 文件取值内联（含插值形态逐一人工核对）；删除 locale 文件、i18n 初始化与 react-i18next 依赖。分批 codemod（每批 ≤30 文件），每批 typecheck。验收：grep 无 t(/useTranslation/react-i18next 残留，typecheck+test 全绿，每批独立 commit。
