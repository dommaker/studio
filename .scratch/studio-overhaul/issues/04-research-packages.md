# 04 — packages/ 子包调研

Type: research
Status: resolved

## Question

packages/ 下 9 个子包（studio-agent、studio-audit、studio-capability、studio-monitor、studio-notification、studio-shared、studio-skill、studio-spec、studio-task）的现状：各包职责与对外导出、大文件（file-store.ts 1334 行、company-mcp-pool.ts 574 行、capability.service.ts 526 行等）结构、跨包依赖关系、包内死代码与明显冗余、是否有已无人使用的整包或大半包。产出可供"只清死代码、不做接口级重构"原则下直接消费的调研报告。

## Answer

已解决（subagent 调研）。报告：`../research/04-packages.md`。

要点：①9 包健康档案齐全，依赖图无循环；②可清死代码量大：studio-capability 67%（company-mcp-pool 574 行纯占位、市场四方法零调用）、studio-audit 63%（audit-chain 446 行零引用 + mock CLI）、studio-monitor/studio-task 实质整包待删、studio-shared ~1500 行（死工具/常量/llm-client/FileStore 死方法）、studio-agent agent-completer 整模块、studio-spec SpecValidator 集群 562 行；③file-store.ts Requirement/Evolution 两段近 170 行逐行复制；④frontmatter 解析 3 份实现、ID 生成 6 处重复；⑤报告附按风险排序的四步清理顺序建议。
