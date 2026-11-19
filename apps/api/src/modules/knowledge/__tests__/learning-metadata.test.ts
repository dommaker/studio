import { describe, expect, it } from 'vitest';
import {
  getLearningMetadata,
  isProvenEligible,
  matchesKnowledgeScope,
  withLearningMetadata,
  type LearningMetadata,
} from '../learning-metadata.js';

const context = {
  companyId: 'company-1',
  projectId: 'project-1',
  repo: '/repo/one',
  roleId: 'role-1',
};

function entryWith(learning?: LearningMetadata) {
  return {
    sourceReferences: [{ timestamp: '2026-11-07T00:00:00Z', ...(learning ? { learning } : {}) }],
  };
}

function metadata(scope: LearningMetadata['scope'], outcome?: LearningMetadata['outcome']): LearningMetadata {
  return {
    scope,
    workUnitId: 'wu-1',
    assignmentId: 'assignment-1',
    stepRecordId: 'step-1',
    repo: '/repo/one',
    commit: 'a'.repeat(40),
    transcriptRefs: ['transcript:wu-1:1'],
    evidenceRefs: ['evidence-1'],
    extractionVersion: '1',
    revision: 1,
    outcome: outcome ?? { execution: 'succeeded', verification: 'passed', delivery: 'merged' },
  };
}

describe('learning metadata', () => {
  it('round-trips through a source reference without dropping provenance or versions', () => {
    const expected = { ...metadata({ kind: 'repo', id: '/repo/one' }), supersedes: 'old-entry' };
    const ref = withLearningMetadata({ timestamp: '2026-11-07T00:00:00Z' }, expected);
    expect(getLearningMetadata({ sourceReferences: [ref] })).toEqual(expected);
  });

  it('uses the latest appended learning outcome and revision', () => {
    const old = metadata({ kind: 'global' }, { execution: 'failed', verification: 'failed', delivery: 'unmerged' });
    const latest = { ...metadata({ kind: 'global' }), revision: 2, supersedes: 'old-entry' };
    expect(getLearningMetadata({ sourceReferences: [
      withLearningMetadata({ timestamp: '2026-11-07T00:00:00Z' }, old),
      withLearningMetadata({ timestamp: '2026-11-08T00:00:00Z' }, latest),
    ] })).toEqual(latest);
  });

  it.each([
    [{ kind: 'global' }, true],
    [{ kind: 'company', id: 'company-1' }, true],
    [{ kind: 'project', id: 'project-1' }, true],
    [{ kind: 'repo', id: '/repo/one' }, true],
    [{ kind: 'role', id: 'role-1' }, true],
    [{ kind: 'repo', id: '/repo/two' }, false],
  ] as const)('matches scope %s = %s', (scope, expected) => {
    expect(matchesKnowledgeScope(entryWith(metadata(scope)), context)).toBe(expected);
  });

  it('pauses legacy entries with unknown scope during automatic recall', () => {
    expect(matchesKnowledgeScope(entryWith(), context)).toBe(false);
    expect(matchesKnowledgeScope(entryWith(metadata({ kind: 'repo', id: '/repo/one' })), {})).toBe(false);
  });

  it('requires verified successful delivery for proven, not agent origin alone', () => {
    expect(isProvenEligible(entryWith(metadata({ kind: 'global' })))).toBe(true);
    expect(isProvenEligible(entryWith(metadata({ kind: 'global' }, { execution: 'failed', verification: 'failed', delivery: 'unmerged' })))).toBe(false);
    expect(isProvenEligible(entryWith(metadata({ kind: 'global' }, { execution: 'succeeded', verification: 'passed', delivery: 'unmerged' })))).toBe(false);
    expect(isProvenEligible(entryWith(metadata({ kind: 'global' }, { execution: 'succeeded', verification: 'passed', delivery: 'not-required' })))).toBe(true);
    expect(isProvenEligible(entryWith())).toBe(false);
  });
});
