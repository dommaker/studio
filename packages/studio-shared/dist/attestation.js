/**
 * F6 信任证据模型（2026-07-28 内置角色与流水线信任模型分析，决策 1）
 *
 * 信任不再建模为 WU 状态，而是分层证据（attestations），挂在 WU metadata 上：
 *   l1 = 自动验证（测试/lint/typecheck，agent-loop 验证守卫写入）
 *   l2 = agent 评审（评审子 WU 回传，reviewPassed/reviewRejected 写入）
 *   l3 = 人工确认（human-only 端点写入，验收权只在人）
 *
 * 铁律（写纪律，AGENTS.md 约束层同步）：
 *   所有展示/指标只准通过 deriveDisplayState() 一个函数解释证据，
 *   禁止 UI/API/指标各自读 attestations 字段自行判断——口径分叉 = 可读性崩坏。
 *
 * 双轨期约定（F6-a 只加不改 → F6-b 展示切换 → 验证 2-4 周后才停止手写 in_review）：
 *   - 存储 status 照旧手写（门模型继续跑，reviewPassed 守卫依赖它）；
 *   - 派生列与存储状态并存比对，不一致计入 metrics 的派生偏差桶。
 */
function isRecord(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function parseEntry(v) {
    if (!isRecord(v))
        return undefined;
    if (v.verdict !== 'approved' && v.verdict !== 'rejected')
        return undefined;
    if (typeof v.by !== 'string' || typeof v.at !== 'string')
        return undefined;
    return {
        verdict: v.verdict,
        by: v.by,
        at: v.at,
        kind: typeof v.kind === 'string' ? v.kind : 'unknown',
        ...(typeof v.summary === 'string' ? { summary: v.summary } : {}),
        ...(v.selfReview === true ? { selfReview: true } : {}),
        ...(typeof v.ref === 'string' ? { ref: v.ref } : {}),
    };
}
/**
 * 安全解析 WU metadata 中的 attestations（metadata 可为对象或 JSON 字符串；
 * 损坏/缺字段一律容忍，返回 undefined = 证据模型未介入）。
 */
export function parseAttestations(metadata) {
    let meta = metadata;
    if (typeof meta === 'string') {
        try {
            meta = JSON.parse(meta);
        }
        catch {
            return undefined;
        }
    }
    if (!isRecord(meta))
        return undefined;
    const raw = meta.attestations;
    if (!isRecord(raw))
        return undefined;
    const out = {};
    const l1 = parseEntry(raw.l1);
    const l2 = parseEntry(raw.l2);
    const l3 = parseEntry(raw.l3);
    if (l1)
        out.l1 = l1;
    if (l2)
        out.l2 = l2;
    if (l3)
        out.l3 = l3;
    if (!l1 && !l2 && !l3)
        return undefined;
    return out;
}
/** 追加/覆盖一层证据（返回新对象，不改原值；每层只留最新一条） */
export function withAttestation(existing, level, entry) {
    return { ...(existing ?? {}), [level]: entry };
}
/**
 * 唯一派生口径：WU 存储状态 + 证据台账 → 展示列/证据快照/人类待办。
 *
 * 派生规则（双轨期）：
 *   - 所有权状态（unassigned/active/blocked/closed）原样透传——这些不是信任状态；
 *   - 手写 in_review → in_review（门模型仍在跑，存储值保持权威）；
 *   - done 且无证据（legacy 存量）→ done 原样透传；
 *   - done 且证据已介入 → l3 approved 才出 done 列，否则回 in_review 列（等人工确认）。
 *     l3 是最终闸门：人工直接验收（无 l2）同样出 done 列，l2 缺失不阻断人工。
 */
export function deriveDisplayState(input) {
    const attestations = parseAttestations(input.metadata);
    const l1 = attestations?.l1?.verdict === 'approved';
    const l2 = attestations?.l2?.verdict === 'approved';
    const l3 = attestations?.l3?.verdict === 'approved';
    const selfReview = attestations?.l2?.selfReview === true;
    const evidence = { l1, l2, l3, selfReview };
    let column;
    switch (input.status) {
        case 'unassigned':
        case 'active':
        case 'blocked':
        case 'closed':
            column = input.status;
            break;
        case 'in_review':
            column = 'in_review';
            break;
        case 'done':
            column = !attestations ? 'done' : l3 ? 'done' : 'in_review';
            break;
        default:
            // 未知状态不猜，按 active 兜底展示（不放大异常数据）
            column = 'active';
            break;
    }
    const needsHuman = input.status === 'in_review' ||
        (input.status === 'done' && attestations !== undefined && !l3);
    const workFinished = input.status === 'done' || input.status === 'closed';
    return { column, evidence, needsHuman, workFinished, hasAttestations: attestations !== undefined };
}
//# sourceMappingURL=attestation.js.map