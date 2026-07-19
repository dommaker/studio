// Design Lab 索引页 smoke test
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DesignLabPage } from '../DesignLabPage';

describe('DesignLabPage', () => {
  it('links to both direction prototypes', () => {
    render(
      <MemoryRouter>
        <DesignLabPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Mission Control 控制台')).toBeTruthy();
    expect(screen.getByText('深夜编辑部')).toBeTruthy();
    expect(screen.getByText('Mission Control 控制台').closest('a')!.getAttribute('href')).toBe('/design-lab/a');
    expect(screen.getByText('深夜编辑部').closest('a')!.getAttribute('href')).toBe('/design-lab/b');
  });
});
