// Channel message input — AC-C1: @mention autocomplete + AC-C2: reply mode
// 2026-07 视觉重构（方向 A Mission Control）：mc-inputbar 视觉重绘；交互语义零变更
// #281（决策 #249 §5 / #248 D9）：@弹框统一分组——上 Agents 下 Files；文件候选走
// 频道词表（git ls-files）路径后缀精确匹配补全，选中插入纯路径文本（mention 正则不动），
// 发送时携带结构化 files=[{repo, path}]（仅保留正文仍含其路径的引用，防陈旧）。
// #485：fileRefs 台账可视化——chip 可单独移除；正文被编辑得不含路径时 chip 标灰「已失效」，不静默丢弃。
// #486：发送中 textarea 不再整段禁用（可接着打下一条）；乐观回显在 useChannelMessages，本组件
// 只保留发送钮/handleSend 的 sending 防重复提交。
// #638：`#` 触发 PMO 自动补全弹框（候选 = 当前 PMO 置顶 + 挂接 REQ 所属 PMO，选中插入
// `#PMO-n ` 纯文本 token，后端 req-binding PMO_TOKEN_RE 同形）；placeholder 提及 @角色 派单。
import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import type { AgentProfile, ChannelMessage, ChannelPmoCandidate, FileRef, MergeTargetPreview, SendIntent } from '../../api/channel';
import { channelApi } from '../../api/channel';
import { useImeEnterGuard } from '../../hooks/useImeEnterGuard';
import { useRosterStore, activeAgentsOf } from '../../stores/rosterStore';
import { useChannelDataStore } from '../../stores/channelDataStore';
import { toast } from '../../utils/toast';
import { emitSendClick } from '../../utils/clientPerf';
import { IconImage, IconX } from '../ui/icons';

interface Props {
  onSend: (content: string, replyToId?: string, files?: FileRef[], intent?: SendIntent) => void | Promise<unknown>;
  sending: boolean;
  replyTo?: ChannelMessage | null;
  onCancelReply?: () => void;
  channelId?: string;
  /** #440：外部填入口（建议片点击 → 填入输入框）。nonce 变化才写入，同 nonce 不覆盖用户编辑 */
  prefill?: { text: string; nonce: number };
  /** channel 上下游优化 Phase 1（AC4）：reply 预览条点击定位被回复消息（✕ 取消钮保持独立） */
  onReplyPreviewClick?: (messageId: string) => void;
}

/** 文件候选展示上限（词表可能数千条，弹框只给补全头部） */
const FILE_CANDIDATE_CAP = 20;

/** #632：归属预览拉取防抖（与后端 detectMention 同正则，见 MERGE_MENTION_RE） */
const MERGE_PREVIEW_DEBOUNCE_MS = 400;
/** 与后端 detectMention 同正则——含 @mention 的内容不走 merge 归属预览 */
const MERGE_MENTION_RE = /@([\p{L}\p{N}_-]+)/u;

/** 2026-09 截图粘贴：图片白名单/上限与后端 attachments.ts 同口径（客户端先拦一道即时反馈，服务端仍兜底） */
const IMAGE_MIME_WHITELIST = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** File → base64（剥 data:URL 前缀） */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** 工程绝对路径 → basename（多仓同名文件消歧展示用） */
function repoBasename(repo: string): string {
  return repo.split('/').filter(Boolean).pop() ?? repo;
}

export function ChannelInput({ onSend, sending, replyTo, onCancelReply, channelId, prefill, onReplyPreviewClick }: Props) {
  const [content, setContent] = useState('');
  // 光标位置由 onChange/onSelect 事件写入 state（渲染期禁读 ref）。
  // 顺带修复旧缺陷：原实现 memo 只依赖 content，光标点击移动不重算 mention 解析
  const [cursorPos, setCursorPos] = useState(0);
  const [mentionIdx, setMentionIdx] = useState(0);
  // #270：Esc dismiss 状态——记录被 Esc 关掉的 mention 起点；继续输入（onChange）时复位。
  // 无此状态时弹框由残留 @query 推导永远关不掉，与「Esc 取消」提示矛盾。
  const [mentionDismissedAt, setMentionDismissedAt] = useState<number | null>(null);
  // #638：`#` PMO 补全弹框——键盘选中序号 / Esc dismiss 状态，语义与 @ 弹框（#270）对齐
  const [pmoIdx, setPmoIdx] = useState(0);
  const [pmoDismissedAt, setPmoDismissedAt] = useState<number | null>(null);
  // #638：PMO 补全候选（缺键 = 未拉到/失败 → fail-closed 不出弹框）+ 当前 PMO（「当前」标记数据源）
  const pmoCandidates = useChannelDataStore((s) => (channelId ? s.pmoCandidates[channelId] : undefined));
  const currentPmo = useChannelDataStore((s) => (channelId ? s.currentPmo[channelId] : undefined));
  // #281：频道文件词表（候选集 = 频道相关工程，#403 起读 channelDataStore）+ 已选文件引用台账
  const vocabRepos = useChannelDataStore((s) => (channelId ? s.vocabulary[channelId]?.repos : undefined));
  const [fileRefs, setFileRefs] = useState<FileRef[]>([]);
  // #632：发送前归属预览——mergePreview = 后端三态预测；mergeChoice = 用户显式选择（auto = 不发 intent）
  const [mergePreview, setMergePreview] = useState<MergeTargetPreview | null>(null);
  const [mergeChoice, setMergeChoice] = useState<'auto' | SendIntent>('auto');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeMentionItemRef = useRef<HTMLButtonElement>(null);
  const activePmoItemRef = useRef<HTMLButtonElement>(null);
  // #270：IME 合成守卫（isComposing / keyCode 229 / compositionend 后 10ms 兜底）
  const { handleCompositionEnd, isImeEvent } = useImeEnterGuard();

  // #403：agent 列表读 rosterStore 客户端切片（listAllAgents 全量正本；ADR 决策 2，不再打
  // /agent-profiles?channelId）。成员面（channel.members）读 channelDataStore：
  // 缺键（未拉到，含失败）→ 不献候选（对齐旧 listAgents 失败路径）；空 = 所有 Agent 可见。
  const profiles = useRosterStore((s) => s.profiles);
  const memberIds = useChannelDataStore((s) => (channelId ? s.members[channelId] : undefined));

  useEffect(() => {
    void useRosterStore.getState().ensureFresh();
  }, []);

  // #440：prefill 通道——nonce 变化才把 text 写入（同 nonce 重渲染不覆盖用户编辑）；
  // 写入后聚焦并把光标置尾，沿用 mention 插入的 setTimeout 聚焦模式
  const lastPrefillNonceRef = useRef(0);
  useEffect(() => {
    if (!prefill || prefill.nonce === lastPrefillNonceRef.current) return;
    lastPrefillNonceRef.current = prefill.nonce;
    setContent(prefill.text);
    setCursorPos(prefill.text.length);
    setMentionDismissedAt(null);
    setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.setSelectionRange(prefill.text.length, prefill.text.length);
        el.focus();
      }
    }, 0);
  }, [prefill]);

  useEffect(() => {
    if (!channelId) return;
    const store = useChannelDataStore.getState();
    void store.ensureVocabulary(channelId);
    void store.ensureMembers(channelId);
  }, [channelId]);

  // #632：归属预览触发条件——内容非空 + 无 replyTo + 无 @mention（后端 detectMention 同正则）+ 非发送中
  const mergePreviewEligible =
    !!channelId && content.trim().length > 0 && !replyTo && !MERGE_MENTION_RE.test(content) && !sending;

  // 频道切换：预览与选择一并重置
  useEffect(() => {
    setMergePreview(null);
    setMergeChoice('auto');
  }, [channelId]);

  // 400ms 防抖拉 merge-target；内容变化重新判定，不满足条件即撤条。失败静默降级（不显示预览条）
  useEffect(() => {
    if (!mergePreviewEligible || !channelId) {
      setMergePreview(null);
      return;
    }
    const timer = setTimeout(() => {
      channelApi.getMergeTarget(channelId)
        .then(res => setMergePreview(res.data.data))
        .catch(() => setMergePreview(null));
    }, MERGE_PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [mergePreviewEligible, channelId, content]);

  const agents = useMemo(() => {
    const active = activeAgentsOf(profiles);
    // 无频道上下文 → 全部 active（旧 AC-B4 回退）；成员面未拉到（含拉取失败）→ 暂无候选；
    // 空 = 所有 Agent 可见 → 全部 active（对齐服务端空 members 回退）
    if (!channelId) return active;
    if (!memberIds) return [] as AgentProfile[];
    return memberIds.length === 0 ? active : active.filter((a) => memberIds.includes(a.id));
  }, [channelId, profiles, memberIds]);

  // Parse if we're in a mention: last @word before cursor
  const mentionState = useMemo(() => {
    const pos = Math.min(cursorPos, content.length);
    const before = content.slice(0, pos);
    const lastAt = before.lastIndexOf('@');
    if (lastAt === -1) return null;
    const query = before.slice(lastAt + 1);
    // Only show if there's no space after @ and before cursor
    if (query.includes(' ') || query.includes('\n')) return null;
    return { start: lastAt, query };
  }, [content, cursorPos]);

  // #638：`#` PMO 补全触发解析——与 mentionState 同规则（光标前最后一个 #，query 含空格/换行不收）
  const pmoTriggerState = useMemo(() => {
    const pos = Math.min(cursorPos, content.length);
    const before = content.slice(0, pos);
    const lastHash = before.lastIndexOf('#');
    if (lastHash === -1) return null;
    const query = before.slice(lastHash + 1);
    if (query.includes(' ') || query.includes('\n')) return null;
    return { start: lastHash, query };
  }, [content, cursorPos]);

  // #638：@ 与 # 同时命中时互斥——起始位置靠后（更贴近光标 = 最近意图）者生效
  const mentionActive = !!mentionState && (!pmoTriggerState || mentionState.start >= pmoTriggerState.start);
  const pmoActive = !!pmoTriggerState && (!mentionState || pmoTriggerState.start > mentionState.start);

  // #638：`#` 弹框激活时懒加载候选（TTL/single-flight 走 store 纪律）；当前 PMO 供「当前」标记
  useEffect(() => {
    if (!channelId || !pmoActive) return;
    const store = useChannelDataStore.getState();
    void store.ensurePmoCandidates(channelId);
    void store.ensureCurrentPmo(channelId);
  }, [channelId, pmoActive]);

  // #638：候选过滤——query 小写 includes 匹配 pmoNumber 或 title；
  // 缺键（未拉到/失败）或空数组 → 无候选（fail-closed 不出弹框）
  const filteredPmo = useMemo(() => {
    if (!pmoActive || !pmoTriggerState || !pmoCandidates || pmoCandidates.length === 0) return [];
    const q = pmoTriggerState.query.toLowerCase();
    return pmoCandidates.filter(c =>
      c.pmoNumber.toLowerCase().includes(q) || c.title.toLowerCase().includes(q));
  }, [pmoActive, pmoTriggerState, pmoCandidates]);
  // #638：弹框可见性 = 有候选 且 未被 Esc dismiss（同 #270 @ 弹框口径）
  const pmoPopupOpen = filteredPmo.length > 0 && pmoDismissedAt !== pmoTriggerState?.start;
  const activePmoIdx = filteredPmo.length > 0 ? pmoIdx % filteredPmo.length : 0;

  const filteredAgents = useMemo(() => {
    if (!mentionState) return [];
    const q = mentionState.query.toLowerCase();
    return agents.filter(a => a.name.toLowerCase().includes(q));
  }, [mentionState, agents]);

  // #281: 文件候选 = 词表路径后缀精确匹配（#248 D9），空 query 不献候选（防全量刷屏）；
  // 词表缺键（未拉到/失败）→ 无文件候选（静默降级，不影响 agent 组）
  const filteredFiles = useMemo(() => {
    if (!mentionState || !mentionState.query) return [];
    const q = mentionState.query.toLowerCase();
    const out: FileRef[] = [];
    for (const r of vocabRepos ?? []) {
      for (const p of r.files) {
        if (p.toLowerCase().endsWith(q)) out.push({ repo: r.repo, path: p });
        if (out.length >= FILE_CANDIDATE_CAP) return out;
      }
    }
    return out;
  }, [mentionState, vocabRepos]);
  // #270：弹框可见性 = 有候选 且 未被 Esc dismiss（不再由残留 @query 单独推导）
  const popupOpen = mentionActive && (filteredAgents.length > 0 || filteredFiles.length > 0)
    && mentionDismissedAt !== mentionState?.start;
  const totalCandidates = filteredAgents.length + filteredFiles.length;
  // 跨组统一序号（agents 在前 files 在后）；query 变化致候选收缩时钳位选中项
  const activeIdx = totalCandidates > 0 ? mentionIdx % totalCandidates : 0;

  // #270：弹框轻量重绘——选中项滚动进可视区（jsdom 无 scrollIntoView，?. 兜底）
  useEffect(() => {
    if (popupOpen) activeMentionItemRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIdx, popupOpen]);

  // #638：PMO 弹框同款——选中项滚动进可视区
  useEffect(() => {
    if (pmoPopupOpen) activePmoItemRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activePmoIdx, pmoPopupOpen]);

  const insertMention = useCallback((agentName: string) => {
    if (!mentionState) return;
    const pos = Math.min(cursorPos, content.length);
    const before = content.slice(0, mentionState.start);
    const after = content.slice(pos);
    const newContent = `${before}@${agentName} ${after}`;
    const newCursor = mentionState.start + agentName.length + 2; // @name[space]
    setContent(newContent);
    setCursorPos(newCursor);
    setMentionIdx(0);
    // Set cursor after the inserted mention
    setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.setSelectionRange(newCursor, newCursor);
        el.focus();
      }
    }, 0);
  }, [content, cursorPos, mentionState]);

  // #638：PMO 候选插入 = `#PMO-n ` 纯文本 token（带尾随空格），与后端 req-binding
  // PMO_TOKEN_RE（/#(PMO?-\d+)/i）同形——发送时经既有 token 解析归属，无需结构化载体
  const insertPmoToken = useCallback((candidate: ChannelPmoCandidate) => {
    if (!pmoTriggerState) return;
    const pos = Math.min(cursorPos, content.length);
    const before = content.slice(0, pmoTriggerState.start);
    const after = content.slice(pos);
    const newContent = `${before}#${candidate.pmoNumber} ${after}`;
    const newCursor = pmoTriggerState.start + candidate.pmoNumber.length + 2; // #PMO-n[space]
    setContent(newContent);
    setCursorPos(newCursor);
    setPmoIdx(0);
    setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.setSelectionRange(newCursor, newCursor);
        el.focus();
      }
    }, 0);
  }, [content, cursorPos, pmoTriggerState]);

  // #281: 文件引用插入 = 纯路径文本（不带 @——mention 正则会误吃文件名触发派发）；
  // 结构化载体在 fileRefs 台账，发送时随消息上送
  const insertFileRef = useCallback((ref: FileRef) => {
    if (!mentionState) return;
    const pos = Math.min(cursorPos, content.length);
    const before = content.slice(0, mentionState.start);
    const after = content.slice(pos);
    const newContent = `${before}${ref.path} ${after}`;
    const newCursor = mentionState.start + ref.path.length + 1; // path[space]
    setContent(newContent);
    setCursorPos(newCursor);
    setMentionIdx(0);
    setFileRefs(prev =>
      prev.some(f => f.repo === ref.repo && f.path === ref.path) ? prev : [...prev, ref]);
    setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.setSelectionRange(newCursor, newCursor);
        el.focus();
      }
    }, 0);
  }, [content, cursorPos, mentionState]);

  // 2026-09 截图粘贴：图片上传（JSON base64）→ 成功后光标处插入 markdown 图片语法。
  // 失败 toast 不动草稿（草稿从未被触碰，比发送失败回灌更简单）；上传中占位态 = uploadingCount。
  const [uploadingCount, setUploadingCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const insertSnippet = useCallback((snippet: string) => {
    const pos = Math.min(cursorPos, content.length);
    const newContent = `${content.slice(0, pos)}${snippet}${content.slice(pos)}`;
    const newCursor = pos + snippet.length;
    setContent(newContent);
    setCursorPos(newCursor);
    setMentionIdx(0);
    setMentionDismissedAt(null);
    setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.setSelectionRange(newCursor, newCursor);
        el.focus();
      }
    }, 0);
  }, [content, cursorPos]);

  const uploadImage = useCallback(async (file: File) => {
    if (!channelId) {
      toast.error('缺少频道上下文，无法上传图片');
      return;
    }
    if (!IMAGE_MIME_WHITELIST.includes(file.type)) {
      toast.error('不支持的图片类型（仅 png/jpg/jpeg/gif/webp）');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error('图片超过 5MB 上限');
      return;
    }
    setUploadingCount(n => n + 1);
    try {
      const dataBase64 = await fileToBase64(file);
      const res = await channelApi.uploadAttachment(channelId, { mime: file.type, dataBase64 });
      // alt 文本消毒：]/(/)/换行会破坏 markdown 图片语法
      const alt = (file.name || 'image').replace(/[[\]()\n]/g, '');
      insertSnippet(`![${alt}](${res.data.data.url})`);
    } catch {
      toast.error('图片上传失败，请重试');
    } finally {
      setUploadingCount(n => n - 1);
    }
  }, [channelId, insertSnippet]);

  // 剪贴板有图 → 拦默认行为走上传；无图 → 文本粘贴走默认
  const handlePaste = (e: React.ClipboardEvent) => {
    const img = Array.from(e.clipboardData?.files ?? []).find(f => f.type.startsWith('image/'));
    if (!img) return;
    e.preventDefault();
    void uploadImage(img);
  };

  // #485：chip 单独移除引用（不动正文路径文本——移除台账后发送过滤自然不携带）
  const removeFileRef = useCallback((ref: FileRef) => {
    setFileRefs(prev => prev.filter(f => !(f.repo === ref.repo && f.path === ref.path)));
  }, []);

  // 批次A 项1：await 真实发送结果——失败回灌文本/文件引用 + toast 提示
  // （参照 ChannelMessageItem 内嵌回复「失败保留 draft」模式；#486 起发送中 textarea 不再禁用，
  // 乐观回显由 useChannelMessages 承担，本组件只保留 sending 防重复提交守卫）
  const handleSend = async () => {
    const trimmed = content.trim();
    if (!trimmed || sending) return;
    // #520 测量②：发送点击瞬间埋点（点事件，不等 REST 结果）
    emitSendClick({ channelId, replyToId: replyTo?.id ?? null });
    // #281: 只上送正文仍含其路径的引用（发送前删掉路径文本 = 撤销引用）
    const refs = fileRefs.filter(f => trimmed.includes(f.path));
    // #632：仅在归属预览适用（无 replyTo / 无 @mention）且用户显式选择时携带 intent；
    // 未选时保旧调用形态（不传第四参，对齐 #281 files 的「无引用不传第三参」口径）
    const intent = mergePreviewEligible && mergeChoice !== 'auto' ? mergeChoice : undefined;
    // 乐观清空（原语义），失败回灌
    setContent('');
    setCursorPos(0);
    setFileRefs([]);
    try {
      if (refs.length > 0) {
        if (intent) await onSend(trimmed, replyTo?.id, refs, intent);
        else await onSend(trimmed, replyTo?.id, refs);
      } else {
        if (intent) await onSend(trimmed, replyTo?.id, undefined, intent);
        else await onSend(trimmed, replyTo?.id);
      }
      // 发送成功：归属选择复位 auto（预览条随内容清空自然消失）
      setMergeChoice('auto');
    } catch {
      setContent(trimmed);
      setCursorPos(trimmed.length);
      setFileRefs(refs);
      toast.error('发送失败，内容已保留');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // #270：IME 选词中的 Enter 交给输入法，不选中候选、不发送（不 preventDefault）
    if (e.key === 'Enter' && isImeEvent(e)) return;
    // #270：Enter 长按（e.repeat）不连发、不连选；拦默认行为避免换行刷屏
    if (e.key === 'Enter' && e.repeat) {
      e.preventDefault();
      return;
    }
    // Mention popup keyboard navigation
    if (popupOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIdx(prev => (prev + 1) % totalCandidates);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIdx(prev => (prev - 1 + totalCandidates) % totalCandidates);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        // 跨组统一序号：落在 file 组则插入文件引用，否则 agent mention
        if (activeIdx >= filteredAgents.length) {
          insertFileRef(filteredFiles[activeIdx - filteredAgents.length]);
        } else {
          insertMention(filteredAgents[activeIdx].name);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // #270：真正关闭弹框（dismiss 状态），与「Esc 取消」提示一致
        setMentionDismissedAt(mentionState?.start ?? null);
        setMentionIdx(0);
        return;
      }
    }
    // #638：PMO 补全弹框键盘导航——与 @ 弹框同语义（循环 / Enter·Tab 选中 / Esc dismiss）；
    // 顶部 IME 与 e.repeat 守卫对两弹框同效
    if (pmoPopupOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPmoIdx(prev => (prev + 1) % filteredPmo.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPmoIdx(prev => (prev - 1 + filteredPmo.length) % filteredPmo.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertPmoToken(filteredPmo[activePmoIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setPmoDismissedAt(pmoTriggerState?.start ?? null);
        setPmoIdx(0);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !popupOpen && !pmoPopupOpen) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="mc-inputbar">
      <div className="mc-inputbar-inner">
        {/* Reply preview
            channel 上下游优化 Phase 1（AC4）：提供 onReplyPreviewClick 时预览正文区 button 化——
            点击定位被回复消息；✕ 取消钮保持兄弟节点（按钮不嵌套按钮） */}
        {replyTo && onCancelReply && (
          <div className="mc-input-reply">
            {onReplyPreviewClick ? (
              <button type="button" className="mc-input-reply-jump" onClick={() => onReplyPreviewClick(replyTo.id)}>
                <span>↩</span>
                <span>
                  回复 {replyTo.authorType === 'human' ? '你' : replyTo.agentName || 'Agent'}:
                </span>
                <span className="mc-input-reply-content">{replyTo.content}</span>
              </button>
            ) : (
              <>
                <span>↩</span>
                <span>
                  回复 {replyTo.authorType === 'human' ? '你' : replyTo.agentName || 'Agent'}:
                </span>
                <span className="mc-input-reply-content">{replyTo.content}</span>
              </>
            )}
            <button onClick={onCancelReply} className="mc-icon-btn" aria-label="取消回复">
              <IconX />
            </button>
          </div>
        )}

        {/* #632：发送前归属预览条（复用 reply 预览条容器/边框/淡色视觉）。
            三态：unique 显示并入目标 + 可切「新任务」/「纯消息」；ambiguous 淡提示多件在途（不显目标）；
            none 默认纯消息 + 可选「新任务」。chip 点击选中、再点回 auto（不发 intent） */}
        {mergePreview && mergePreviewEligible && (
          <div className="mc-input-reply mc-input-merge">
            {mergePreview.status === 'unique' && (
              <>
                <span>⇄</span>
                <span>将并入：</span>
                <span className="mc-input-reply-content">{mergePreview.workUnit?.title}</span>
              </>
            )}
            {mergePreview.status === 'ambiguous' && (
              <span className="mc-input-merge-hint">频道有多件事同时进行，请回复对应消息或 @角色</span>
            )}
            {mergePreview.status === 'none' && (
              <span className={mergeChoice === 'auto' ? 'mc-input-merge-default' : 'mc-input-merge-hint'}>纯消息</span>
            )}
            {(mergePreview.status === 'unique' || mergePreview.status === 'ambiguous' || mergePreview.status === 'none') && (
              <>
                <button
                  type="button"
                  className={mergeChoice === 'new-task' ? 'mc-input-merge-chip mc-input-merge-chip-active' : 'mc-input-merge-chip'}
                  aria-pressed={mergeChoice === 'new-task'}
                  onClick={() => setMergeChoice(c => (c === 'new-task' ? 'auto' : 'new-task'))}
                >
                  新任务
                </button>
                {mergePreview.status !== 'none' && (
                  <button
                    type="button"
                    className={mergeChoice === 'plain' ? 'mc-input-merge-chip mc-input-merge-chip-active' : 'mc-input-merge-chip'}
                    aria-pressed={mergeChoice === 'plain'}
                    onClick={() => setMergeChoice(c => (c === 'plain' ? 'auto' : 'plain'))}
                  >
                    纯消息
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* #485：已挂文件引用 chip——台账可视化；正文被编辑得不再含路径时标灰「已失效」（不再静默丢弃） */}
        {fileRefs.length > 0 && (
          <div className="mc-fileref-chips" aria-label="已引用的文件">
            {fileRefs.map(ref => {
              const invalid = !content.includes(ref.path);
              return (
                <span
                  key={`${ref.repo}:${ref.path}`}
                  className={invalid ? 'mc-fileref-chip mc-fileref-chip-invalid' : 'mc-fileref-chip'}
                  title={invalid ? '正文已不含该路径，发送时不会携带此引用' : `${ref.repo}/${ref.path}`}
                >
                  <span className="mc-fileref-path">{ref.path}</span>
                  <span className="mc-fileref-repo">{repoBasename(ref.repo)}</span>
                  {invalid && <span className="mc-fileref-invalid-mark">已失效</span>}
                  <button
                    type="button"
                    className="mc-icon-btn"
                    aria-label={`移除引用 ${ref.path}`}
                    onClick={() => removeFileRef(ref)}
                  >
                    <IconX />
                  </button>
                </span>
              );
            })}
          </div>
        )}

        <div className="mc-input-row">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={e => {
              setContent(e.target.value);
              setCursorPos(e.target.selectionStart ?? e.target.value.length);
              // #270：继续输入表达新意图，复位 Esc dismiss
              setMentionDismissedAt(null);
              // #638：PMO 弹框同款复位
              setPmoDismissedAt(null);
            }}
            onSelect={e => setCursorPos(e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onCompositionEnd={handleCompositionEnd}
            placeholder="输入消息，@角色 派单，# 关联 PMO 项目..."
            rows={2}
          />
          {/* 2026-09 截图粘贴：图片选择按钮（等价于粘贴路径，共用 uploadImage） */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            style={{ display: 'none' }}
            aria-hidden="true"
            onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = ''; // 复位——同文件重选也触发 change
              if (file) void uploadImage(file);
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            className="mc-icon-btn"
            title="上传图片"
            aria-label="上传图片"
          >
            <IconImage />
          </button>
          <button
            onClick={() => void handleSend()}
            disabled={sending || !content.trim()}
            className="mc-btn mc-btn-primary"
          >
            {sending ? '...' : '发送'}
          </button>
        </div>

        <div className="mc-input-hint">
          <span>{popupOpen || pmoPopupOpen ? '↑↓ 选择 Enter 确认 Esc 取消' : '@mention Agent · 回复引用 · Enter 发送'}</span>
          {/* 2026-09 截图粘贴：上传中占位态（计数支持并发多图） */}
          {uploadingCount > 0 && <span>上传图片中…</span>}
          {/* ⑦ 无输入时不渲染计数器（「0 字」零信号） */}
          {content.length > 0 && <span>{content.length} 字</span>}
        </div>
      </div>

      {/* @mention popup —— #281: 统一分组（上 Agents 下 Files），跨组统一键盘序号 */}
      {popupOpen && (
        <div className="mc-mention-popup" role="listbox" aria-label="提及 Agent / 文件候选">
          {filteredAgents.length > 0 && <div className="mc-mention-group">Agents</div>}
          {filteredAgents.map((agent, i) => (
            <button
              key={agent.id}
              ref={i === activeIdx ? activeMentionItemRef : null}
              role="option"
              aria-selected={i === activeIdx}
              className={i === activeIdx ? 'mc-mention-item mc-mention-item-active' : 'mc-mention-item'}
              onMouseDown={e => { e.preventDefault(); insertMention(agent.name); }}
            >
              <span>@{agent.name}</span>
              {agent.description && (
                <span className="mc-mention-desc">{agent.description}</span>
              )}
            </button>
          ))}
          {filteredFiles.length > 0 && <div className="mc-mention-group">Files</div>}
          {filteredFiles.map((file, j) => {
            const i = filteredAgents.length + j;
            return (
              <button
                key={`${file.repo}:${file.path}`}
                ref={i === activeIdx ? activeMentionItemRef : null}
                role="option"
                aria-selected={i === activeIdx}
                className={i === activeIdx ? 'mc-mention-item mc-mention-item-active' : 'mc-mention-item'}
                onMouseDown={e => { e.preventDefault(); insertFileRef(file); }}
              >
                <span>{file.path}</span>
                <span className="mc-mention-repo">{repoBasename(file.repo)}</span>
              </button>
            );
          })}
        </div>
      )}
      {/* #638：`#` PMO 补全弹框——复用 @ 弹框样式类与 ARIA（listbox/option），mc-pmo-popup 可区分 */}
      {pmoPopupOpen && (
        <div className="mc-mention-popup mc-pmo-popup" role="listbox" aria-label="PMO 项目候选">
          <div className="mc-mention-group">PMO 项目</div>
          {filteredPmo.map((candidate, i) => (
            <button
              key={candidate.id}
              ref={i === activePmoIdx ? activePmoItemRef : null}
              role="option"
              aria-selected={i === activePmoIdx}
              className={i === activePmoIdx ? 'mc-mention-item mc-mention-item-active' : 'mc-mention-item'}
              onMouseDown={e => { e.preventDefault(); insertPmoToken(candidate); }}
            >
              <span>#{candidate.pmoNumber} · {candidate.title}</span>
              {currentPmo?.id === candidate.id && (
                <span className="mc-mention-desc">当前</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
