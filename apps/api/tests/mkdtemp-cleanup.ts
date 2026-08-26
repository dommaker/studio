/**
 * mkdtemp 泄漏防护（2026-08-26 /tmp 3.9 万残留事故根因修复）
 *
 * 事故：测试文件 fs.mkdtempSync 后无清理（16 个文件零清理 + prompt-composer
 * 同文件 9 个 describe 各建不删 + Ctrl-C 中断跳过 afterEach），三周积 3.9 万目录。
 *
 * 机制（与 setup-isolated-data 的 studio-test-data- 清理同款，泛化到全部前缀）：
 * 1) patch fs.mkdtempSync--本进程创建的临时目录全部进注册表，afterAll 统一 rmSync。
 *    vitest 模块系统下对 default/namespace 两种 import 风格均可见（probe 验证过）。
 *    注意不能用 process.on('exit')：vitest forks worker 被 pool 直接 kill，exit 事件
 *    不触发（probe 验证）--2026-08-25 版清理因此从未生效。afterAll 在 setupFiles
 *    里注册 = 文件级钩子，每个测试文件跑完清理自己进程注册的目录。
 * 2) sweepStaleMkdtempDirs--清扫 tmpdir 里超龄且符合 mkdtemp 签名（前缀-6 位随机后缀）
 *    的目录，兜底 worker 被 kill / Ctrl-C 等 afterAll 没跑的场景。靠下一个测试进程收敛。
 *
 * 签名正则只匹配「小写字母数字连字符前缀 + 恰好 6 位大小写字母数字后缀」：
 * chrome crashpad（org.chromium.Chromium.XXXX，含点）、qoder-*-cwd（3 位后缀）、
 * tsx-0 / jest_0 等运行时目录均不匹配，不会误删。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll } from 'vitest';

const MKDTEMP_SUFFIX_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[A-Za-z0-9]{6}$/;

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
    for (const dir of registeredDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 清理失败不阻断测试
      }
    }
    registeredDirs.clear();
  });
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
