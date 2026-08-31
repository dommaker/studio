// useAsyncData — 一次性拉取共享 hook（#350，架构评审候选 F5）：与 useGatedPoll（轮询场景）互补。
// 语义即消费方原来的 4 行样板：useState(data/loading/error) + useCallback(load) + useEffect(load)。
// 内建两套微模式：deps 渲染期重置（切参即同步清数据置回加载态）+ 微任务推迟首拉；
// reload() 供刷新按钮/事件路径复用（保留旧数据重拉，error 即清）；setData 供 SSE 就地更新等本地修补。
// best-effort 子拉取（失败静默）由消费方在 fetcher 内自行 catch 落 null。
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type DependencyList, type Dispatch, type SetStateAction,
} from 'react';

export interface AsyncData<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** 手动重拉（刷新按钮 / 弹窗 onCreated / SSE 防抖重拉）；重拉期间旧数据保留 */
  reload: () => void;
  /** 本地数据修补（SSE 就地更新等），绕过 fetch 生命周期 */
  setData: Dispatch<SetStateAction<T | null>>;
}

function depsEqual(a: DependencyList, b: DependencyList): boolean {
  return a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
}

export function useAsyncData<T>(fetcher: () => Promise<T>, deps: DependencyList): AsyncData<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 拉取序号：deps 渲染期重置与 reload 都靠它触发 effect 重拉（deps 本体不进 effect deps）
  const [seq, setSeq] = useState(0);

  // 渲染期 deps 重置：对齐各页 prevX 模式，切参当帧即清数据，不闪旧内容
  const [prevDeps, setPrevDeps] = useState(deps);
  if (!depsEqual(prevDeps, deps)) {
    setPrevDeps(deps);
    setData(null);
    setLoading(true);
    setError(null);
    setSeq(s => s + 1);
  }

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    setSeq(s => s + 1);
  }, []);

  // fetcher 恒用最新闭包：deps 只管「何时重拉」，闭包新旧由重拉时机保证
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    let alive = true;
    // 微任务里触发：对齐 useGatedPoll/各页既有首拉纪律（effect 内同步多语句 async 编译器保守告警）
    void Promise.resolve().then(async () => {
      try {
        const next = await fetcherRef.current();
        if (!alive) return;
        setData(next);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (alive) setLoading(false);
      }
    });
    return () => { alive = false; };
  }, [seq]);

  // 返回值 useMemo 稳身份：消费方可把它直接放进 effect deps（SSE 订阅类）而不逐帧重订阅
  return useMemo(
    () => ({ data, loading, error, reload, setData }),
    [data, loading, error, reload, setData],
  );
}
