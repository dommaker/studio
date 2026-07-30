// WU 步内流式订阅（Layer B）— SSE `workunit.execution.stream` 实时 chunk
// 只存内存、只留当前步（容量纪律：chunk 不落盘，前端也不无限累积）：
//   - 按 workUnitId 过滤；损坏行跳过（parseExecutionStreamChunk → null）
//   - 新一步的 step-start 到达 → 清空上一步残留（步级归档卡片由 REST 回放接替）
//   - 上限 50 条（超出丢最旧）
// 消费方：WorkUnitDrawer「执行过程」实时区块
import { useEffect, useState } from 'react';
import { useWebSocketContext } from '../api/websocket';
import { parseExecutionStreamChunk, type ExecutionStreamChunk } from '../api/workunit';

const MAX_LIVE_CHUNKS = 50;

export function useWorkUnitStreamEvents(workUnitId: string | null): ExecutionStreamChunk[] {
  const { onEvent } = useWebSocketContext();
  const [chunks, setChunks] = useState<ExecutionStreamChunk[]>([]);

  useEffect(() => {
    setChunks([]);
    if (!workUnitId) return;
    const unsub = onEvent((msg) => {
      if (msg.event_type !== 'workunit.execution.stream') return;
      const chunk = parseExecutionStreamChunk(msg.data);
      if (!chunk || chunk.workUnitId !== workUnitId) return;
      setChunks(prev => {
        // 新一步开始 → 清空上一步残留（以 step-start 为步边界信号）
        const base = chunk.kind === 'step-start' && prev.length > 0 && prev[prev.length - 1].step !== chunk.step
          ? []
          : prev;
        const next = [...base, chunk];
        return next.length > MAX_LIVE_CHUNKS ? next.slice(next.length - MAX_LIVE_CHUNKS) : next;
      });
    });
    return unsub;
  }, [workUnitId, onEvent]);

  return chunks;
}
