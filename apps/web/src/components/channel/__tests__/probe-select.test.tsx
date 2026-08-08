import { describe, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';

function Probe() {
  const [content, setContent] = useState('');
  const [pos, setPos] = useState(-1);
  return (
    <div>
      <textarea
        data-testid="ta"
        value={content}
        onChange={e => { setContent(e.target.value); setPos(e.target.selectionStart ?? -9); }}
        onSelect={e => setPos(e.currentTarget.selectionStart ?? -2)}
      />
      <div data-testid="pos">{pos}</div>
    </div>
  );
}

describe('probe2', () => {
  it('which event triggers React onSelect for cursor move', () => {
    render(<Probe />);
    const ta = screen.getByTestId('ta') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'hi @dev' } });
    console.log('[PROBE2] after change pos=', screen.getByTestId('pos').textContent, 'sel=', ta.selectionStart);

    ta.setSelectionRange(2, 2);
    fireEvent.select(ta);
    console.log('[PROBE2] after select pos=', screen.getByTestId('pos').textContent);

    ta.setSelectionRange(5, 5);
    fireEvent.keyUp(ta, { key: 'ArrowLeft' });
    console.log('[PROBE2] after keyUp pos=', screen.getByTestId('pos').textContent);

    ta.setSelectionRange(1, 1);
    fireEvent(document, new Event('selectionchange'));
    console.log('[PROBE2] after selectionchange pos=', screen.getByTestId('pos').textContent);
  });
});
