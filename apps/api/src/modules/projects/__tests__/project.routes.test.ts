/**
 * AC-D1+D3: Project Routes — module smoke test
 *
 * Validates that project.routes module loads and exports a router.
 * ProjectDiscoveryService logic is tested in project-discovery.test.ts.
 */
import { describe, test, expect } from 'vitest';
import router from '../project.routes.js';

describe('Project Routes', () => {
  test('exports an Express router', () => {
    expect(router).toBeDefined();
    expect(typeof router).toBe('function');
  });
});
