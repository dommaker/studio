# 03 — 死代码 / 冗余依赖 / 候选废弃功能调研

Type: research
Status: resolved

## Question

全仓（apps/ + packages/，排除 node_modules/dist）死代码与废弃资产盘点：未被引用的导出/组件/工具方法/样式/常量、冗余或未使用的 package.json 依赖、大面积注释掉的代码块与废弃注释、疑似废弃功能（无入口路由、无调用方 API 端点、deprecated 标记、默认关闭从未启用的开关，例如旧 review 栈残余、design-lab/PrototypeShell、PMO/OKR 的实际使用情况）。每项须给出引用链证据（谁还在引用 / 确认零引用），产出候选废弃清单。

## Answer

已解决（subagent 全仓排查，全部附引用链证据）。报告：`../research/03-dead-code.md`（中间数据 `../tmp/`）。

要点：①确定零引用导出 59 项（api 35/web 11/packages 13）+ 仅测试引用 28 项；②零引用前端资产 14 组件 + 死 css/静态资源；③确定冗余依赖 6 项（multer+@types、undici、ioredis、zod×4 包、@types/react-router-dom）；④候选废弃功能 12 项，最高置信度：studio-monitor 整包、STUDIO_TASK_QUEUE_ENABLED 任务队列（连带 studio-task）、前端旧 review 四件簇、spec-reviews 模块、crypto/discovery-exposure/gc-service 三整文件、4 个死端点、design-lab（有路由无导航全 mock）；⑤每项候选均附连带孤儿清单（报告 §6）；⑥PMO OKR 主链路、KnowledgeGraphView 链路确认存活勿删。
