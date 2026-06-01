import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock fs module
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof fs>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import {
  generateWorkspaceConfig,
  readWorkspaceConfig,
  writeWorkspaceConfig,
  updateWorkspaceConfig,
  getWorkspaceFilePath,
  WorkspaceConfig,
} from '../workspace-config';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);

describe('workspace-config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('generateWorkspaceConfig', () => {
    test('generates config with all options', () => {
      const config = generateWorkspaceConfig({
        serverUrl: 'https://dommaker.cn',
        token: 'st_mach_xxx',
        runtimes: ['claude', 'opencode'],
        hasDocker: false,
        workspaceRoot: '/qunar',
        name: 'test-workspace',
      });

      expect(config.name).toBe('test-workspace');
      expect(config.serverUrl).toBe('https://dommaker.cn');
      expect(config.token).toBe('st_mach_xxx');
      expect(config.runtimes).toEqual(['claude', 'opencode']);
      expect(config.hasDocker).toBe(false);
      expect(config.workspaceRoot).toBe('/qunar');
      expect(config.os).toBe(os.platform());
      expect(config.arch).toBe(os.arch());
    });

    test('uses hostname as default name', () => {
      const config = generateWorkspaceConfig({
        serverUrl: 'https://example.com',
        token: 'tok',
        runtimes: [],
        hasDocker: true,
      });

      expect(config.name).toBe(os.hostname());
    });

    test('uses cwd as default workspaceRoot', () => {
      const config = generateWorkspaceConfig({
        serverUrl: 'https://example.com',
        token: 'tok',
        runtimes: [],
        hasDocker: false,
      });

      expect(config.workspaceRoot).toBe(process.cwd());
    });

    test('detects OS and arch from system', () => {
      const config = generateWorkspaceConfig({
        serverUrl: 'https://example.com',
        token: 'tok',
        runtimes: [],
        hasDocker: false,
      });

      expect(typeof config.os).toBe('string');
      expect(config.os.length).toBeGreaterThan(0);
      expect(typeof config.arch).toBe('string');
      expect(config.arch.length).toBeGreaterThan(0);
    });
  });

  describe('readWorkspaceConfig', () => {
    test('returns null when file does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      expect(readWorkspaceConfig()).toBeNull();
    });

    test('parses valid JSON', () => {
      const config: WorkspaceConfig = {
        name: 'test',
        serverUrl: 'https://example.com',
        token: 'tok',
        runtimes: ['claude'],
        hasDocker: false,
        os: 'linux',
        arch: 'x64',
        workspaceRoot: '/root',
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(config));

      const result = readWorkspaceConfig();
      expect(result).toEqual(config);
    });

    test('returns null when JSON is invalid', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('not json {{{');

      const result = readWorkspaceConfig();
      expect(result).toBeNull();
    });
  });

  describe('writeWorkspaceConfig', () => {
    test('creates directory and writes JSON', () => {
      const config = generateWorkspaceConfig({
        serverUrl: 'https://example.com',
        token: 'tok',
        runtimes: ['claude'],
        hasDocker: false,
      });

      writeWorkspaceConfig(config);

      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('.studio'),
        { recursive: true },
      );
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('workspace.json'),
        expect.stringContaining('"serverUrl": "https://example.com"'),
        'utf-8',
      );
    });

    test('writes valid JSON with trailing newline', () => {
      const config = generateWorkspaceConfig({
        serverUrl: 'https://example.com',
        token: 'tok',
        runtimes: [],
        hasDocker: false,
      });

      writeWorkspaceConfig(config);

      const writeCall = mockWriteFileSync.mock.calls[0];
      const content = writeCall[1] as string;
      expect(content.endsWith('\n')).toBe(true);
      // Should not throw when parsing
      expect(JSON.parse(content.trim())).toBeDefined();
    });
  });

  describe('updateWorkspaceConfig', () => {
    test('merges updates into existing config', () => {
      const existing: WorkspaceConfig = {
        name: 'old',
        serverUrl: 'https://old.com',
        token: 'old_tok',
        runtimes: [],
        hasDocker: false,
        os: 'linux',
        arch: 'x64',
        workspaceRoot: '/root',
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(existing));

      const result = updateWorkspaceConfig({ workspaceId: 'ws_123' });

      expect(result.workspaceId).toBe('ws_123');
      expect(result.name).toBe('old'); // preserved
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    test('throws when workspace.json does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      expect(() => updateWorkspaceConfig({ workspaceId: 'ws_123' })).toThrow(
        'workspace.json not found',
      );
    });
  });

  describe('getWorkspaceFilePath', () => {
    test('returns path ending with workspace.json', () => {
      const p = getWorkspaceFilePath();
      expect(p).toContain('workspace.json');
      expect(p).toContain('.studio');
    });
  });
});
