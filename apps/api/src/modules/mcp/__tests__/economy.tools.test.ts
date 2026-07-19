/**
 * economy.tools 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖 getBalance。HOME 指向临时目录以隔离真实公司数据。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpHome: string;
let prevHome: string | undefined;
let economyTools: import('../tool-registry.js').RegisteredTool[];
let COMPANIES_DIR: string;

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-economy-tools-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const mod = await import('../economy.tools.js');
  economyTools = mod.economyTools;
  COMPANIES_DIR = (await import('../tool-store.js')).getCompaniesDir();
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('economy.tools', () => {
  it('仅导出 getBalance', () => {
    expect(economyTools.map(t => t.name)).toEqual(['getBalance']);
  });

  it('getBalance 返回 { type: "company", ...company }', async () => {
    fs.mkdirSync(COMPANIES_DIR, { recursive: true });
    fs.writeFileSync(path.join(COMPANIES_DIR, 'c1.json'), JSON.stringify({ id: 'c1', name: 'Acme', balance: 100 }));
    const tool = economyTools[0];
    expect(await tool.handler({ companyId: 'c1' })).toEqual({ type: 'company', id: 'c1', name: 'Acme', balance: 100 });
    expect(tool.inputSchema.required).toEqual(['companyId']);
  });

  it('getBalance 公司不存在时抛 Company not found', async () => {
    await expect(economyTools[0].handler({ companyId: 'nope' })).rejects.toThrow('Company not found');
  });
});
