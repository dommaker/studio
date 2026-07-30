import { describe, it, expect } from 'vitest';

describe('studio-capability imports', () => {
  it('should export CapabilityService', async () => {
    const { CapabilityService } = await import('../services/capability.service.js');
    expect(CapabilityService).toBeDefined();
  });

  it('should have CapabilityService as a class', async () => {
    const { CapabilityService } = await import('../services/capability.service.js');
    expect(typeof CapabilityService).toBe('function');
  });
});