/**
 * ARCH-05 loop-deps 直接契约测试：
 * - 窄接口只暴露各段实际依赖，不能重新长成可变 God Host。
 * - ObserverDeps 通过 getter 读取 owner 状态，事件唤醒与存活检查保持行为。
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { FileStore } from '@dommaker/studio-shared';
import { LoopObserver } from '../loop-observe.js';
import type { ObserverDeps } from '../loop-deps.js';

const sourceText = readFileSync(new URL('../loop-deps.ts', import.meta.url), 'utf8');
const sourceFile = ts.createSourceFile('loop-deps.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function interfaceDeclaration(name: string): ts.InterfaceDeclaration {
  const declaration = sourceFile.statements.find((statement): statement is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === name
  );
  if (!declaration) throw new Error(`missing interface ${name}`);
  return declaration;
}

function memberNames(name: string): string[] {
  return interfaceDeclaration(name).members.map(member => member.name!.getText(sourceFile)).sort();
}

describe('loop-deps 窄接口结构契约', () => {
  it('各段接口成员精确且无可变 God Host 状态', () => {
    expect(memberNames('LifecycleDeps')).toEqual([
      'executor', 'fileStore', 'getCurrentExecutionId', 'onChannelMessageSent',
      'onWorkUnitClaimable', 'role', 'runLoop', 'stopLease', 'wakeIdle',
    ]);
    expect(memberNames('ObserverDeps')).toEqual(['fileStore', 'getInstance', 'isAlive', 'role']);
    expect(memberNames('ClaimDeps')).toEqual(['discussion', 'fileStore', 'getInstance', 'role', 'workUnits']);
    expect(memberNames('StepDeps')).toEqual(['acceptedTypes', 'discussion', 'executor', 'fileStore', 'role', 'workUnits']);
    expect(memberNames('ResultRecorderDeps')).toEqual(['executionJournal', 'fileStore', 'lease', 'role', 'workUnits']);

    for (const name of ['LifecycleDeps', 'ObserverDeps', 'ClaimDeps', 'StepDeps', 'ResultRecorderDeps']) {
      const declaration = interfaceDeclaration(name);
      expect(declaration.heritageClauses).toBeUndefined();
      for (const member of declaration.members) {
        if (ts.isPropertySignature(member)) {
          expect(member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)).toBe(true);
        }
      }
    }
    expect(sourceText).not.toContain('AgentLoopHost');
  });

  it('WorkUnit 与 Lease 端口只含语义命令，不含通用物理 mutator', () => {
    expect(sourceText).toContain("'create' | 'getById' | 'update' | 'claim' | 'transitionStatus' | 'blockForAllUnfit'");
    expect(memberNames('LeasePort')).toEqual([
      'ensure', 'handleLost', 'releaseIfForfeited', 'stillHolds', 'stop', 'transitionIfHeld',
    ]);
    expect(sourceText).not.toContain('updateMetadata');
    expect(sourceText).not.toContain('repository.mutate');
  });
});

describe('ObserverDeps 行为契约', () => {
  it('认领唤醒读取实例 getter，sleep 存活判断不暴露可变宿主', async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-deps-observer-'));
    try {
      const fileStore = new FileStore(testDir);
      const instance = {
        id: 'inst-narrow', roleId: 'role-narrow', sessionId: null, status: 'active',
        currentWorkUnitId: null, startedAt: new Date().toISOString(), terminatedAt: null,
        lastHeartbeat: null, metadata: null,
      };
      const getInstance = vi.fn(() => instance);
      const isAlive = vi.fn(() => true);
      const deps: ObserverDeps = {
        role: {
          id: 'role-narrow', name: 'narrow-agent', description: 'narrow deps test', channels: '[]',
          status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
        fileStore,
        getInstance,
        isAlive,
      };
      const observer = new LoopObserver(deps);

      observer.onWorkUnitClaimable({ workunit: { claimable: false, assigneeId: instance.id } });
      const startedAt = Date.now();
      await observer.idleSleep(15_000);

      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(getInstance).toHaveBeenCalled();
      expect(isAlive).toHaveBeenCalled();
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});
