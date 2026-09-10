// #474 图标策略定稿：全去 emoji——导航/徽章统一走本文件的 stroke SVG 图标组件（currentColor 随文本色）
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  IconChat, IconChart, IconClipboard, IconUsers, IconBook, IconLibrary,
  IconActivity, IconSearch, IconSettings, IconGrid, IconCheck, IconRefresh, IconClock,
} from '../icons';

const ALL_ICONS = {
  IconChat, IconChart, IconClipboard, IconUsers, IconBook, IconLibrary,
  IconActivity, IconSearch, IconSettings, IconGrid, IconCheck, IconRefresh, IconClock,
};

describe('ui/icons — #474 去 emoji 图标组件', () => {
  it('全部渲染 stroke SVG（currentColor 随文本着色，aria-hidden 不进读屏）', () => {
    for (const [name, Icon] of Object.entries(ALL_ICONS)) {
      const { container } = render(<Icon />);
      const svg = container.querySelector('svg');
      expect(svg, name).toBeTruthy();
      expect(svg!.getAttribute('stroke'), name).toBe('currentColor');
      expect(svg!.getAttribute('aria-hidden'), name).toBe('true');
      expect(svg!.getAttribute('fill'), name).toBe('none');
    }
  });

  it('size prop 落到 width/height（默认 16）', () => {
    const { container } = render(<IconCheck size={12} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('12');
    expect(svg.getAttribute('height')).toBe('12');
  });
});
