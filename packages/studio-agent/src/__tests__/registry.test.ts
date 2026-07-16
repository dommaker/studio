import { describe, it, expect } from 'vitest';
import { DEFAULT_PERSONAS, getPersona, listPersonas } from '../registry.js';

describe('registry', () => {
  describe('DEFAULT_PERSONAS', () => {
    it('has all 4 default roles', () => {
      expect(Object.keys(DEFAULT_PERSONAS)).toHaveLength(4);
      expect(DEFAULT_PERSONAS.pm).toBeDefined();
      expect(DEFAULT_PERSONAS.developer).toBeDefined();
      expect(DEFAULT_PERSONAS.reviewer).toBeDefined();
      expect(DEFAULT_PERSONAS.tester).toBeDefined();
    });

    it('each persona has required fields', () => {
      for (const persona of Object.values(DEFAULT_PERSONAS)) {
        expect(persona.id).toBeTruthy();
        expect(persona.name).toBeTruthy();
        expect(persona.description).toBeTruthy();
        expect(Array.isArray(persona.templates)).toBe(true);
        expect(Array.isArray(persona.capabilities)).toBe(true);
        expect(Array.isArray(persona.skills)).toBe(true);
        expect(Array.isArray(persona.tools)).toBe(true);
        expect(persona.constraints).toBeDefined();
        expect(typeof persona.persona).toBe('string');
      }
    });

    it('persona constraints have expected shape', () => {
      for (const persona of Object.values(DEFAULT_PERSONAS)) {
        expect(typeof persona.constraints.max_concurrent_tasks).toBe('number');
        expect(typeof persona.constraints.requires_approval).toBe('boolean');
        expect(typeof persona.constraints.can_delegate).toBe('boolean');
        expect(typeof persona.constraints.can_spawn_agents).toBe('boolean');
      }
    });

    it('reviewer requires approval', () => {
      expect(DEFAULT_PERSONAS.reviewer.constraints.requires_approval).toBe(true);
    });

    it('pm can delegate and spawn agents', () => {
      expect(DEFAULT_PERSONAS.pm.constraints.can_delegate).toBe(true);
      expect(DEFAULT_PERSONAS.pm.constraints.can_spawn_agents).toBe(true);
    });
  });

  describe('getPersona', () => {
    it('returns persona by id', () => {
      const pm = getPersona('pm');
      expect(pm).toBeDefined();
      expect(pm!.id).toBe('pm');
      expect(pm!.name).toBe('Project Manager');
    });

    it('returns undefined for unknown id', () => {
      expect(getPersona('unknown')).toBeUndefined();
    });

    it('returns developer persona', () => {
      const dev = getPersona('developer');
      expect(dev).toBeDefined();
      expect(dev!.capabilities).toContain('code-implementation');
      expect(dev!.capabilities).toContain('tdd-workflow');
    });
  });

  describe('listPersonas', () => {
    it('returns all 4 personas', () => {
      const all = listPersonas();
      expect(all).toHaveLength(4);
    });

    it('returned personas are sorted by insertion order', () => {
      const all = listPersonas();
      expect(all[0].id).toBe('pm');
      expect(all[1].id).toBe('developer');
      expect(all[2].id).toBe('reviewer');
      expect(all[3].id).toBe('tester');
    });
  });
});
