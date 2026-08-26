/**
 * mkdtemp 泄漏防护机制测试（正本：../mkdtemp-cleanup-setup.ts）
 *
 * 两机制对应两组用例：
 * 1) patch fs.mkdtempSync 登记 + afterAll（委托 flushRegisteredDirs）统一清理；
 * 2) sweepStaleMkdtempDirs 清扫 >24h 历史残留（kill -9 / Ctrl-C / 命名空间导入
 *    盲区兜底），且不得误删 24h 内的新目录（并发测试进程保护）与非签名目录。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isRegisteredTmpDir, flushRegisteredDirs, sweepStaleMkdtempDirs } from '../mkdtemp-cleanup-setup';

const TMP = process.env.TMPDIR || '/tmp';
const DAY = 24 * 60 * 60 * 1000;

describe('mkdtemp 泄漏防护（packages 正本）', () => {
  it('patch：mkdtempSync 创建的目录进注册表，flush 统一删除', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'mkdtemp-cleanup-selftest-'));
    expect(fs.existsSync(dir)).toBe(true);
    expect(isRegisteredTmpDir(dir)).toBe(true);
    flushRegisteredDirs();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('sweep：>24h 的 mkdtemp 签名目录被清，24h 内的保留（并发进程保护）', () => {
    const stale = fs.mkdtempSync(path.join(TMP, 'mkdtemp-cleanup-selftest-'));
    const fresh = fs.mkdtempSync(path.join(TMP, 'mkdtemp-cleanup-selftest-'));
    try {
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      fs.utimesSync(stale, old, old);

      const removed = sweepStaleMkdtempDirs(TMP, DAY);

      expect(removed).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
    } finally {
      fs.rmSync(stale, { recursive: true, force: true });
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('sweep：非 mkdtemp 签名的目录不误删（运行时目录保护）', () => {
    // 签名 = 小写字母数字连字符前缀 + 恰好 6 位随机后缀；本名不符
    const d = path.join(TMP, 'mkdtemp-selftest-not-a-signature');
    fs.mkdirSync(d, { recursive: true });
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(d, old, old);
    try {
      sweepStaleMkdtempDirs(TMP, DAY);
      expect(fs.existsSync(d)).toBe(true);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
