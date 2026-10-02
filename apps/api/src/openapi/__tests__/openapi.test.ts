/**
 * OpenAPI 生成测试（Phase 4：/api/docs 复活）
 *
 * 探针本体在同目录 .probe.ts——经 tsx 子进程执行（与生产 bootstrap 同一模块管线；
 * vitest 进程内直跑 buildRouteTable 会把 node_modules 链路外置成原生 ESM，踩目录
 * 导入解析差异）。spawn 方式对齐 tests/globalSetup.ts。
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';

describe('OpenAPI 生成（contract 派生 /api/docs）', () => {
  it('全量端点进文档 + response-map 无漂移 + 结构合法 + 协议面排除 + 挂载冒烟', async () => {
    const tsxBin = path.resolve(process.cwd(), 'node_modules/.bin/tsx');
    const probe = path.resolve(__dirname, 'openapi.probe.ts');
    const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn(tsxBin, [probe], {
        cwd: path.resolve(process.cwd(), 'apps/api'),
        env: { ...process.env, STUDIO_AUTH: 'none' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (d) => { output += String(d); });
      child.stderr.on('data', (d) => { output += String(d); });
      child.on('close', (code) => resolve({ code, output }));
    });
    expect(result.output, '探针失败输出').not.toContain('FAIL');
    expect(result.code, `探针退出码非零：\n${result.output.slice(-2000)}`).toBe(0);
    expect(result.output).toContain('OK');
  }, 180_000);
});
