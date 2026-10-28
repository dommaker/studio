import { describe, expect, it } from 'vitest';
import { parseWuPmoId } from '../wu-attribution';

describe('parseWuPmoId', () => {
  it('读取 canonical pmoId，拒绝损坏或空值', () => {
    expect(parseWuPmoId('{"pmoId":"pmo-1"}')).toBe('pmo-1');
    expect(parseWuPmoId('{"pmoId":""}')).toBeNull();
    expect(parseWuPmoId('{"pmoId":1}')).toBeNull();
    expect(parseWuPmoId('not-json')).toBeNull();
    expect(parseWuPmoId(null)).toBeNull();
  });
});
