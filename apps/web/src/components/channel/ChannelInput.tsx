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
// #691（架构精简 P2-2）：@/# 两套同构补全状态机合一 = hooks/useAutocompletePopup +
// AutocompletePopup 展示件（候选分组构建 = channelAutocompleteGroups）；截图粘贴上传 =
// hooks/useImageUpload；#632 归属预览 = hooks/useMergePreview + MergePreviewBar；
// #485 引用 chip = FileRefChips。行为不变。
import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import type { AgentProfile, ChannelMessage, ChannelPmoCandidate, FileRef, SendIntent } from '../../api/channel';
import { useImeEnterGuard } from '../../hooks/useImeEnterGuard';
import { parseTriggerAt, useAutocompletePopup } from '../../hooks/useAutocompletePopup';
import { useImageUpload } from '../../hooks/useImageUpload';
import { useMergePreview } from '../../hooks/useMergePreview';
import { useRosterStore, activeAgentsOf } from '../../stores/rosterStore';
import { useChannelDataStore } from '../../stores/channelDataStore';
import { toast } from '../../utils/toast';
import { emitSendClick } from '../../utils/clientPerf';
import { IconImage, IconX } from '../ui/icons';
import { AutocompletePopup } from './AutocompletePopup';
import { buildMentionGroups, buildPmoGroups } from './channelAutocompleteGroups';
import type { MentionData } from './channelAutocompleteGroups';
import { FileRefChips } from './FileRefChips';
import { MergePreviewBar } from './MergePreviewBar';

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

export function ChannelInput({ onSend, sending, replyTo, onCancelReply, channelId, prefill, onReplyPreviewClick }: Props) {
  const [content, setContent] = useState('');
  // 光标位置由 onChange/onSelect 事件写入 state（渲染期禁读 ref）。
  const [cursorPos, setCursorPos] = useState(0);
  // #281：已选文件引用台账（chip 可视化在 FileRefChips）
  const [fileRefs, setFileRefs] = useState<FileRef[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // #270：IME 合成守卫（isComposing / keyCode 229 / compositionend 后 10ms 兜底）
  const { handleCompositionEnd, isImeEvent } = useImeEnterGuard();

  // #638：PMO 补全候选（缺键 = 未拉到/失败 → fail-closed 不出弹框）+ 当前 PMO（「当前」标记数据源）
  const pmoCandidates = useChannelDataStore((s) => (channelId ? s.pmoCandidates[channelId] : undefined));
  const currentPmo = useChannelDataStore((s) => (channelId ? s.currentPmo[channelId] : undefined));
  // #281：频道文件词表（候选集 = 频道相关工程，#403 起读 channelDataStore）
  const vocabRepos = useChannelDataStore((s) => (channelId ? s.vocabulary[channelId]?.repos : undefined));

  // #403：agent 列表读 rosterStore 客户端切片（listAllAgents 全量正本；ADR 决策 2，不再打
  // /agent-profiles?channelId）。成员面（channel.members）读 channelDataStore：
  // 缺键（未拉到，含失败）或空数组 → 不献候选；空频道不回退全部 active（#699）。
  const profiles = useRosterStore((s) => s.profiles);
  const memberIds = useChannelDataStore((s) => (channelId ? s.members[channelId] : undefined));

  useEffect(() => {
    void useRosterStore.getState().ensureFresh();
  }, []);

  useEffect(() => {
    if (!channelId) return;
    const store = useChannelDataStore.getState();
    void store.ensureVocabulary(channelId);
    void store.ensureMembers(channelId);
  }, [channelId]);

  /** 弹框选中/外部填入的统一写入口：内容 + 光标位（DOM 定位由弹框 hook/调用方承担） */
  const applyEdit = useCallback((nextContent: string, nextCursor: number) => {
    setContent(nextContent);
    setCursorPos(nextCursor);
  }, []);

  const agents = useMemo(() => {
    const active = activeAgentsOf(profiles);
    // 无频道上下文 → 全部 active（旧 AC-B4 回退）；频道内只展示显式成员。
    if (!channelId) return active;
    if (!memberIds) return [] as AgentProfile[];
    return active.filter((a) => memberIds.includes(a.id));
  }, [channelId, profiles, memberIds]);

  // #638：@ 与 # 同时命中时互斥——起始位置靠后（更贴近光标 = 最近意图）者生效
  const mentionTrigger = parseTriggerAt(content, cursorPos, '@');
  const pmoTrigger = parseTriggerAt(content, cursorPos, '#');
  const mentionActive = !!mentionTrigger && (!pmoTrigger || mentionTrigger.start >= pmoTrigger.start);
  const pmoActive = !!pmoTrigger && (!mentionTrigger || pmoTrigger.start > mentionTrigger.start);

  // #638：`#` 弹框激活时懒加载候选（TTL/single-flight 走 store 纪律）；当前 PMO 供「当前」标记
  useEffect(() => {
    if (!channelId || !pmoActive) return;
    const store = useChannelDataStore.getState();
    void store.ensurePmoCandidates(channelId);
    void store.ensureCurrentPmo(channelId);
  }, [channelId, pmoActive]);

  // @/# 弹框候选分组构建（过滤口径与渲染行在 channelAutocompleteGroups 单点化）；
  // 文件选中登记 fileRefs 台账（去重在此）；PMO 缺键/空 → fail-closed 无候选
  const addFileRef = useCallback((ref: FileRef) => {
    setFileRefs(prev =>
      prev.some(f => f.repo === ref.repo && f.path === ref.path) ? prev : [...prev, ref]);
  }, []);
  const getMentionGroups = useCallback(
    (query: string) => buildMentionGroups({ query, agents, vocabRepos, onFileRef: addFileRef }),
    [agents, vocabRepos, addFileRef],
  );
  const getPmoGroups = useCallback(
    (query: string) => buildPmoGroups({ query, pmoCandidates, currentPmo }),
    [pmoCandidates, currentPmo],
  );

  const mention = useAutocompletePopup<MentionData>({
    triggerState: mentionTrigger,
    active: mentionActive,
    getGroups: getMentionGroups,
    content,
    cursorPos,
    applyEdit,
    textareaRef,
  });
  const pmo = useAutocompletePopup<ChannelPmoCandidate>({
    triggerState: pmoTrigger,
    active: pmoActive,
    getGroups: getPmoGroups,
    content,
    cursorPos,
    applyEdit,
    textareaRef,
  });

  // resetDismiss/resetSelection 为 hook 内稳定引用（useCallback []），解构供 effect 依赖
  const { resetDismiss: resetMentionDismiss, resetSelection: resetMentionSelection } = mention;

  // #440：prefill 通道——nonce 变化才把 text 写入（同 nonce 重渲染不覆盖用户编辑）；
  // 写入后聚焦并把光标置尾，沿用弹框插入的 setTimeout 聚焦模式
  const lastPrefillNonceRef = useRef(0);
  useEffect(() => {
    if (!prefill || prefill.nonce === lastPrefillNonceRef.current) return;
    lastPrefillNonceRef.current = prefill.nonce;
    applyEdit(prefill.text, prefill.text.length);
    resetMentionDismiss();
    setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.setSelectionRange(prefill.text.length, prefill.text.length);
        el.focus();
      }
    }, 0);
  }, [prefill, applyEdit, resetMentionDismiss]);

  // 2026-09 截图粘贴：光标处插入文本片段（上传成功后的 markdown 图片语法走此口）
  const insertSnippet = useCallback((snippet: string) => {
    const pos = Math.min(cursorPos, content.length);
    const newCursor = pos + snippet.length;
    applyEdit(`${content.slice(0, pos)}${snippet}${content.slice(pos)}`, newCursor);
    resetMentionSelection();
    setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.setSelectionRange(newCursor, newCursor);
        el.focus();
      }
    }, 0);
  }, [content, cursorPos, applyEdit, resetMentionSelection]);

  const { uploadingCount, fileInputRef, uploadImage, handlePaste } = useImageUpload({ channelId, insertSnippet });

  // #632：发送前归属预览（状态机收编进 hook；eligible 供 handleSend intent 口径判定）
  const { mergePreview, mergeChoice, setMergeChoice, mergePreviewEligible } =
    useMergePreview({ channelId, content, replyTo, sending });

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
    // @/# 补全弹框键盘导航（↑↓ 循环 / Enter·Tab 选中 / Esc dismiss，任一弹框消费即止）；
    // 顶部 IME 与 e.repeat 守卫对两弹框同效
    if (mention.handleKeyDown(e)) return;
    if (pmo.handleKeyDown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !mention.open && !pmo.open) {
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

        {/* #632：发送前归属预览条（状态机 useMergePreview / 展示 MergePreviewBar） */}
        <MergePreviewBar
          preview={mergePreview}
          eligible={mergePreviewEligible}
          choice={mergeChoice}
          onChoiceChange={setMergeChoice}
        />

        {/* #485：已挂文件引用 chip——台账可视化；正文被编辑得不再含路径时标灰「已失效」 */}
        <FileRefChips refs={fileRefs} content={content} onRemove={removeFileRef} />

        <div className="mc-input-row">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={e => {
              setContent(e.target.value);
              setCursorPos(e.target.selectionStart ?? e.target.value.length);
              // #270：继续输入表达新意图，复位 Esc dismiss（@/# 两弹框同款）
              mention.resetDismiss();
              pmo.resetDismiss();
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
          <span>{mention.open || pmo.open ? '↑↓ 选择 Enter 确认 Esc 取消' : '@mention Agent · 回复引用 · Enter 发送'}</span>
          {/* 2026-09 截图粘贴：上传中占位态（计数支持并发多图） */}
          {uploadingCount > 0 && <span>上传图片中…</span>}
          {/* ⑦ 无输入时不渲染计数器（「0 字」零信号） */}
          {content.length > 0 && <span>{content.length} 字</span>}
        </div>
      </div>

      {/* @mention popup —— #281: 统一分组（上 Agents 下 Files），跨组统一键盘序号 */}
      {mention.open && (
        <AutocompletePopup
          ariaLabel="提及 Agent / 文件候选"
          groups={mention.groups}
          activeIdx={mention.activeIdx}
          activeItemRef={mention.activeItemRef}
          onPick={mention.pick}
        />
      )}
      {/* #638：`#` PMO 补全弹框——复用 @ 弹框样式类与 ARIA（listbox/option），mc-pmo-popup 可区分 */}
      {pmo.open && (
        <AutocompletePopup
          ariaLabel="PMO 项目候选"
          className="mc-pmo-popup"
          groups={pmo.groups}
          activeIdx={pmo.activeIdx}
          activeItemRef={pmo.activeItemRef}
          onPick={pmo.pick}
        />
      )}
    </div>
  );
}
