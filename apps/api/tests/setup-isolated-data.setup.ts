/**
 * Vitest setupFiles - B1 测试数据隔离（2026-08-03 unattended-token-burn issue）
 *
 * 每个测试文件进程强制使用独立临时数据根，禁止测试写生产 ~/.studio/data。
 * 历史事故：路由测试经真实 FileStore 把测试 WU 写进生产数据根，daemon 当真任务执行。
 *
 * 时机说明：setupFiles 先于测试模块 import 执行，因此：
 * - FileStore 构造时读取的 process.env.STUDIO_DATA_DIR 已指向临时目录；
 * - 模块级 `studioPath()` 常量读取的 STUDIO_HOME 同样已指向隔离根（#219 双轨钉死）；
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
import { patchMktempCleanup, sweepStaleMkdtempDirs } from './mkdtemp-cleanup';

// mkdtemp 泄漏防护（2026-08-26 /tmp 3.9 万残留事故）：先打补丁，本文件创建的
// 隔离根及测试代码后续所有 mkdtempSync 都进注册表，exit 时统一清理。
patchMktempCleanup();

const tmpDir = process.env.TMPDIR || '/tmp';
const isolatedRoot = fs.mkdtempSync(path.join(tmpDir, 'studio-test-data-'));
// #219 双轨钉死：STUDIO_DATA_DIR 与 STUDIO_HOME 必须同时指向隔离根。
// 只钉 STUDIO_DATA_DIR 时，模块级 `studioPath(...)` 常量走 STUDIO_HOME 逃逸到
// 真实 ~/.studio（89 处，#172 skill-loader 同类事故）。
process.env.STUDIO_HOME = isolatedRoot;
process.env.STUDIO_DATA_DIR = path.join(isolatedRoot, 'data');
process.env.STUDIO_EVENTS_DIR = path.join(isolatedRoot, 'events');

// #219 硬断言：隔离根解析结果指向真实生产根（$HOME/.studio）即 fail fast。
// 不用 os.homedir()（见文件头 ESM 冻结说明），直接读 $HOME。
const realHome = process.env.HOME;
if (realHome) {
  const prodRoot = path.resolve(realHome, '.studio');
  const resolved = [process.env.STUDIO_HOME, process.env.STUDIO_DATA_DIR, process.env.STUDIO_EVENTS_DIR]
    .map((p) => path.resolve(p!));
  if (resolved.some((p) => p === prodRoot || p.startsWith(prodRoot + path.sep))) {
    throw new Error(
      `[setup-isolated-data] 测试数据根解析到真实生产根 ${prodRoot}，拒绝继续（#219 fail fast）。`
      + `STUDIO_HOME=${process.env.STUDIO_HOME} STUDIO_DATA_DIR=${process.env.STUDIO_DATA_DIR}`,
    );
  }
}

// 隔离根清理（2026-08-25 /tmp 残留事故：mkdtemp 无清理，三周积 9.5 万个目录）。
// 双机制（2026-08-26 泛化，正本见 ./mkdtemp-cleanup.ts）：
// 1) exit 钩子自清——patch 后本进程所有 mkdtemp 目录（含 isolatedRoot）当场删；
// 2) import 时清扫 >24h 的历史 mkdtemp 残留（任意测试前缀，按 mkdtemp 签名识别）——
//    kill -9 / 断电时 exit 钩子不跑，靠下一个测试进程兜底收敛。
//    24h 阈值保证不碰并发在跑的其他测试进程（单进程跑测试不可能活过 24h）。
sweepStaleMkdtempDirs(tmpDir, 24 * 60 * 60 * 1000);
