// Transcript API — #174: WU transcript 只读查看（#60 C5）
import { api } from './index';

/** 单步 transcript 条目（与后端 transcript-archive.ts TranscriptEntry 同构） */
export interface TranscriptEntry {
  workUnitId: string;
  sessionId?: string;
  step: number;
  action?: string;
  rawOutput?: string;
  createdAt: string;
}

export interface TranscriptResponse {
  workUnitId: string;
  total: number;
  offset: number;
  limit: number;
  entries: TranscriptEntry[];
}

export const transcriptsApi = {
  get: (workUnitId: string, params?: { offset?: number; limit?: number }) =>
    api.get<TranscriptResponse>(`/transcripts/${encodeURIComponent(workUnitId)}`, { params }),
};
