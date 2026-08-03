/**
 * Vitest setupFiles - B1 测试数据隔离（2026-08-03 unattended-token-burn issue）
 *
 * 每个测试文件进程强制使用独立临时数据根，禁止测试写生产 ~/.studio/data。
 * 历史事故：路由测试经真实 FileStore 把测试 WU 写进生产数据根，daemon 当真任务执行。
 *
 * 时机说明：setupFiles 先于测试模块 import 执行，因此：
 * - FileStore 构造时读取的 process.env.STUDIO_DATA_DIR 已指向临时目录；
 * - studio-shared config 的 `STUDIO_DATA_DIR ??= ~/.studio/data` 钉值保留既有值。
 * pool=forks 下每个测试文件一个进程，mkdtemp 互不相撞。
 *
 * 残余风险（本文件不覆盖）：knowledge/trends 等模块在 import 期冻结 os.homedir()
 * 常量（不读 STUDIO_DATA_DIR），相关测试仍可能触碰 ~/.studio/knowledge 等目录。
 *
 * 注意（2026-08-03）：禁止 `import os from 'node:os'` -- ESM 加载会创建冻结的 namespace
 * object，导致测试文件的 vi.hoisted 经 require 补丁 os.homedir 失效（auditor-reports/
 * session-summary 测试的隔离机制依赖 homedir 补丁）。用 process.env.TMPDIR 代替 os.tmpdir()。
 */
import fs from 'node:fs';
import path from 'node:path';

const tmpDir = process.env.TMPDIR || '/tmp';
const isolatedRoot = fs.mkdtempSync(path.join(tmpDir, 'studio-test-data-'));
process.env.STUDIO_DATA_DIR = path.join(isolatedRoot, 'data');
process.env.STUDIO_EVENTS_DIR = path.join(isolatedRoot, 'events');
