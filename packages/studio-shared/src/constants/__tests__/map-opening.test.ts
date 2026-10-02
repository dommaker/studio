/**
 * constants/map-opening — FOG 上限常量测试（P2-c 下沉）
 */
import { describe, it, expect } from 'vitest';
import { MAP_OPENING_FOG_MAX } from '../map-opening.js';

describe('MAP_OPENING_FOG_MAX', () => {
  it('保持既有取值（12）——确认载荷/台账/裁决三方同一上限', () => {
    expect(MAP_OPENING_FOG_MAX).toBe(12);
  });
});
