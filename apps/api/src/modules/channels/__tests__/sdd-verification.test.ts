// SP-004: SDD read path verification tests (RED)
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock sdd-utils before importing the helper
const { readSddDocMock, findSddDocByIdMock } = vi.hoisted(() => ({
  readSddDocMock: vi.fn(),
  findSddDocByIdMock: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  readSddDoc: readSddDocMock,
  findSddDocById: findSddDocByIdMock,
}));

import { logger } from '@dommaker/studio-shared';
import { verifySddFile } from '../sdd-verification.js';

describe('verifySddFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('attempts SDD read when sddSlug is provided', async () => {
    readSddDocMock.mockReturnValue({ meta: { status: 'draft' }, body: 'content' });

    await verifySddFile({ docId: 'doc-1', sddSlug: 'my-feature' });

    expect(readSddDocMock).toHaveBeenCalledWith('my-feature', 'requirement');
    expect(findSddDocByIdMock).not.toHaveBeenCalled();
  });

  it('falls back to findSddDocById when no sddSlug', async () => {
    findSddDocByIdMock.mockReturnValue('found-slug');
    readSddDocMock.mockReturnValue({ meta: { status: 'confirmed' }, body: 'content' });

    await verifySddFile({ docId: 'doc-2', sddSlug: undefined });

    expect(findSddDocByIdMock).toHaveBeenCalledWith('doc-2');
    expect(readSddDocMock).toHaveBeenCalledWith('found-slug', 'requirement');
  });

  it('logs when SDD file exists', async () => {
    readSddDocMock.mockReturnValue({ meta: { status: 'draft', slug: 'feat-x' }, body: '## ACs' });

    await verifySddFile({ docId: 'doc-3', sddSlug: 'feat-x' });

    expect(logger.info).toHaveBeenCalledWith(
      '[Channel] SDD file verified',
      { slug: 'feat-x', docId: 'doc-3', sddStatus: 'draft' },
    );
  });

  it('does not throw when SDD file does not exist', async () => {
    readSddDocMock.mockReturnValue(null);

    await expect(verifySddFile({ docId: 'doc-4', sddSlug: 'missing' })).resolves.toBeUndefined();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('does not throw when no slug resolved', async () => {
    findSddDocByIdMock.mockReturnValue(null);

    await expect(verifySddFile({ docId: 'doc-5', sddSlug: undefined })).resolves.toBeUndefined();
    expect(readSddDocMock).not.toHaveBeenCalled();
  });

  it('does not throw on readSddDoc exception', async () => {
    readSddDocMock.mockImplementation(() => { throw new Error('IO error'); });

    await expect(verifySddFile({ docId: 'doc-6', sddSlug: 'bad' })).resolves.toBeUndefined();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
