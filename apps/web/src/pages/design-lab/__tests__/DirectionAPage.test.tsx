// 方向 A 页 smoke test
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DirectionAPage } from '../DirectionAPage';

describe('DirectionAPage', () => {
  it('renders the prototype with direction-a tokens', () => {
    const { container } = render(
      <MemoryRouter>
        <DirectionAPage />
      </MemoryRouter>,
    );
    expect(container.querySelector('.dl.dl-a')).toBeTruthy();
    expect(container.querySelector('.dl-rail')).toBeTruthy();
    expect(container.querySelector('.dl-main')).toBeTruthy();
  });
});
