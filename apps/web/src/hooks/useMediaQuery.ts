// #395（spec §4.6）：媒体查询 hook——窄屏降级需要 JS 侧断点（决定挂不挂组件，而非仅 CSS 藏显）。
// matchMedia 不可用（jsdom/老环境）时回落 defaultMatches，调用方按宽屏语义给默认值，
// 保证无 matchMedia 环境下行为 = 宽屏（既有页面/测试零改动）。
import { useEffect, useState } from 'react';

export function useMediaQuery(query: string, defaultMatches: boolean): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : defaultMatches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange(); // query 变化后对齐一次
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
