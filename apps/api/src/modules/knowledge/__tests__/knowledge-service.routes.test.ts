import { describe, it, expect } from 'vitest';
import { knowledgeServiceRoutes } from '../knowledge-service.routes.js';

describe('KnowledgeService routes', () => {
  it('exports a valid Express router', () => {
    expect(knowledgeServiceRoutes).toBeDefined();
    expect(typeof knowledgeServiceRoutes.use).toBe('function');
    expect(typeof knowledgeServiceRoutes.get).toBe('function');
    expect(typeof knowledgeServiceRoutes.post).toBe('function');
  });
});
