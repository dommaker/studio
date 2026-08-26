/**
 * vitest setupFiles - mkdtemp 泄漏防护（2026-08-26 /tmp 3.9 万残留事故）
 *
 * packages 侧唯一正本（studio-skill/notification/agent 的 vitest.config 跨包引用
 * 本文件，不再各存副本）；机制与 apps/api/tests/mkdtemp-cleanup.ts 同源：
 * 1) patch fs.mkdtempSync——本进程创建的临时目录全部进注册表，文件级 afterAll
 *    统一 rmSync。vitest worker 被 pool kill 时 process 'exit' 不触发，必须用
 *    afterAll（setupFiles 里注册 = 文件级钩子）。
 * 2) import 时清扫 tmpdir 里 >24h 且符合 mkdtemp 签名的目录，兜底
 *    kill -9 / Ctrl-C 等钩子没跑的场景，靠下一个测试进程收敛。
 *
 * 已知盲区（与 apps/api 正本同源）：测试文件 `import * as fs` 拿原生冻结
 * 命名空间，绕过本补丁——此类文件须自带显式 afterEach/afterAll 清理。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll } from 'vitest';

export const MKDTEMP_SUFFIX_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[A-Za-z0-9]{6}$/;

let patched = false;
const registeredDirs = new Set<string>();

/** 幂等。setup 与测试文件重复调用安全。 */
export function patchMktempCleanup(): void {
  if (patched) return;
  patched = true;
  const orig = fs.mkdtempSync as (prefix: string) => string;
  fs.mkdtempSync = ((prefix: string) => {
    const dir = orig(prefix);
    registeredDirs.add(dir);
    return dir;
  }) as typeof fs.mkdtempSync;

  afterAll(() => {
    flushRegisteredDirs();
  });
}

/** 删除并清空注册表里的全部目录。afterAll 委托此函数；测试可直接调用验证机制。 */
export function flushRegisteredDirs(): void {
  for (const dir of registeredDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不阻断测试
    }
  }
  registeredDirs.clear();
}

export function isRegisteredTmpDir(dir: string): boolean {
  return registeredDirs.has(dir);
}

/**
 * 清扫 tmpDir 中超龄且符合 mkdtemp 签名的目录。返回删除数。
 * 单条失败（竞态被别进程先删等）不阻断。
 */
export function sweepStaleMkdtempDirs(tmpDir: string, ageMs: number): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(tmpDir);
  } catch {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const name of entries) {
    if (!MKDTEMP_SUFFIX_RE.test(name)) continue;
    try {
      const p = path.join(tmpDir, name);
      const st = fs.statSync(p);
      if (st.isDirectory() && now - st.mtimeMs > ageMs) {
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // 单条竞态不阻断
    }
  }
  return removed;
}

// setup 自执行（被 vitest setupFiles 加载或测试 import 时生效，幂等）
patchMktempCleanup();
sweepStaleMkdtempDirs(process.env.TMPDIR || '/tmp', 24 * 60 * 60 * 1000);
