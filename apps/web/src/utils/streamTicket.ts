import type { StreamTicketResult } from '@dommaker/studio-contract';
import { api } from '../api/client';

/** The API client supplies Bearer auth; only the short resource ticket enters a URL. */
export async function fetchStreamTicket(resource: string): Promise<string> {
  const response = await api.post<{ data: StreamTicketResult }>('/auth/stream-ticket', { resource });
  return response.data.data.token;
}
