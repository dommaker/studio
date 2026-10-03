// Transcript API — #174: WU transcript 只读查看（#60 C5）
//
// 契约驱动迁移（2026-10 批次 5/7）：手抄 interface（TranscriptEntry/
// TranscriptResponse）删除改 contract import；响应统一 `{ data }` 壳（原平铺），
// 消费方解包 res.data → res.data.data。
import type { TranscriptEntry, TranscriptResult } from '@dommaker/studio-contract';
import { api } from './index';

export type { TranscriptEntry };
/** GET /transcripts/:workUnitId 响应 data（原 TranscriptResponse，契约名 TranscriptResult） */
export type TranscriptResponse = TranscriptResult;

export const transcriptsApi = {
  get: (workUnitId: string, params?: { offset?: number; limit?: number }) =>
    api.get<{ data: TranscriptResult }>(`/transcripts/${encodeURIComponent(workUnitId)}`, { params }),
};
