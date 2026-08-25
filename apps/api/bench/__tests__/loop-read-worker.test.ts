/**
 * #323 阶段一 bench：worker 存储源分桶测试（纯函数 bucketOfFor）。
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { bucketOfFor } from '../loop-read-worker.js';

const HOME = path.join(path.sep, 'bench', '1x');

describe('bucketOfFor', () => {
  it('按存储源分桶：wu-index / studio-events / agents / channels / knowledge / other', () => {
    expect(bucketOfFor(HOME, path.join(HOME, 'data', 'workunits', 'index.json'))).toBe('wu-index');
    expect(bucketOfFor(HOME, path.join(HOME, 'logs', 'studio-events.jsonl'))).toBe('studio-events');
    expect(bucketOfFor(HOME, path.join(HOME, 'data', 'agents'))).toBe('agents-dir');
    expect(bucketOfFor(HOME, path.join(HOME, 'data', 'agents', 'a1', 'state.json'))).toBe('agent-state');
    expect(bucketOfFor(HOME, path.join(HOME, 'data', 'agents', 'a1', 'profile.json'))).toBe('agent-profile');
    expect(bucketOfFor(HOME, path.join(HOME, 'data', 'agents', 'a1', 'notes.md'))).toBe('agent-other');
    expect(bucketOfFor(HOME, path.join(HOME, 'data', 'workunits', 'events.jsonl'))).toBe('wu-other');
    expect(bucketOfFor(HOME, path.join(HOME, 'data', 'channels', 'c1', 'messages.jsonl'))).toBe('channels');
    expect(bucketOfFor(HOME, path.join(HOME, 'knowledge', 'entry.md'))).toBe('knowledge');
    expect(bucketOfFor(HOME, path.join(HOME, 'data', 'users', 'u1.json'))).toBe('other');
  });
});
