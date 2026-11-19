import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const fetchStreamTicket = vi.hoisted(() => vi.fn());
vi.mock('../streamTicket', () => ({ fetchStreamTicket }));

import { AttachmentImage } from '../AttachmentImage';
import { useAuthStore } from '../../stores/authStore';

const ATTACHMENT = '/api/v1/channels/ch1/attachments/abc.png';

describe('AttachmentImage', () => {
  it('uses a short resource ticket instead of putting the login JWT in img src', async () => {
    useAuthStore.setState({ token: 'long-lived-jwt' } as any);
    fetchStreamTicket.mockResolvedValue('short-ticket');
    const { container } = render(<AttachmentImage src={ATTACHMENT} alt="capture" />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src') ?? '').not.toContain('long-lived-jwt');
    await waitFor(() => expect(img.getAttribute('src')).toBe(`${ATTACHMENT}?token=short-ticket`));
    expect(fetchStreamTicket).toHaveBeenCalledWith(ATTACHMENT);
    useAuthStore.setState({ token: null } as any);
  });

  it('leaves non-attachment sources untouched', () => {
    const { container } = render(<AttachmentImage src="https://example.test/image.png" alt="external" />);
    expect(container.querySelector('img')!.getAttribute('src')).toBe('https://example.test/image.png');
  });
});
