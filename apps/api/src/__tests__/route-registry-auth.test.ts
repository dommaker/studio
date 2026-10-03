/**
 * route-registry 鉴权姿态锁定测试（P2-e 声明式统一）
 *
 * 契约：鉴权挂载的唯一来源 = route-registry entry 的 middleware 声明（路由文件内不再挂
 * requireAuth/requireAdmin 类中间件）。探针本体在同目录 .probe.ts——经 tsx 子进程执行
 * （与生产 bootstrap 同一模块管线；vitest 进程内直跑 buildRouteTable 会把 node_modules
 * 链路外置成原生 ESM，踩目录导入解析差异）。spawn 方式对齐 tests/globalSetup.ts
 * （直 spawn node_modules/.bin/tsx，不走 npx 包装层）。
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';

describe('route-registry 鉴权姿态（P2-e 声明式统一）', () => {
  it('全部 entry 姿态符合声明式契约（open/auth/authNotGuest/admin 逐档功能探针）', async () => {
    const tsxBin = path.resolve(process.cwd(), 'node_modules/.bin/tsx');
    const probe = path.resolve(__dirname, 'route-registry-auth.probe.ts');
    const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn(tsxBin, [probe], {
        cwd: path.resolve(process.cwd(), 'apps/api'),
        env: { ...process.env, STUDIO_AUTH: 'on' },
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
  }, 120_000);
});
