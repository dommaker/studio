// 方向 B 页 smoke test
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DirectionBPage } from '../DirectionBPage';

describe('DirectionBPage', () => {
  it('renders the prototype with direction-b tokens', () => {
    const { container } = render(
      <MemoryRouter>
        <DirectionBPage />
      </MemoryRouter>,
    );
    expect(container.querySelector('.dl.dl-b')).toBeTruthy();
    expect(container.querySelector('.dl-rail')).toBeTruthy();
    expect(container.querySelector('.dl-main')).toBeTruthy();
  });
});
