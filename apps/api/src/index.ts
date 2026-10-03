// Pipeline Studio - 主入口
// P2-a：启动编排已拆至 ./bootstrap/（按职责一个文件，bootstrap/index.ts 只做装配），
// 本文件只剩：KNOWLEDGE_DIR 钉值（必须先于业务模块使用）+ 调 bootstrap 装配。
import 'dotenv/config';

// 固定 KnowledgeStore 路径 — CWD 无关, 与 memory-knowledge-sync hook 共用
// #571：缺省自 monorepo 相对路径迁至数据根 harness-knowledge（契约 §8 待归位），env 可覆盖
import { defaultKnowledgeDir } from './utils/runtime-paths.js';
process.env.KNOWLEDGE_DIR = defaultKnowledgeDir();

import { bootstrap } from './bootstrap/index.js';

bootstrap();
