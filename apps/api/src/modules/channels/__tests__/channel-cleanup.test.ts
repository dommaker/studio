/**
 * AC: ac-channel-cleanup
 *
 * Source-code verification:
 * - channel-message.events.ts deleted
 * - No imports of channel-message.events remain
 * - Startup registration removed
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const CHANNEL_DIR = path.resolve(__dirname, '..');
const API_SRC = path.resolve(__dirname, '../../..');

describe('Channel message events cleanup verification', () => {
  it('channel-message.events.ts is deleted', () => {
    expect(fs.existsSync(path.join(CHANNEL_DIR, 'channel-message.events.ts'))).toBe(false);
  });

  it('channel-message.events.test.ts is deleted', () => {
    expect(fs.existsSync(path.join(CHANNEL_DIR, '__tests__/channel-message.events.test.ts'))).toBe(false);
  });

  it('no imports of channel-message.events in API source', () => {
    const indexContent = fs.readFileSync(path.join(API_SRC, 'index.ts'), 'utf-8');
    expect(indexContent).not.toMatch(/channel-message\.events/);
  });
});
