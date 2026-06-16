/**
 * Analyst Scout — prompt builder tests
 */
import { describe, it, expect } from 'vitest';
import { buildScoutPrompts, type ScoutScope } from '../analyst-scout.js';

describe('analyst-scout: buildScoutPrompts', () => {
  const baseScope: ScoutScope = {
    modules: ['channel', 'executor'],
    keyFiles: ['apps/api/src/channels.ts'],
    concerns: ['code', 'knowledge'],
    directoryMap: { 'apps/api/src': 'Core API' },
  };

  const requirement = '添加 channel 消息过滤功能';

  it('always includes code and knowledge scouts', () => {
    const scouts = buildScoutPrompts(baseScope, requirement);
    const types = scouts.map(s => s.type);
    expect(types).toContain('code');
    expect(types).toContain('knowledge');
  });

  it('includes test scout when concern has test', () => {
    const scopeWithTest: ScoutScope = { ...baseScope, concerns: [...baseScope.concerns, 'test'] };
    const scouts = buildScoutPrompts(scopeWithTest, requirement);
    expect(scouts.map(s => s.type)).toContain('test');
  });

  it('includes test scout when modules count >= 2', () => {
    const scouts = buildScoutPrompts(baseScope, requirement);
    expect(scouts.map(s => s.type)).toContain('test');
  });

  it('does NOT include test scout when 1 module and no test concern', () => {
    const smallScope: ScoutScope = { ...baseScope, modules: ['channel'], concerns: ['code', 'knowledge'] };
    const scouts = buildScoutPrompts(smallScope, requirement);
    expect(scouts.map(s => s.type)).not.toContain('test');
  });

  it('includes schema scout only when schema concern present', () => {
    const noSchema: ScoutScope = { ...baseScope, concerns: ['code', 'knowledge'] };
    const withSchema: ScoutScope = { ...baseScope, concerns: [...baseScope.concerns, 'schema'] };

    expect(buildScoutPrompts(noSchema, requirement).map(s => s.type)).not.toContain('schema');
    expect(buildScoutPrompts(withSchema, requirement).map(s => s.type)).toContain('schema');
  });

  it('each scout prompt contains the requirement text', () => {
    const scouts = buildScoutPrompts(baseScope, requirement);
    for (const s of scouts) {
      expect(s.prompt).toContain(requirement);
    }
  });

  it('code scout prompt includes modules and key files', () => {
    const scouts = buildScoutPrompts(baseScope, requirement);
    const codeScout = scouts.find(s => s.type === 'code');
    expect(codeScout).toBeDefined();
    expect(codeScout!.prompt).toContain('channel');
    expect(codeScout!.prompt).toContain('apps/api/src/channels.ts');
  });

  it('schema scout prompt mentions prisma', () => {
    const withSchema: ScoutScope = { ...baseScope, concerns: [...baseScope.concerns, 'schema'] };
    const scouts = buildScoutPrompts(withSchema, requirement);
    const schemaScout = scouts.find(s => s.type === 'schema');
    expect(schemaScout!.prompt).toContain('Schema');
    expect(schemaScout!.prompt).toContain('prisma');
  });

  it('scout prompts instruct not to modify files', () => {
    const scouts = buildScoutPrompts(baseScope, requirement);
    for (const s of scouts) {
      expect(s.prompt).toContain('不修改任何文件');
    }
  });
});
