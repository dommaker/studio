/**
 * 模块 barrel（modules/X/index.ts）完整性测试——P2-c 立界
 *
 * 1) 36 个模块的 index.ts 全部可加载——ESM 循环 import 导致的初始化崩溃（TDZ）会在此显形
 * 2) barrel 的每个再导出符号运行时均有定义（防幽灵导出/循环初始化拿到 undefined）
 * 3) 抽查关键公共面符号类型
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MODULES_DIR = path.resolve(__dirname, '../modules');
const modules = fs.readdirSync(MODULES_DIR).filter(d => fs.statSync(path.join(MODULES_DIR, d)).isDirectory());

describe('模块 barrel 完整性', () => {
  it('38 个模块均有 index.ts', () => {
    expect(modules.length).toBe(38);
    for (const mod of modules) {
      expect(fs.existsSync(path.join(MODULES_DIR, mod, 'index.ts')), `${mod}/index.ts 缺失`).toBe(true);
    }
  });

  it('全部 barrel 可加载且导出符号非 undefined（循环初始化显形）', async () => {
    // import.meta.glob：vite 不支持全动态模板 import，用 glob 静态枚举
    const barrels = import.meta.glob('../modules/*/index.ts');
    expect(Object.keys(barrels).length).toBe(38);
    for (const mod of modules) {
      const load = barrels[`../modules/${mod}/index.ts`];
      const ns = await load();
      expect(ns, `${mod}/index.ts 加载失败`).toBeTruthy();
      const src = fs.readFileSync(path.join(MODULES_DIR, mod, 'index.ts'), 'utf8');
      // 从 barrel 源解析导出名（export { a, default as b } / export type { T }）
      const valueNames = [...src.matchAll(/export\s*\{([^}]*)\}\s*from/g)]
        .flatMap(m => m[1].split(','))
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => {
          const asM = s.match(/(?:default|\w+)\s+as\s+(\w+)/);
          return asM ? asM[1] : s;
        });
      for (const name of valueNames) {
        expect(ns[name], `${mod}/index.ts 导出 "${name}" 为 undefined（疑似循环初始化或幽灵导出）`).not.toBeUndefined();
      }
    }
  });

  it('关键公共面抽查', async () => {
    const workunit = await import('../modules/workunit/index.js');
    expect(typeof workunit.WorkUnitService).toBe('function');
    expect(typeof workunit.postWuSystemMessage).toBe('function');
    const channels = await import('../modules/channels/index.js');
    expect(channels.channelMessageService).toBeTruthy();
    const agents = await import('../modules/agents/index.js');
    expect(typeof agents.getSystemExecutor).toBe('function');
  });
});
