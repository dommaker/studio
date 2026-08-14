/**
 * role-memory.routes (#101) — 角色记忆人审闸口的 approve/reject 端点。
 *
 * memory_proposal 卡片在频道点击「确认写入 / 丢弃」→ 前端调本端点：
 *   POST /promote { roleId, entryIds[] } → roleMemoryStore.promote（草稿 → topic/索引）
 *   POST /demote  { roleId, entryIds[] } → roleMemoryStore.demote（草稿 → rejected 墓碑）
 * 与 KnowledgeStore 的 /knowledge-service/promote|demote 平行，但对象不同（角色记忆草稿 vs 知识条目）。
 */
import { Router } from 'express';
import { roleMemoryStore } from './role-memory.js';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';

const router = Router();

/** 解析 { roleId, entryIds[] }；非法返回 error。 */
function parseEntryIds(body: unknown): { roleId: string; entryIds: string[] } | { error: string } {
  const b = (body ?? {}) as { roleId?: unknown; entryIds?: unknown };
  if (typeof b.roleId !== 'string' || !b.roleId.trim()) return { error: 'roleId required' };
  if (!Array.isArray(b.entryIds) || b.entryIds.length === 0 || !b.entryIds.every(id => typeof id === 'string' && id.length > 0)) {
    return { error: 'entryIds must be a non-empty array of strings' };
  }
  return { roleId: b.roleId.trim(), entryIds: b.entryIds as string[] };
}

router.post('/promote', requireAuth(), requireNotGuest(), async (req, res) => {
  try {
    const parsed = parseEntryIds(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const result = await roleMemoryStore.promote(parsed.roleId, parsed.entryIds);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post('/demote', requireAuth(), requireNotGuest(), async (req, res) => {
  try {
    const parsed = parseEntryIds(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const result = await roleMemoryStore.demote(parsed.roleId, parsed.entryIds);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
