// #266（决策 #258）：projects-exclude.json 配置文件读写 —— STUDIO_HOME tmp 隔离，
// 仿 outbound-notify 路由测试的隔离方式；load 失败（缺失/损坏/形状不符）降级空清单不炸。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadProjectExcludeConfig,
  saveProjectExcludeConfig,
  projectExcludeConfigPath,
} from '../project-exclude-config.js';

describe('#266: project-exclude-config 排除清单配置读写', () => {
  let tmpStudioHome: string;
  let savedStudioHome: string | undefined;
  const configFile = () => join(tmpStudioHome, 'projects-exclude.json');

  beforeEach(async () => {
    tmpStudioHome = await mkdtemp(join(tmpdir(), 'exclude-config-'));
    savedStudioHome = process.env.STUDIO_HOME;
    process.env.STUDIO_HOME = tmpStudioHome;
  });

  afterEach(async () => {
    if (savedStudioHome === undefined) delete process.env.STUDIO_HOME;
    else process.env.STUDIO_HOME = savedStudioHome;
    await rm(tmpStudioHome, { recursive: true, force: true });
  });

  function writeAndExpect(content: string, expected: string[]): void {
    writeFileSync(configFile(), content);
    expect(loadProjectExcludeConfig()).toEqual(expected);
  }

  it('配置文件路径经 studioPath 解析（STUDIO_HOME 数据区，非硬编码 home）', () => {
    expect(projectExcludeConfigPath()).toBe(configFile());
  });

  it('文件不存在 → 空清单', () => {
    expect(loadProjectExcludeConfig()).toEqual([]);
  });

  it('save → load 回读一致；写前自动 mkdir -p', () => {
    saveProjectExcludeConfig(['studio-prod', '/data/secret']);
    expect(existsSync(configFile())).toBe(true);
    expect(loadProjectExcludeConfig()).toEqual(['studio-prod', '/data/secret']);
    // 落盘形态：{ exclude: [...] } 美化 JSON（仿 notify-config）
    expect(JSON.parse(readFileSync(configFile(), 'utf-8'))).toEqual({
      exclude: ['studio-prod', '/data/secret'],
    });
  });

  it('save 到不存在的嵌套数据区目录同样成功（mkdir -p）', async () => {
    await rm(tmpStudioHome, { recursive: true, force: true });
    await mkdir(tmpStudioHome);
    saveProjectExcludeConfig(['a']);
    expect(loadProjectExcludeConfig()).toEqual(['a']);
  });

  it('非法 JSON → 记日志降级空清单，不炸', () => {
    writeAndExpect('{ broken', []);
  });

  it('形状不符（exclude 非数组）→ 降级空清单', () => {
    writeAndExpect(JSON.stringify({ exclude: 'x' }), []);
  });

  it('非字符串条目与空串/空白被过滤', () => {
    writeAndExpect(JSON.stringify({ exclude: ['keep', 1, '', '  ', null] }), ['keep']);
  });
});
