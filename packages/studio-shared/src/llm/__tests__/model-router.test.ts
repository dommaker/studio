/**
 * Model Router — tests
 *
 * R3: Gateway per-tier model selection
 * R1: prompt/promptJson options passthrough (provider/tier)
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveProviders } from '../provider-registry.js';
import { prompt, promptJson } from '../model-router.js';
import type { ProviderConfig, GatewayRequest, GatewayResponse } from '../model-router.js';

function makeRequest(tier?: string): GatewayRequest {
  return {
    messages: [{ role: 'user', content: 'test' }],
    ...(tier ? { tier } : {}),
  };
}

describe('resolveProviders — tier model selection', () => {
  const providerWithTiers: ProviderConfig = {
    name: 'studio',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'test-key',
    model: 'deepseek-v4-flash',
    priority: 0,
    tierModels: {
      fast: 'deepseek-v4-flash',
      standard: 'deepseek-v4-pro',
      premium: 'deepseek-v4-pro',
    },
  };

  const providerWithoutTiers: ProviderConfig = {
    name: 'basic',
    baseUrl: 'https://api.example.com',
    apiKey: 'key',
    model: 'default-model',
    priority: 1,
  };

  it('no tier → uses default provider.model', () => {
    const resolved = resolveProviders([providerWithTiers], makeRequest());
    expect(resolved).toHaveLength(1);
    expect(resolved[0].model).toBe('deepseek-v4-flash');
  });

  it('tier=standard → resolves to tierModels.standard', () => {
    const resolved = resolveProviders([providerWithTiers], makeRequest('standard'));
    expect(resolved).toHaveLength(1);
    expect(resolved[0].model).toBe('deepseek-v4-pro');
  });

  it('tier=fast → resolves to tierModels.fast', () => {
    const resolved = resolveProviders([providerWithTiers], makeRequest('fast'));
    expect(resolved).toHaveLength(1);
    expect(resolved[0].model).toBe('deepseek-v4-flash');
  });

  it('tier=premium → resolves to tierModels.premium', () => {
    const resolved = resolveProviders([providerWithTiers], makeRequest('premium'));
    expect(resolved).toHaveLength(1);
    expect(resolved[0].model).toBe('deepseek-v4-pro');
  });

  it('unknown tier → falls back to provider.model', () => {
    const resolved = resolveProviders([providerWithTiers], makeRequest('unknown'));
    expect(resolved).toHaveLength(1);
    expect(resolved[0].model).toBe('deepseek-v4-flash');
  });

  it('provider without tierModels + tier → uses provider.model', () => {
    const resolved = resolveProviders([providerWithoutTiers], makeRequest('standard'));
    expect(resolved).toHaveLength(1);
    expect(resolved[0].model).toBe('default-model');
  });

  it('multiple providers with different tierModels → each resolves independently', () => {
    const p2: ProviderConfig = {
      name: 'knowledge',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'key2',
      model: 'knowledge-default',
      priority: 1,
      tierModels: {
        fast: 'knowledge-fast',
        standard: 'knowledge-standard',
      },
    };
    const resolved = resolveProviders([providerWithTiers, p2], makeRequest('standard'));
    expect(resolved).toHaveLength(2);
    expect(resolved[0].model).toBe('deepseek-v4-pro');
    expect(resolved[1].model).toBe('knowledge-standard');
  });
});

describe('prompt/promptJson — options passthrough', () => {
  const mockResponse: GatewayResponse = {
    content: '{"result":"ok"}',
    model: 'test-model',
    provider: 'test',
    latencyMs: 10,
  };

  it('prompt passes options to chatFn request', async () => {
    const chatFn = vi.fn().mockResolvedValue(mockResponse);
    await prompt('hello', 'sys', chatFn, { provider: 'knowledge', tier: 'standard' });
    expect(chatFn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'knowledge',
        tier: 'standard',
        messages: expect.arrayContaining([
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hello' },
        ]),
      }),
    );
  });

  it('prompt without options sends minimal request', async () => {
    const chatFn = vi.fn().mockResolvedValue(mockResponse);
    await prompt('hello', undefined, chatFn);
    expect(chatFn).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    );
    expect(chatFn.mock.calls[0][0]).not.toHaveProperty('provider');
    expect(chatFn.mock.calls[0][0]).not.toHaveProperty('tier');
  });

  it('promptJson passes options to chatFn request', async () => {
    const jsonResponse: GatewayResponse = {
      ...mockResponse,
      content: '{"entries":[]}',
    };
    const chatFn = vi.fn().mockResolvedValue(jsonResponse);
    await promptJson('extract', 'sys', chatFn, { provider: 'knowledge', tier: 'standard' });
    expect(chatFn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'knowledge',
        tier: 'standard',
      }),
    );
  });
});
