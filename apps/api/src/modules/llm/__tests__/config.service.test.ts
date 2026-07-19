/**
 * LLM Config Service tests — resolve (layered lookup), saveConfig, maskConfig
 *
 * 迁移说明（studio-prisma 移除后）：配置持久化到 ~/.studio/llm-configs.json，
 * 经 FileStore.readJson/writeJson 读写（整数组）。测试用内存 FileStore mock。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const isCI = !!process.env.CI;
const describeIf = isCI ? describe.skip : describe;

const { configsStore, MockFileStore, getProviderApiKeyMock, modelGatewayMock } = vi.hoisted(() => {
  const configsStore: any[] = [];
  class MockFileStore {
    async readJson(_path: string): Promise<any[]> {
      return configsStore.slice();
    }
    async writeJson(_path: string, data: any[]): Promise<void> {
      configsStore.length = 0;
      configsStore.push(...data);
    }
  }
  return {
    configsStore,
    MockFileStore,
    getProviderApiKeyMock: vi.fn(),
    modelGatewayMock: { addProvider: vi.fn() },
  };
});

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    modelGateway: modelGatewayMock,
    getProviderApiKey: (...args: unknown[]) => getProviderApiKeyMock(...args),
    FileStore: MockFileStore,
  };
});

import { LLMConfigService, type LLMConfigScope } from '../config.service.js';

function seedConfig(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  configsStore.push({
    id: 'cfg-1',
    scope: 'orchestrator',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-6',
    options: '{}',
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

describeIf('LLMConfigService', () => {
  let service: LLMConfigService;

  beforeEach(() => {
    configsStore.length = 0;
    service = new LLMConfigService();
    getProviderApiKeyMock.mockReset();
    modelGatewayMock.addProvider.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('resolve', () => {
    it('returns exact scope match', async () => {
      seedConfig();
      getProviderApiKeyMock.mockReturnValue('sk-test-key-1234');

      const result = await service.resolve('orchestrator');

      expect(result.provider).toBe('anthropic');
      expect(result.model).toBe('claude-sonnet-4-6');
      expect(result.apiKey).toBe('sk-test-key-1234');
      expect(result.source).toBe('orchestrator');
    });

    it('falls back to agent_default for agent_* scopes', async () => {
      seedConfig({
        id: 'cfg-default',
        scope: 'agent_default',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
      });
      getProviderApiKeyMock.mockReturnValue('sk-openai-key');

      const result = await service.resolve('agent_claude');

      expect(result.source).toBe('agent_default');
      expect(result.model).toBe('gpt-4o');
    });

    it('falls back to env when no stored config', async () => {
      getProviderApiKeyMock.mockReturnValue(null);

      const original = process.env.STUDIO_API_KEY;
      process.env.STUDIO_API_KEY = 'test-key-ok';

      try {
        const result = await service.resolve('studio');
        expect(result.provider).toBe('deepseek');
        expect(result.source).toBe('env:studio');
      } finally {
        if (original === undefined) delete process.env.STUDIO_API_KEY;
        else process.env.STUDIO_API_KEY = original;
      }
    });

    it('throws when no config found at all', async () => {
      getProviderApiKeyMock.mockReturnValue(null);

      // Clear all env vars that might provide fallback
      const envKeys = ['LLM_API_KEY_USER', 'STUDIO_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'LLM_API_KEY', 'CODING_API_KEY_1'];
      const originals: Record<string, string | undefined> = {};
      for (const key of envKeys) {
        originals[key] = process.env[key];
        delete process.env[key];
      }

      try {
        await expect(service.resolve('studio')).rejects.toThrow('No LLM config found');
      } finally {
        for (const key of envKeys) {
          if (originals[key] !== undefined) process.env[key] = originals[key];
          else delete process.env[key];
        }
      }
    });

    it('throws when stored config exists but no API key in env', async () => {
      seedConfig();
      getProviderApiKeyMock.mockReturnValue(null);

      // Clear env fallbacks
      const envKeys = ['LLM_API_KEY_USER', 'STUDIO_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'LLM_API_KEY', 'CODING_API_KEY_1'];
      const originals: Record<string, string | undefined> = {};
      for (const key of envKeys) {
        originals[key] = process.env[key];
        delete process.env[key];
      }

      try {
        await expect(service.resolve('orchestrator')).rejects.toThrow('No API key in environment');
      } finally {
        for (const key of envKeys) {
          if (originals[key] !== undefined) process.env[key] = originals[key];
          else delete process.env[key];
        }
      }
    });
  });

  describe('saveConfig', () => {
    it('validates scope', async () => {
      await expect(service.saveConfig({
        scope: 'invalid_scope' as LLMConfigScope,
        provider: 'anthropic',
        model: 'test',
      })).rejects.toThrow('Invalid scope');
    });

    it('validates provider', async () => {
      await expect(service.saveConfig({
        scope: 'orchestrator',
        provider: 'invalid_provider' as any,
        model: 'test',
      })).rejects.toThrow('Invalid provider');
    });

    it('upserts config and returns masked result', async () => {
      getProviderApiKeyMock.mockReturnValue('sk-test-abcd');

      const result = await service.saveConfig({
        scope: 'orchestrator',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      });

      expect(result.apiKeyMasked).toBe('****abcd');
      expect(result.model).toBe('claude-sonnet-4-6');
      // 配置已持久化到 FileStore
      expect(configsStore).toHaveLength(1);
      expect(configsStore[0].scope).toBe('orchestrator');
    });
  });

  describe('getConfigs', () => {
    it('returns masked configs', async () => {
      seedConfig({ baseUrl: null });
      getProviderApiKeyMock.mockReturnValue('sk-1234');

      const result = await service.getConfigs('orchestrator');
      expect(result).toHaveLength(1);
      expect(result[0].apiKeyMasked).toContain('****');
    });
  });

  describe('deleteConfig', () => {
    it('deletes by id', async () => {
      seedConfig();

      await service.deleteConfig('cfg-1');

      expect(configsStore).toHaveLength(0);
    });

    it('throws when id not found', async () => {
      await expect(service.deleteConfig('no-such-id')).rejects.toThrow('LLMConfig not found');
    });
  });
});
