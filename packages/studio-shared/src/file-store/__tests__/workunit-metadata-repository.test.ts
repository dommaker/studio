import { describe, expect, it, vi } from 'vitest';
import { WorkUnitMetadataRepository } from '../workunit-metadata-repository';
import type { WorkUnitSnapshot } from '../file-store-types';

describe('WorkUnitMetadataRepository', () => {
  it('只暴露 WorkUnit metadata 窄写口，不泄漏通用 JSON 或其他域写原语', async () => {
    const snapshot = { id: 'wu-1', metadata: '{"keep":true}' } as WorkUnitSnapshot;
    const updateMetadata = vi.fn().mockResolvedValue(snapshot);
    const repository = new WorkUnitMetadataRepository({ updateMetadata });

    await expect(repository.patch('wu-1', { traceId: 'trace-1' })).resolves.toBe(snapshot);
    expect(updateMetadata).toHaveBeenCalledWith('wu-1', expect.any(Function), undefined);
    expect(repository).not.toHaveProperty('readJson');
    expect(repository).not.toHaveProperty('writeJson');
    expect(repository).not.toHaveProperty('appendMessage');
    expect(repository).not.toHaveProperty('commitSnapshot');
  });

  it('stale-claim 标记保留 updatedAt，并只修改本域标记字段', async () => {
    const updateMetadata = vi.fn().mockImplementation(async (_id, mutator, opts) => {
      expect(opts).toEqual({ touchUpdatedAt: false });
      return { metadata: JSON.stringify(mutator({ keep: 'yes' })) } as WorkUnitSnapshot;
    });
    const repository = new WorkUnitMetadataRepository({ updateMetadata });

    const result = await repository.markStaleClaim('wu-1', '2026-10-01T00:00:00.000Z');
    expect(JSON.parse(result!.metadata!)).toEqual({
      keep: 'yes',
      staleGuardBlockedAt: '2026-10-01T00:00:00.000Z',
    });
  });
});
