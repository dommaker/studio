/**
 * KnowledgeService — Phase 0 contract test
 *
 * Verifies the interface exists with correct method signatures.
 * No behavior tested — implementation comes in Phase 1.
 */
import { describe, it, expect } from 'vitest';
import { KnowledgeService } from '../knowledge-service.js';

describe('KnowledgeService (Phase 0: interface contract)', () => {
  const ks = new KnowledgeService();

  describe('Produce', () => {
    it('extractFromExecution exists', () => {
      expect(typeof ks.extractFromExecution).toBe('function');
    });
    it('extractFromConversation exists', () => {
      expect(typeof ks.extractFromConversation).toBe('function');
    });
    it('recordPattern exists', () => {
      expect(typeof ks.recordPattern).toBe('function');
    });
    it('recordIncident exists', () => {
      expect(typeof ks.recordIncident).toBe('function');
    });
    it('recordTrend exists', () => {
      expect(typeof ks.recordTrend).toBe('function');
    });
    it('recordAnalystAccuracy exists', () => {
      expect(typeof ks.recordAnalystAccuracy).toBe('function');
    });
  });

  describe('Consume', () => {
    it('injectContext returns string', async () => {
      const result = await ks.injectContext('executor');
      expect(typeof result).toBe('string');
    });
    it('search returns array', async () => {
      const result = await ks.search('test');
      expect(Array.isArray(result)).toBe(true);
    });
    it('matchResolutions returns array', async () => {
      const result = await ks.matchResolutions('problem');
      expect(Array.isArray(result)).toBe(true);
    });
    it('list returns array', async () => {
      const result = await ks.list();
      expect(Array.isArray(result)).toBe(true);
    });
    it('get returns null for missing id', async () => {
      const result = await ks.get('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('Track', () => {
    it('recordConsumption is synchronous', () => {
      expect(() => ks.recordConsumption(['id1'], 'ctx')).not.toThrow();
    });
    it('recordOutcome exists', () => {
      expect(typeof ks.recordOutcome).toBe('function');
    });
    it('recordFeedback exists', () => {
      expect(typeof ks.recordFeedback).toBe('function');
    });
  });

  describe('Lifecycle', () => {
    it('promote exists', () => {
      expect(typeof ks.promote).toBe('function');
    });
    it('decay exists', () => {
      expect(typeof ks.decay).toBe('function');
    });
    it('merge exists', () => {
      expect(typeof ks.merge).toBe('function');
    });
    it('graduateConstraint exists', () => {
      expect(typeof ks.graduateConstraint).toBe('function');
    });
  });

  describe('Resolve', () => {
    it('createResolution exists', () => {
      expect(typeof ks.createResolution).toBe('function');
    });
  });

  describe('Measure', () => {
    it('getFlywheelMetrics returns FlywheelMetrics shape', async () => {
      const m = await ks.getFlywheelMetrics();
      expect(m).toHaveProperty('quality');
      expect(m).toHaveProperty('hitRate');
      expect(m).toHaveProperty('improvement');
      expect(m).toHaveProperty('freshness');
    });
    it('getHealthReport returns HealthReport shape', async () => {
      const r = await ks.getHealthReport();
      expect(r).toHaveProperty('score');
      expect(r).toHaveProperty('totalEntries');
    });
    it('getAuditReport returns AuditReport shape', async () => {
      const r = await ks.getAuditReport();
      expect(r).toHaveProperty('findings');
      expect(r).toHaveProperty('trend');
    });
    it('getAnalystAccuracy returns AccuracyReport shape', async () => {
      const r = await ks.getAnalystAccuracy();
      expect(r).toHaveProperty('overallAccuracy');
      expect(r).toHaveProperty('byAnalyst');
    });
  });

  describe('method count', () => {
    it('has exactly 23 public methods', () => {
      const methods = Object.getOwnPropertyNames(KnowledgeService.prototype)
        .filter(m => m !== 'constructor');
      expect(methods).toHaveLength(23);
    });
  });
});
