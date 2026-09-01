// avatar 纯函数（#440 Phase 4）— per-agent 确定性 identicon 图样：
// 同名恒同图；不同名可区分；5x5 网格右两列镜像（identicon 经典对称形态）。
import { describe, it, expect } from 'vitest';
import { avatarPattern, avatarCellAt } from '../avatar';

describe('avatarPattern', () => {
  it('同名 → 恒同图（跨调用确定性）', () => {
    expect(avatarPattern('dev-agent')).toEqual(avatarPattern('dev-agent'));
  });

  it('不同名 → 可区分（样例集两两不同）', () => {
    const names = ['pm', 'developer', 'reviewer', 'librarian', 'ops', 'auditor', 'dev-agent', 'coder-01'];
    const patterns = names.map(avatarPattern);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        expect(patterns[i], `"${names[i]}" 与 "${names[j]}" 图样撞车`).not.toEqual(patterns[j]);
      }
    }
  });

  it('paletteIndex 落在 --chart-1..9（0..8）；cells = 5 行 × 左 3 列', () => {
    const p = avatarPattern('x');
    expect(p.paletteIndex).toBeGreaterThanOrEqual(0);
    expect(p.paletteIndex).toBeLessThan(9);
    expect(p.cells).toHaveLength(15);
  });

  it('空图样兜底：至少一格点亮（不出现纯空头像）', () => {
    // 穷举一批名字，每个都至少有一格
    for (const n of ['a', 'b', 'c', 'zz', '张三', '🎯', 'agent-007']) {
      expect(avatarPattern(n).cells.some(Boolean)).toBe(true);
    }
  });
});

describe('avatarCellAt — 5x5 网格镜像取格', () => {
  it('右两列 = 左两列镜像（col4=col0, col3=col1），中列自对称', () => {
    const p = avatarPattern('mirror-check');
    for (let r = 0; r < 5; r++) {
      expect(avatarCellAt(p, r, 4)).toBe(avatarCellAt(p, r, 0));
      expect(avatarCellAt(p, r, 3)).toBe(avatarCellAt(p, r, 1));
      expect(avatarCellAt(p, r, 2)).toBe(p.cells[r * 3 + 2]);
    }
  });
});
