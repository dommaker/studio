/**
 * LLM Config Service tests — resolve (layered lookup), saveConfig, maskConfig
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const isCI = !!process.env.CI;
const describeIf = isCI ? describe.skip : describe;

const { lLMConfigMock, getProviderApiKeyMock, modelGatewayMock } = vi.hoisted(() => ({
  lLMConfigMock: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
  getProviderApiKeyMock: vi.fn(),
  modelGatewayMock: { addProvider: vi.fn() },
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: { lLMConfig: lLMConfigMock },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  modelGateway: modelGatewayMock,
  getProviderApiKey: (...args: unknown[]) => getProviderApiKeyMock(...args),
}));

import { LLMConfigService, type LLMConfigScope } from '../config.service.js';

describeIf('LLMConfigService', () => {
  let service: LLMConfigService;

  beforeEach(() => {
    service = new LLMConfigService();
    lLMConfigMock.findFirst.mockReset();
    lLMConfigMock.findMany.mockReset();
    lLMConfigMock.upsert.mockReset();
    lLMConfigMock.delete.mockReset();
    getProviderApiKeyMock.mockReset();
    modelGatewayMock.addProvider.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('resolve', () => {
    it('returns exact scope match', async () => {
      lLMConfigMock.findFirst.mockResolvedValueOnce({
        id: 'cfg-1',
        scope: 'orchestrator',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        options: '{}',
        isActive: true,
      });
      getProviderApiKeyMock.mockReturnValue('sk-test-key-1234');

      const result = await service.resolve('orchestrator');

      expect(result.provider).toBe('anthropic');
      expect(result.model).toBe('claude-sonnet-4-6');
      expect(result.apiKey).toBe('sk-test-key-1234');
      expect(result.source).toBe('orchestrator');
    });

    it('falls back to agent_default for agent_* scopes', async () => {
      lLMConfigMock.findFirst
        .mockResolvedValueOnce(null) // exact match
        .mockResolvedValueOnce({    // agent_default
          id: 'cfg-default',
          scope: 'agent_default',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
          options: '{}',
          isActive: true,
        });
      getProviderApiKeyMock.mockReturnValue('sk-openai-key');

      const result = await service.resolve('agent_claude');

      expect(result.source).toBe('agent_default');
      expect(result.model).toBe('gpt-4o');
    });

    it('falls back to env when no DB config', async () => {
      lLMConfigMock.findFirst.mockResolvedValue(null);
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
      lLMConfigMock.findFirst.mockResolvedValue(null);
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

    it('throws when DB config exists but no API key in env', async () => {
      lLMConfigMock.findFirst.mockResolvedValueOnce({
        id: 'cfg-1',
        scope: 'orchestrator',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        options: '{}',
        isActive: true,
      });
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
      lLMConfigMock.upsert.mockResolvedValueOnce({
        id: 'cfg-1',
        scope: 'orchestrator',
        provider: 'anthropic',
        baseUrl: null,
        model: 'claude-sonnet-4-6',
        options: '{}',
        isActive: true,
      });
      getProviderApiKeyMock.mockReturnValue('sk-test-abcd');

      const result = await service.saveConfig({
        scope: 'orchestrator',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      });

      expect(result.apiKeyMasked).toBe('****abcd');
      expect(result.model).toBe('claude-sonnet-4-6');
    });
  });

  describe('getConfigs', () => {
    it('returns masked configs', async () => {
      lLMConfigMock.findMany.mockResolvedValueOnce([{
        id: 'cfg-1',
        scope: 'orchestrator',
        provider: 'anthropic',
        baseUrl: null,
        model: 'claude-sonnet-4-6',
        options: '{}',
        isActive: true,
      }]);
      getProviderApiKeyMock.mockReturnValue('sk-1234');

      const result = await service.getConfigs('orchestrator');
      expect(result).toHaveLength(1);
      expect(result[0].apiKeyMasked).toContain('****');
    });
  });

  describe('deleteConfig', () => {
    it('deletes by id', async () => {
      lLMConfigMock.delete.mockResolvedValueOnce({});
      await service.deleteConfig('cfg-1');
      expect(lLMConfigMock.delete).toHaveBeenCalledWith({ where: { id: 'cfg-1' } });
    });
  });
});
