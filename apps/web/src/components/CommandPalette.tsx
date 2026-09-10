// CommandPalette — Cmd/Ctrl+K 全局搜索面板（批次 D-2 项 8，docs/plans/2026-09-ui-interaction-polish.md）。
// 纯前端四域扇出：频道（channelApi.list 全量 + 客户端名称子串过滤）、任务（workunitApi.list 服务端 q，
// 批次 D-2 项 4）、需求（requirementApi.list 全量 + 客户端标题/编号过滤）、知识（knowledgeApi.search，
// KnowledgePage 同端点）；统一走 fanOut（#349）——单域失败隔离不炸整批，结果按域序对齐。
// 纪律：面板打开才查询（300ms 防抖，LibraryPage 先例），关闭即清防抖定时器，无轮询/SSE 残留；
// seq 守卫拒迟到响应。样式 styles/command-palette.css，零硬编码色（style-guide §4 token）。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatChannelName, WU_STATUS_LABELS } from '@dommaker/studio-shared/web';
import { channelApi } from '../api/channel';
import { workunitApi } from '../api/workunit';
import { requirementApi } from '../api/requirements';
import { knowledgeApi } from '../api/knowledge';
import { fanOut } from '../utils/fanOut';
import { REQ_STATUS_LABELS } from './requirement/RequirementChainPanel';
import { useImeEnterGuard } from '../hooks/useImeEnterGuard';
import '../styles/command-palette.css';

type PaletteGroup = 'channel' | 'workunit' | 'requirement' | 'knowledge';

interface PaletteItem {
  key: string;
  group: PaletteGroup;
  title: string;
  /** 弱化 meta（频道=类型 / WU·REQ=状态词 / 知识=类型） */
  meta: string;
  /** mono 短码（WU id 前 8 位 / REQ 编号），无则不渲染 */
  code?: string;
  to: string;
}

const LIMIT = 5;
const GROUP_ORDER: readonly PaletteGroup[] = ['channel', 'workunit', 'requirement', 'knowledge'];
const GROUP_LABELS: Record<PaletteGroup, string> = {
  channel: '频道',
  workunit: '任务',
  requirement: '需求',
  knowledge: '知识',
};

interface DomainSearch {
  group: PaletteGroup;
  search: (q: string) => Promise<PaletteItem[]>;
}

const DOMAINS: readonly DomainSearch[] = [
  {
    group: 'channel',
    search: async (q) => {
      const res = await channelApi.list();
      const lq = q.toLowerCase();
      return (res.data?.data ?? [])
        .filter((c) => c.name.toLowerCase().includes(lq))
        .slice(0, LIMIT)
        .map((c) => ({
          key: `channel:${c.id}`,
          group: 'channel' as const,
          title: formatChannelName(c.name),
          meta: c.type,
          to: `/channels/${c.id}`,
        }));
    },
  },
  {
    group: 'workunit',
    search: async (q) => {
      const res = await workunitApi.list({ q, limit: LIMIT });
      return (res.data?.data ?? []).map((wu) => ({
        key: `wu:${wu.id}`,
        group: 'workunit' as const,
        title: wu.scope,
        meta: WU_STATUS_LABELS[wu.status] ?? wu.status,
        code: wu.id.slice(0, 8),
        to: `/workunits/${wu.id}`,
      }));
    },
  },
  {
    group: 'requirement',
    search: async (q) => {
      const res = await requirementApi.list();
      const lq = q.toLowerCase();
      return (res.data?.data ?? [])
        .filter((r) => r.title.toLowerCase().includes(lq) || r.id.toLowerCase().includes(lq))
        .slice(0, LIMIT)
        .map((r) => ({
          key: `req:${r.id}`,
          group: 'requirement' as const,
          title: r.title,
          meta: REQ_STATUS_LABELS[r.status] ?? r.status,
          code: r.id,
          to: '/pmo?tab=reqs',
        }));
    },
  },
  {
    group: 'knowledge',
    search: async (q) => {
      const res = await knowledgeApi.search(q);
      return (res.data?.results ?? []).slice(0, LIMIT).map((r) => ({
        key: `kn:${r.type}:${r.id}`,
        group: 'knowledge' as const,
        title: r.title,
        meta: r.type,
        to: '/knowledge',
      }));
    },
  },
];

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<PaletteItem[]>([]);
  /** 最近一次完成搜索的词——结果区按 resultQuery === 当前词 门控，loading/结果态全派生零额外 state */
  const [resultQuery, setResultQuery] = useState('');
  const [highlight, setHighlight] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef(0);
  const { handleCompositionEnd, isImeEvent } = useImeEnterGuard();

  // 打开时重置会话（渲染期调整态，避免 set-state-in-effect）
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setQuery('');
      setItems([]);
      setResultQuery('');
      setHighlight(-1);
    }
  }

  // 打开即聚焦输入框
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // 300ms 防抖四域并行扇出；卸载/关闭/词变化即清定时器（无残留）
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) return;
    const seq = ++seqRef.current;
    const timer = setTimeout(() => {
      void (async () => {
        const entries = await fanOut(DOMAINS, (d) => d.search(q));
        if (seq !== seqRef.current) return; // 迟到响应丢弃
        // fanOut 契约（fanOut.ts 注）：repo 非 strict，取 error 分支需显式 entry.ok === true
        const flat = entries.flatMap((e) => (e.ok === true ? e.value : []));
        setItems(flat);
        setResultQuery(q);
        setHighlight(flat.length > 0 ? 0 : -1);
      })();
    }, 300);
    return () => clearTimeout(timer);
  }, [query, open]);

  const trimmed = query.trim();
  const visible = trimmed !== '' && resultQuery === trimmed;
  const searching = trimmed !== '' && resultQuery !== trimmed;

  // 分组 + 跨组连续序号（键盘高亮/鼠标 hover 同一序号体系）；items 本身按域序产出，序号天然连续
  const grouped = useMemo(() => {
    let idx = 0;
    return GROUP_ORDER.map((group) => ({
      group,
      rows: items.filter((i) => i.group === group).map((item) => ({ item, idx: idx++ })),
    })).filter((g) => g.rows.length > 0);
  }, [items]);

  // 键盘高亮项滚入可视区（jsdom 无 scrollIntoView 实现，防御性调用，同 Select）
  useEffect(() => {
    if (highlight < 0) return;
    const el = listRef.current?.querySelector(`[data-cmdk-idx="${highlight}"]`);
    (el as HTMLElement | null | undefined)?.scrollIntoView?.({ block: 'nearest' });
  }, [highlight]);

  const go = (item: PaletteItem) => {
    navigate(item.to);
    onClose();
  };

  const move = (dir: 1 | -1) => {
    if (items.length === 0) return;
    setHighlight((h) => (h + dir + items.length) % items.length);
  };

  // 挂在面板容器：输入框按键冒泡统一处理（Esc 关 / ↑↓ 高亮 / Enter 跳转）
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (!visible || items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      if (isImeEvent(e)) return; // IME 选词 Enter 不跳转（#270 守卫）
      const item = items[highlight];
      if (item) {
        e.preventDefault();
        go(item);
      }
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay cmdk-overlay" onClick={onClose}>
      <div
        className="cmdk-panel"
        role="dialog"
        aria-label="全局搜索"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="input cmdk-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onCompositionEnd={handleCompositionEnd}
          placeholder="搜索频道、任务、需求、知识…"
          aria-label="搜索关键词"
        />
        <div ref={listRef} className="cmdk-results" role="listbox" aria-label="搜索结果">
          {trimmed === '' && <div className="cmdk-hint">输入关键词，并行搜索四个域（各取前 {LIMIT} 条）</div>}
          {searching && <div className="cmdk-hint">搜索中…</div>}
          {visible && items.length === 0 && <div className="cmdk-hint">无匹配</div>}
          {visible && grouped.map((g) => (
            <div key={g.group} className="cmdk-group">
              <div className="cmdk-group-label">{GROUP_LABELS[g.group]}</div>
              {g.rows.map(({ item, idx }) => (
                <div
                  key={item.key}
                  role="option"
                  aria-selected={idx === highlight}
                  data-cmdk-idx={idx}
                  className={`cmdk-item${idx === highlight ? ' is-highlighted' : ''}`}
                  onMouseEnter={() => setHighlight(idx)}
                  onClick={() => go(item)}
                >
                  <span className="cmdk-item-title">{item.title}</span>
                  <span className="cmdk-item-meta">
                    {item.meta}
                    {item.code && <span className="cmdk-item-code"> · {item.code}</span>}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="cmdk-footer">↑↓ 选择 · Enter 跳转 · Esc 关闭</div>
      </div>
    </div>
  );
}
