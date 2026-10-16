/**
 * 模块 barrel（modules/X/index.ts）完整性测试——P2-c 立界
 *
 * 口径（2026-10-16 代码清理批次B）：零 export 的空 barrel 已随本批清除，
 * 模块不再强制要求 index.ts（无跨模块消费者的模块不需要公共出口）。
 * 本测试只约束「存在的 barrel」：
 * 1) 存在的 index.ts 必须有实际导出（空 barrel 防回归）
 * 2) 全部 barrel 均可加载——ESM 循环 import 导致的初始化崩溃（TDZ）会在此显形
 * 3) barrel 的每个再导出符号运行时均有定义（防幽灵导出/循环初始化拿到 undefined）
 * 4) 抽查关键公共面符号类型
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MODULES_DIR = path.resolve(__dirname, '../modules');
const modules = fs.readdirSync(MODULES_DIR).filter(d => fs.statSync(path.join(MODULES_DIR, d)).isDirectory());
const withBarrel = modules.filter(m => fs.existsSync(path.join(MODULES_DIR, m, 'index.ts')));

describe('模块 barrel 完整性', () => {
  it('存在的 barrel 必须有实际导出（空 barrel 防回归）', () => {
    for (const mod of withBarrel) {
      const src = fs.readFileSync(path.join(MODULES_DIR, mod, 'index.ts'), 'utf8');
      expect(/export\s/.test(src), `${mod}/index.ts 无任何导出（空 barrel）`).toBe(true);
    }
  });

  it('全部 barrel 可加载且导出符号非 undefined（循环初始化显形）', async () => {
    // import.meta.glob：vite 不支持全动态模板 import，用 glob 静态枚举
    const barrels = import.meta.glob('../modules/*/index.ts');
    // glob 枚举与「实际存在 index.ts 的模块」列表必须一一对应（不硬编码模块计数——#694：每加一个模块改测试的维护税）
    expect(Object.keys(barrels).sort()).toEqual(withBarrel.map(m => `../modules/${m}/index.ts`).sort());
    for (const mod of withBarrel) {
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
    // 全量加载 30+ 模块 barrel 实测 5–8s，默认 5s 超时在高负载下抖动误红（#694 验收期实测）
  }, 30000);

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
