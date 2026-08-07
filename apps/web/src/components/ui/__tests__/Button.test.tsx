import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from '../Button';

describe('Button', () => {
  it('渲染 children，默认 .btn .btn-primary 类', () => {
    render(<Button>保存</Button>);
    const btn = screen.getByRole('button', { name: '保存' });
    expect(btn.className).toBe('btn btn-primary');
    expect(btn).not.toBeDisabled();
  });

  it('variant/size/className 映射到 theme.css 类体系', () => {
    render(<Button variant="danger" size="sm" className="extra">删除</Button>);
    const btn = screen.getByRole('button', { name: '删除' });
    expect(btn.className).toBe('btn btn-danger btn-sm extra');
  });

  it('loading：禁用 + aria-busy + spinner，点击不再触发 onClick', () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>提交</Button>);
    const btn = screen.getByRole('button', { name: '提交' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn.querySelector('.btn-spinner')).not.toBeNull();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('loadingLabel 替换 loading 期间文案', () => {
    render(<Button loading loadingLabel="运行中…">执行</Button>);
    expect(screen.getByRole('button', { name: /运行中…/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '执行' })).toBeNull();
  });

  it('disabled 透传；onClick 正常触发', () => {
    const onClick = vi.fn();
    const { unmount } = render(<Button onClick={onClick}>点我</Button>);
    fireEvent.click(screen.getByRole('button', { name: '点我' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    unmount();

    render(<Button disabled>禁用</Button>);
    expect(screen.getByRole('button', { name: '禁用' })).toBeDisabled();
  });
});
