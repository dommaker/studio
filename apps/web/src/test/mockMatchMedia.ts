// #395：jsdom 无 window.matchMedia 实现——按给定视口宽度求值 (min|max)-width 媒体查询，
// setWidth 变更后向已注册 listener 派发 change（驱动 useMediaQuery 重算）。
// 仅支持本仓用到的 (max-width: Npx) / (min-width: Npx) 单条件查询；多条件/未知查询抛错防误用。
type ChangeListener = () => void;

interface MockMediaQueryList extends MediaQueryList {
  __query: string;
}

let currentWidth = 1024;
const queries: MockMediaQueryList[] = [];

function evalQuery(query: string, width: number): boolean {
  const max = /^\(max-width:\s*(\d+)px\)$/.exec(query.trim());
  if (max) return width <= Number(max[1]);
  const min = /^\(min-width:\s*(\d+)px\)$/.exec(query.trim());
  if (min) return width >= Number(min[1]);
  throw new Error(`mockMatchMedia: 不支持的媒体查询 "${query}"`);
}

/** 安装 matchMedia mock；返回 setWidth（改宽度并派发 change）。afterEach 请调 uninstallMatchMedia */
export function mockMatchMedia(initialWidth: number): { setWidth: (w: number) => void } {
  currentWidth = initialWidth;
  queries.length = 0;
  window.matchMedia = (query: string): MediaQueryList => {
    const listeners = new Set<ChangeListener>();
    const mq = {
      __query: query,
      get matches() { return evalQuery(query, currentWidth); },
      media: query,
      onchange: null,
      addEventListener: (_: string, cb: ChangeListener) => { listeners.add(cb); },
      removeEventListener: (_: string, cb: ChangeListener) => { listeners.delete(cb); },
      addListener: (cb: ChangeListener) => { listeners.add(cb); },
      removeListener: (cb: ChangeListener) => { listeners.delete(cb); },
      dispatchEvent: () => true,
      __fire: () => { listeners.forEach(cb => cb()); },
    } as unknown as MockMediaQueryList & { __fire: () => void };
    queries.push(mq);
    return mq;
  };
  return {
    setWidth: (w: number) => {
      const changed = queries.some(mq => evalQuery(mq.__query, currentWidth) !== evalQuery(mq.__query, w));
      currentWidth = w;
      if (changed) {
        for (const mq of queries) (mq as unknown as { __fire: () => void }).__fire();
      }
    },
  };
};

/** 还原 matchMedia 为未实现状态（jsdom 默认），避免跨文件泄漏 */
export function uninstallMatchMedia(): void {
  queries.length = 0;
  // 恢复 jsdom 初始形态（无 matchMedia）
  delete (window as { matchMedia?: unknown }).matchMedia;
}
