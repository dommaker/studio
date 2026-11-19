import type { WorkUnitMetadataRepository, WorkUnitSnapshot } from '@dommaker/studio-shared';

/** 把一次消息请求关联到 WU；可选回复与 trace 在同一把锁内附加。 */
export class TraceLink {
  constructor(private readonly repository: WorkUnitMetadataRepository) {}

  attach(
    wuId: string,
    traceId: string,
    opts?: { pendingReply?: string },
  ): Promise<WorkUnitSnapshot | null> {
    return this.repository.mutate(wuId, latest => ({
      ...latest,
      traceId,
      ...(opts?.pendingReply !== undefined
        ? { pendingReplies: [...(Array.isArray(latest.pendingReplies) ? latest.pendingReplies : []), opts.pendingReply] }
        : {}),
    }));
  }
}
