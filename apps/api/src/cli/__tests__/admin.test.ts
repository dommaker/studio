/**
 * admin.ts 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖管理域：
 * - studioProject：add（写 projects.json、去重、缺省取 cwd）、list（空/非空）、未知子命令无输出；
 * - studioWorkon：写 active-project；缺名字 → usage + exit(1)；
 * - studioDaemonStart：缺 --server-url/--token → usage + exit(1)（在任何动态 import 之前）。
 * HOME 指向临时目录隔离 ~/.studio；process.argv 按需替换并恢复。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpHome: string;
let prevHome: string | undefined;
let prevStudioHome: string | undefined;
let prevArgv: string[];
let prevPort: string | undefined;
let admin: typeof import('../admin.js');
let logs: string[];
let errs: string[];
let exitSpy: ReturnType<typeof vi.spyOn>;

const studioDir = () => path.join(tmpHome, '.studio');
const projectsFile = () => path.join(studioDir(), 'projects.json');

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cli-admin-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  // #219：STUDIO_DIR 在 import 期冻结且 STUDIO_HOME 优先于 $HOME，
  // 须先把 STUDIO_HOME 钉到本测试的临时 home 再 import admin.js。
  prevStudioHome = process.env.STUDIO_HOME;
  process.env.STUDIO_HOME = path.join(tmpHome, '.studio');
  admin = await import('../admin.js');
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevStudioHome === undefined) delete process.env.STUDIO_HOME;
  else process.env.STUDIO_HOME = prevStudioHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  logs = [];
  errs = [];
  prevArgv = process.argv;
  prevPort = process.env.PORT;
  vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { errs.push(a.map(String).join(' ')); });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: any) => {
    throw new Error(`exit:${code}`);
  }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.argv = prevArgv;
  if (prevPort === undefined) delete process.env.PORT;
  else process.env.PORT = prevPort;
});

describe('studioProject', () => {
  it('list 空 → No projects registered.', () => {
    admin.studioProject(['list']);
    expect(logs).toEqual(['No projects registered.']);
  });

  it('add 写入 projects.json 并输出行；重复 add 去重', () => {
    admin.studioProject(['add', '/tmp/proj-a']);
    expect(logs.join('\n')).toContain('Project added: /tmp/proj-a');
    expect(JSON.parse(fs.readFileSync(projectsFile(), 'utf-8'))).toEqual(['/tmp/proj-a']);

    logs = [];
    admin.studioProject(['add', '/tmp/proj-a']);
    expect(JSON.parse(fs.readFileSync(projectsFile(), 'utf-8'))).toEqual(['/tmp/proj-a']);
    expect(logs.join('\n')).toContain('Project added: /tmp/proj-a'); // 输出行不变
  });

  it('add 缺省路径取 process.cwd()（resolve 后）', () => {
    fs.rmSync(projectsFile(), { force: true });
    admin.studioProject(['add']);
    expect(JSON.parse(fs.readFileSync(projectsFile(), 'utf-8'))).toEqual([process.cwd()]);
  });

  it('list 非空 → 逐行输出项目路径', () => {
    fs.writeFileSync(projectsFile(), JSON.stringify(['/p1', '/p2']));
    admin.studioProject(['list']);
    expect(logs).toEqual(['/p1\n/p2']);
  });

  it('未知子命令 → 无输出', () => {
    admin.studioProject(['bogus']);
    expect(logs).toEqual([]);
    expect(errs).toEqual([]);
  });
});

describe('studioWorkon', () => {
  it('写入 active-project 并输出', () => {
    admin.studioWorkon('demo-proj');
    expect(fs.readFileSync(path.join(studioDir(), 'active-project'), 'utf-8')).toBe('demo-proj');
    expect(logs.join('\n')).toContain('Active project: demo-proj');
  });

  it('缺名字 → usage + exit(1)', () => {
    expect(() => admin.studioWorkon(undefined)).toThrow('exit:1');
    expect(errs.join('\n')).toContain('Usage: studio workon <name>');
  });
});

describe('studioDaemonStart', () => {
  it('缺 --server-url/--token → usage + exit(1)（不做动态 import）', async () => {
    process.argv = ['node', 'studio', 'daemon', 'start'];
    await expect(admin.studioDaemonStart()).rejects.toThrow('exit:1');
    expect(errs.join('\n')).toContain(
      'Usage: studio daemon start --server-url <url> --token <token> [--workspace-root <path>] [--name <name>]',
    );
  });
});
